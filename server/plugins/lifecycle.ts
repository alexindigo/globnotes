// SPDX-License-Identifier: LGPL-3.0-only

/** Access-policy epochs, the short commit gate, mediated file grants and
 * external-observation routing. No storage or endpoint imports — the
 * composition root injects adapters. */

import * as path from "@std/path";
import { AuthType, type GlobalConfig } from "../config.ts";
import type { ActionReceipt, OperationFact } from "./contracts.ts";
import type { PluginManifest } from "./manifest.ts";
import { OperationError } from "./errors.ts";

/** Host-only HTTP authority, captured before body/preparation/queue awaits.
 * Credentials and assertion closures never enter facts or Worker envelopes. */
export interface NoteMutationLease {
  readonly epoch: number;
  assertCurrent(operationId?: string): void;
}

export interface RequesterAuthority {
  readonly pluginId: string;
  readonly generation: string;
  current(): boolean;
  authorize(paths: readonly string[], operationId?: string): void;
  canPrune(path: string): boolean;
  resolve(path: string): string;
}

/** Host-only activation-bound lease; never accepted from plugin action args. */
export function requesterAuthority(
  manifest: PluginManifest,
  vaultPath: string,
  statePath: string,
  generation: string,
  current: () => boolean,
): RequesterAuthority {
  const grants = structuredClone(manifest.capabilities.write);
  const covers = (target: string) => {
    const resolved = resolveGrantedPath(vaultPath, target, grants);
    if (isSubpath(realpathLoose(statePath), resolved)) {
      throw new Error("reserved state");
    }
  };
  return Object.freeze({
    pluginId: manifest.id,
    generation,
    current,
    resolve(target: string) {
      covers(target);
      return resolveGrantedPath(vaultPath, target, grants);
    },
    authorize(paths: readonly string[], operationId?: string) {
      if (!current()) {
        throw new OperationError(
          409,
          "plugin_generation_revoked",
          "Plugin requester revoked before effects; no mutation was started.",
          { operationId },
        );
      }
      try {
        for (const target of paths) covers(target);
      } catch {
        throw new OperationError(
          403,
          "plugin_permission_denied",
          "Mutation effects exceed the plugin's declared write grants.",
          { operationId },
        );
      }
    },
    canPrune(target: string) {
      try {
        covers(target);
        return current();
      } catch {
        return false;
      }
    },
  });
}

/** One disclosure function for receipt queries and both completion routes. */
export function projectActionReceipt(
  manifest: PluginManifest,
  vaultPath: string,
  statePath: string,
  receipt: ActionReceipt,
): ActionReceipt {
  const clone = structuredClone(receipt);
  const result = clone.result as {
    path?: string;
    content?: string;
    title?: string;
    contentAvailable?: boolean;
    movedFiles?: { oldPath: string; newPath: string }[];
  } | null;
  if (result && typeof result.path === "string") {
    if (!readGrantCovers(manifest, vaultPath, statePath, result.path + ".md")) {
      delete result.content;
      delete result.title;
      result.contentAvailable = false;
    }
    if (result.movedFiles) {
      result.movedFiles = result.movedFiles.filter((file) =>
        readGrantCovers(manifest, vaultPath, statePath, file.oldPath) &&
        readGrantCovers(manifest, vaultPath, statePath, file.newPath)
      );
    }
  }
  if (
    clone.error &&
    ![
      "plugin_generation_revoked",
      "plugin_permission_denied",
      "plugin_cancelled",
      "plugin_guard_failed",
      "operation_conflict",
      "receipt_unavailable",
    ].includes(clone.error.code)
  ) {
    clone.error.detail =
      "Plugin action failed; unauthorized effect details are withheld.";
  }
  return clone;
}

/** Promise-chain mutex. Never holds across awaits the caller didn't choose. */
export class AsyncLock {
  #tail: Promise<void> = Promise.resolve();
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class PluginLifecycle {
  /** Monotonic access-policy epoch. Setup/reset/access-mode changes bump it
   * BEFORE old-generation authority is revoked; captured epochs then fail
   * the commit gate. */
  #epoch = 0;
  /** Short policy/data-commit gate. Kept separate from the note-operation
   * serialization boundary so a pre-hook's private-data write cannot
   * deadlock against an operation waiting for guards. */
  readonly gate = new AsyncLock();
  /** Managed write signatures: index scans must not double-report host
   * operations as external observations. Value: post-commit mtime (s) for
   * writes, or {deletedAt} epoch-ms for removals. */
  readonly managedWrites = new Map<string, number | { deletedAt: number }>();
  #factObserver: ((fact: OperationFact) => void) | null = null;
  #syncObserver: ((fact: OperationFact) => void) | null = null;
  readonly #invalidateListeners = new Set<() => void>();

  /** Catalog/settings-revision/status invalidation stream subscribers.
   * Listeners are removed on disconnect/shutdown by their owners. */
  subscribeInvalidation(listener: () => void): () => void {
    this.#invalidateListeners.add(listener);
    return () => this.#invalidateListeners.delete(listener);
  }
  notifyInvalidation(): void {
    for (const listener of [...this.#invalidateListeners]) {
      try {
        listener();
      } catch { /* a dead listener must not mute the others */ }
    }
  }

  constructor(private readonly config: GlobalConfig) {}

  get epoch(): number {
    return this.#epoch;
  }
  bumpEpoch(): number {
    return ++this.#epoch;
  }
  operational(): boolean {
    return !this.config.setupRequired;
  }
  writable(): boolean {
    return this.operational() && this.config.authType !== AuthType.READ_ONLY;
  }

  onFact(observer: (fact: OperationFact) => void): void {
    this.#factObserver = observer;
  }
  onSync(observer: (fact: OperationFact) => void): void {
    this.#syncObserver = observer;
  }
  /** Post-commit fact admission. Delivery is delegated; admission failures
   * here never change the committed operation's response. */
  observe(fact: OperationFact): void {
    try {
      this.#factObserver?.(fact);
    } catch {
      // Observer admission failure is recorded by the runtime, never thrown
      // back into a completed host operation.
    }
  }
  syncCompleted(fact: OperationFact): void {
    try {
      this.#syncObserver?.(fact);
    } catch { /* same admission contract */ }
  }

  /** Record a host-managed write so the next index scan does not emit a
   * duplicate external observation for it. */
  recordManaged(filename: string, mtime: number): void {
    this.managedWrites.set(filename, mtime);
  }
  recordManagedDelete(filename: string): void {
    this.managedWrites.set(filename, { deletedAt: Date.now() });
  }
  /** Consume a managed signature for a scan observation. Returns true when
   * the scan's observation corresponds to a recorded host operation. */
  consumeManaged(filename: string, fsMtime: number): boolean {
    const signature = this.managedWrites.get(filename);
    if (signature === undefined) return false;
    if (typeof signature === "number") {
      if (signature === fsMtime) {
        this.managedWrites.delete(filename);
        return true;
      }
      // Newer external write since our managed commit — report it.
      this.managedWrites.delete(filename);
      return false;
    }
    this.managedWrites.delete(filename);
    // A file recreated after a managed delete is a genuine external create.
    return fsMtime * 1000 <= signature.deletedAt;
  }

  /** Strip snapshot contents a plugin's read grants do not cover. The
   * reserved state root is never disclosed through facts, even when a broad
   * legacy `vault` grant covers its ancestor. */
  applyReadGrants(
    manifest: PluginManifest,
    fact: OperationFact,
  ): OperationFact {
    const clone = structuredClone(fact);
    for (const key of ["before", "proposed", "after"] as const) {
      const snapshot = clone[key];
      if (!snapshot) continue;
      if (
        !readGrantCovers(
          manifest,
          this.config.notesPath,
          this.config.statePath,
          snapshot.path + ".md",
        )
      ) {
        snapshot.content = undefined;
        snapshot.contentAvailable = false;
      }
    }
    const covers = (target: string) =>
      readGrantCovers(
        manifest,
        this.config.notesPath,
        this.config.statePath,
        target,
      );
    if (clone.changedPaths) {
      clone.changedPaths = clone.changedPaths.filter((target) =>
        covers(target + ".md")
      );
    }
    if (clone.metadata) {
      clone.metadata = projectMetadata(clone.metadata, covers);
    }
    return clone;
  }
}
function projectMetadata(
  value: import("./contracts.ts").JsonValues,
  covers: (target: string) => boolean,
): import("./contracts.ts").JsonValues {
  const result: import("./contracts.ts").JsonValues = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      result[key] = item.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return true;
        }
        const paths = Object.entries(entry).filter(([name, candidate]) =>
          /path|source|destination/i.test(name) && typeof candidate === "string"
        ).map(([, candidate]) => candidate as string);
        return paths.every(covers);
      });
    } else if (
      typeof item === "string" && /path|source|destination/i.test(key)
    ) {
      if (covers(item)) result[key] = item;
    } else result[key] = item;
  }
  return result;
}

/** Resolve a plugin facade target: relative paths resolve against the vault;
 * absolute paths are taken as stated; parent/target realpath containment is
 * enforced against the declared grants. Returns the resolved absolute path. */
export function resolveGrantedPath(
  vaultPath: string,
  target: string,
  grants: string[],
): string {
  if (!target || target.includes("\0")) {
    throw new Error("invalid file path");
  }
  const vaultRoot = realpathLoose(vaultPath);
  const candidate = path.isAbsolute(target)
    ? target
    : path.join(vaultRoot, target);
  const resolved = realpathLoose(candidate);
  const roots = grants.map((grant) =>
    grant === "vault"
      ? vaultRoot
      : realpathLoose(path.resolve(vaultRoot, grant))
  );
  if (!roots.some((root) => isSubpath(root, resolved))) {
    throw new Error("path is outside the plugin's declared grants");
  }
  return resolved;
}

/** The reserved state root (config, plugin data, another plugin's data) is
 * withheld from mediated facades even under a broad legacy vault grant. */
export function readGrantCovers(
  manifest: PluginManifest,
  vaultPath: string,
  statePath: string,
  vaultRelativeOrAbsolute: string,
): boolean {
  try {
    const resolved = resolveGrantedPath(
      vaultPath,
      vaultRelativeOrAbsolute,
      manifest.capabilities.read,
    );
    return !reservedStatePath(statePath, resolved);
  } catch {
    return false;
  }
}

/** Canonical host state exclusion shared by mediated reads, independent of raw grants. */
export function reservedStatePath(
  statePath: string,
  absoluteTarget: string,
): boolean {
  return isSubpath(realpathLoose(statePath), realpathLoose(absoluteTarget));
}

export type WriteTarget =
  | { kind: "note"; notePath: string; absolutePath: string }
  | { kind: "file"; absolutePath: string; requestedPath?: string };

/** Classify a plugin write target by canonical root ownership, not just
 * extension: addressable markdown inside this vault routes through note
 * create/save; granted external paths are plain guarded file-writes and
 * never enter the vault index. Reserved state is never writable here. */
export function classifyWriteTarget(
  manifest: PluginManifest,
  vaultPath: string,
  statePath: string,
  target: string,
): WriteTarget {
  const vaultRoot = realpathLoose(vaultPath);
  const stateRoot = realpathLoose(statePath);
  const resolved = resolveGrantedPath(
    vaultPath,
    target,
    manifest.capabilities.write,
  );
  if (isSubpath(stateRoot, resolved)) {
    throw new Error(
      "reserved host/plugin state is writable only through its owned data/settings service",
    );
  }
  if (isSubpath(vaultRoot, resolved)) {
    if (resolved.endsWith(".md")) {
      const rel = path.relative(vaultRoot, resolved).replace(/\\/g, "/");
      const notePath = rel.slice(0, -".md".length);
      // Invalid/reserved in-vault markdown paths are rejected, never
      // downgraded to an unguarded file write.
      const segments = notePath.split("/");
      if (
        segments[0] === "_" ||
        segments.some((s) => !s || s === "." || s === ".." || s.startsWith("."))
      ) {
        throw new Error("invalid in-vault markdown path");
      }
      return { kind: "note", notePath, absolutePath: resolved };
    }
    return { kind: "file", absolutePath: resolved, requestedPath: target };
  }
  return { kind: "file", absolutePath: resolved, requestedPath: target };
}

function realpathLoose(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathLoose(parent), path.basename(p));
  }
}

function isSubpath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
