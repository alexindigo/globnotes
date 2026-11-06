// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Best-effort post-commit delivery for the legacy v2 backup plugin. The host
 * captures displaced bytes transiently, never persists them, and never waits
 * for plugins. Future v3 versioners follow the hub change log (M5/M7).
 */

export interface DisplacementOffer {
  operationId: string;
  kind: "replace" | "delete" | "move";
  /** Vault-relative, disk spelling, with extension. */
  path: string;
  /** For "move": where the bytes go. */
  newPath?: string;
  /** versionOf(bytes): the raw-byte SHA-256. */
  version: string;
  size: number;
  /** Null when the file is larger than the offer bound. */
  bytes: Uint8Array | null;
  /** The writer: "api" or "plugin:<id>". */
  origin: string;
}

export interface Versioning {
  /** Whether any versioner takes offers for `path` written by `origin`
   * (bytes are read only then). */
  interested(path: string, origin: string): boolean;
  /** Admit committed displacements to independent bounded in-memory queues.
   * No plugin execution or completion is awaited; gaps are diagnostics. */
  enqueue(offers: DisplacementOffer[]): void;
}
