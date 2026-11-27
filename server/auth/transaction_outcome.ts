// SPDX-License-Identifier: LGPL-3.0-only

/** The outcome is unavailable, not proof that a transaction failed to commit. */
export class IdentityTransactionUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Identity publication requires recovery; no partial state is available.",
      options,
    );
  }
}
