// SPDX-License-Identifier: LGPL-3.0-only
import { type Base, checkBase } from "../gate.ts";
import { versionOf } from "../merge.ts";
import type { PeerFile } from "./peers.ts";

/** Bodies and baseText belong only to this invocation, never to peer metadata. */
export interface DriverImport {
  path: string;
  revision: string | null; // null is proven remote absence
  bytes?: Uint8Array;
  baseText?: string;
  expectedVersion: string | null;
  restore?: boolean;
}
export type ImportDisposition =
  | { kind: "unchanged" | "adopt" | "held" | "drop" }
  | { kind: "write"; bytes: Uint8Array; base: Base }
  | { kind: "delete"; base: Base }
  | {
    kind: "conflict";
    bytes: Uint8Array;
    reason: "unknown-base" | "stale-base";
  };

export function planImport(
  input: DriverImport,
  mapping: PeerFile | null,
  current: { version: string; bytes?: Uint8Array } | null,
  deleted: boolean,
): ImportDisposition {
  if (input.revision === null) {
    if (!mapping || !current || mapping.version !== current.version) {
      return { kind: "drop" };
    }
    return {
      kind: "delete",
      base: { kind: "version", version: mapping.version },
    };
  }
  if (mapping?.state === "excluded" || mapping?.state === "unsupported") {
    return { kind: "unchanged" };
  }
  if (mapping?.revision === input.revision && mapping.state === "synced") {
    return { kind: "unchanged" };
  }
  if (!input.bytes) throw new TypeError("Known import requires bytes");
  const incomingVersion = versionOf(input.bytes);
  if (current?.version === incomingVersion) return { kind: "adopt" };
  if (!current) {
    if (deleted && !input.restore) return { kind: "held" };
    return { kind: "write", bytes: input.bytes, base: { kind: "absent" } };
  }
  // Native validators can change without an endpoint edit. Keep the acknowledged
  // content version while adopting its new revision, so a newer local file still
  // exports against that revision instead of manufacturing a conflict copy.
  // Held bytes were observed, not accepted: a locally recreated path must still
  // preserve that alternative through the existing held/conflict flow.
  if (mapping?.version === incomingVersion && mapping.state !== "held") {
    return { kind: "adopt" };
  }
  if (mapping?.version === current.version) {
    return {
      kind: "write",
      bytes: input.bytes,
      base: { kind: "version", version: current.version },
    };
  }
  if (
    mapping && input.baseText !== undefined &&
    input.path.toLowerCase().endsWith(".md") &&
    versionOf(new TextEncoder().encode(input.baseText)) === mapping.version &&
    current.bytes
  ) {
    try {
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      const outcome = checkBase({ kind: "text", content: input.baseText }, {
        version: current.version,
        text: decoder.decode(current.bytes),
      }, decoder.decode(input.bytes));
      if (outcome.status === "merged") {
        return {
          kind: "write",
          bytes: new TextEncoder().encode(outcome.content),
          base: { kind: "text", content: input.baseText },
        };
      }
    } catch { /* Invalid UTF-8 is binary, not lossy merge input. */ }
  }
  return {
    kind: "conflict",
    bytes: input.bytes,
    reason: mapping ? "stale-base" : "unknown-base",
  };
}

/** Every part must be comparable and complete before omission proves absence. */
export function snapshotAbsences(
  input: {
    complete: boolean;
    uncertain: boolean;
    sameIdentity: boolean;
    sameScope: boolean;
    known: Set<string>;
    seen: Set<string>;
  },
  mappings: PeerFile[],
): { keys: string[]; remoteEmpty: boolean } {
  const synced = mappings.filter((row) => row.state === "synced");
  if (
    !input.complete || input.uncertain || !input.sameIdentity ||
    !input.sameScope
  ) return { keys: [], remoteEmpty: false };
  if (!input.known.size && synced.length) {
    return { keys: [], remoteEmpty: true };
  }
  return {
    keys: synced.filter((row) => !input.seen.has(row.pathKey)).map((row) =>
      row.pathKey
    ),
    remoteEmpty: false,
  };
}
