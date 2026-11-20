// SPDX-License-Identifier: LGPL-3.0-only
/** Private pure reducer contract. No persistence, authority or sign-in proof. */
import type { Account } from "./account_record.ts";
import {
  sameStoredTotpSecret,
  serializeStoredTotpSecret,
  type StoredAuthenticator,
} from "../credentials.ts";
export function reduceAccountCredentials(
  account: Account,
  before: StoredAuthenticator,
  after: StoredAuthenticator,
  updateId: string,
  passwordHash = account.passwordHash,
  restricted = account.passwordChangeRequired,
): Account {
  const same = before.kind === "totp" && after.kind === "totp" &&
    sameStoredTotpSecret(before.secret, after.secret);
  const floor = after.kind === "none"
    ? null
    : same
    ? Math.max(before.lastTotpStep ?? -1, after.lastTotpStep ?? -1)
    : after.lastTotpStep;
  const next = {
    ...account,
    passwordHash,
    passwordChangeRequired: restricted,
    credentialRevision: account.credentialRevision + 1,
    credentialUpdateId: updateId,
    totpKey: after.kind === "none"
      ? null
      : serializeStoredTotpSecret(after.secret).key,
    lastTotpStep: floor === -1 ? null : floor,
  };
  delete next.totpKeyEncoding;
  if (after.kind === "totp") {
    const stored = serializeStoredTotpSecret(after.secret);
    if (Object.hasOwn(stored, "encoding")) {
      next.totpKeyEncoding = stored.encoding;
    }
  }
  return Object.freeze(next);
}
