// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The versioning extension point (docs/hub.md "Versioning"): before the gate
 * replaces, deletes or moves bytes away from a path, it offers them to
 * versioners. The hub keeps nothing: the bytes are read for the offer and
 * dropped. The plugin runtime implements this interface; the hub never
 * imports plugins.
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

export interface OfferOutcome {
  versioner: string;
  path: string;
  status: "kept" | "declined" | "failed" | "timeout" | "too_large";
}

export interface Versioning {
  /** Whether any versioner takes offers for `path` written by `origin`
   * (bytes are read only then). */
  interested(path: string, origin: string): boolean;
  /** Resolves when every eligible versioner has taken custody, declined,
   * failed or timed out (`deadline` in observed time); never rejects. The
   * bytes may still not be displaced (a later refusal). */
  offer(offers: DisplacementOffer[], deadline: number): Promise<OfferOutcome[]>;
}
