// SPDX-License-Identifier: LGPL-3.0-only
import type { OwnerIdentity } from "../../shared/ownership.js";

/** Public receipts never retain bytes, paths, installer errors or credentials. */
export interface PublicationOutcome {
  readonly operation: OwnerIdentity;
  readonly committed: true;
  readonly state: "committed" | "recovery-required";
  readonly warning: "stored-durability-unconfirmed" | null;
  readonly notificationFailed: boolean;
}
export class PublicationRecoveryRequired extends Error {
  constructor(readonly outcome: PublicationOutcome) {
    super("Stored state was published; runtime recovery is required.");
  }
}
export class StoredConfigConflict extends Error {
  constructor() {
    super("Stored configuration changed before commit.");
  }
}
/** A participant is deliberately unreadable while its complete set settles. */
export class PublicationSetUnavailable extends Error {
  constructor() {
    super(
      "Publication set is unavailable; settlement or recovery is required.",
    );
  }
}
