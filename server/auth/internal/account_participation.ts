// SPDX-License-Identifier: LGPL-3.0-only
import type { AccountIdentity } from "../accounts.ts";
import { IdentityStateError } from "../records.ts";
import type { AccessLevel } from "../acl.ts";

interface AclParticipantBinding {
  readonly kind: "initial" | "grant";
  readonly credentials: object;
  readonly account: AccountIdentity;
  readonly vaultId: string;
  readonly level: AccessLevel;
  readonly updateId: string;
  readonly actorId: string;
}
const issued = new WeakMap<object, AclParticipantBinding>();
/** Only the actual ACL repository registers these domain facts, after native
 * participant preparation. Workflows cannot certify an arbitrary grant. */
export function registerAccountAclParticipant(
  participant: object,
  binding: AclParticipantBinding,
): void {
  if (issued.has(participant)) throw new IdentityStateError();
  issued.set(participant, Object.freeze({ ...binding }));
}
export function accountAclParticipant(
  participant: object,
  credentials: object,
  accountId: string,
) {
  const binding = issued.get(participant);
  if (
    !binding || binding.credentials !== credentials ||
    binding.account.id !== accountId
  ) throw new IdentityStateError();
  return binding;
}
