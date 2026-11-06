// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The hub's write gate (docs/hub.md "Write gate"): every globnotes effect on
 * the vault folder goes through `apply`, which announces the paths to the hub,
 * opens the effects pass for the synchronous effect only, and records what
 * actually happened with its origin. The base helpers decide what a writer's
 * base means for the file as it is now: notes (.md) are text and merge; every
 * other file is binary and compares by version.
 */

import * as path from "@std/path";
import type { VaultHub } from "./hub.ts";
import { mergeText, versionOf } from "./merge.ts";
import { type StorageEffect, withGatePass } from "./effects.ts";

/** What a writer read before it wrote. */
export type Base =
  | { kind: "absent" }
  | { kind: "version"; version: string }
  | { kind: "text"; content: string };
/** A stale base that cannot merge: keep the writer's bytes as a conflict copy
 * next to the original, or refuse the write. */
export type OnStale = "copy" | "refuse";
export type BaseOutcome =
  | { status: "current" }
  | { status: "merged"; content: string }
  | { status: "stale"; currentVersion: string | null };

const VERSION = /^[0-9a-f]{64}$/;

/** Validate a base from an untrusted caller; throws TypeError. */
export function parseBase(value: unknown): Base {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("base must be an object");
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if (raw.kind === "absent" && keys === "kind") return { kind: "absent" };
  if (
    raw.kind === "version" && keys === "kind,version" &&
    typeof raw.version === "string" && VERSION.test(raw.version.toLowerCase())
  ) return { kind: "version", version: raw.version.toLowerCase() };
  if (
    raw.kind === "text" && keys === "content,kind" &&
    typeof raw.content === "string"
  ) return { kind: "text", content: raw.content };
  throw new TypeError(
    'base must be {kind:"absent"}, {kind:"version",version:<64 hex>} or {kind:"text",content}',
  );
}
export function parseOnStale(value: unknown): OnStale {
  if (value === undefined) return "copy";
  if (value === "copy" || value === "refuse") return value;
  throw new TypeError('onStale must be "copy" or "refuse"');
}

export const isText = (file: string): boolean =>
  file.toLowerCase().endsWith(".md");

/** Compare a base with the current file. `current` is null when absent; text
 * is the decoded content of a note. `mine` is the writer's new text, needed
 * only to merge a stale text base. */
export function checkBase(
  base: Base,
  current: { version: string; text?: string } | null,
  mine?: string,
): BaseOutcome {
  if (base.kind === "absent") {
    return current
      ? { status: "stale", currentVersion: current.version }
      : { status: "current" };
  }
  if (!current) return { status: "stale", currentVersion: null };
  if (base.kind === "version") {
    return base.version === current.version
      ? { status: "current" }
      : { status: "stale", currentVersion: current.version };
  }
  if (current.text === undefined) {
    // A text base for a binary file compares as bytes.
    return versionOf(new TextEncoder().encode(base.content)) === current.version
      ? { status: "current" }
      : { status: "stale", currentVersion: current.version };
  }
  if (base.content === current.text) return { status: "current" };
  if (mine !== undefined) {
    const merged = mergeText(base.content, mine, current.text);
    if (merged !== null) return { status: "merged", content: merged };
  }
  return { status: "stale", currentVersion: current.version };
}

/** `<stem>.conflict-YYYYMMDD-HHMMSS-<peer><.ext>` next to `file` (UTC), with
 * `-2`, `-3`, ... before the extension while a name is taken. */
export function conflictCopyPath(
  file: string,
  peer: string,
  now: Date,
  occupied: (candidate: string) => boolean,
): string {
  const directory = path.dirname(file), name = path.basename(file);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-")
    .slice(0, 15);
  for (let suffix = 1;; suffix++) {
    const candidate = path.join(
      directory,
      `${stem}.conflict-${stamp}-${peer}${
        suffix > 1 ? `-${suffix}` : ""
      }${ext}`,
    );
    if (!occupied(candidate)) return candidate;
  }
}

/** Every path entry is occupied, including dangling links and directories. */
export function occupied(file: string): boolean {
  try {
    Deno.lstatSync(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** The current version of a file, or null when absent. */
export function currentVersion(file: string): string | null {
  try {
    return versionOf(Deno.readFileSync(file));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export class HubGate {
  constructor(private readonly adapters: { hub?: VaultHub } = {}) {}

  /** Run a synchronous effect for `paths` inside the gate: announce them to
   * the hub (which first reconciles outside changes), open the effects pass,
   * and record the journaled effects with `origin` even when the effect fails
   * part way. Callers run this inside their short commit section, after their
   * base revalidation. */
  apply<T>(
    paths: readonly string[],
    origin: string,
    journal: StorageEffect[],
    effect: () => T,
  ): T {
    const hub = this.adapters.hub;
    const token = hub?.expect(paths);
    try {
      return withGatePass(paths, journal, effect);
    } finally {
      if (token) hub!.record(token, journal, origin);
    }
  }
}
