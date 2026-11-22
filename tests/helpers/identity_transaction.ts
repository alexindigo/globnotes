// SPDX-License-Identifier: LGPL-3.0-only
import { AclRepository } from "../../server/auth/acl.ts";
import { IdentityTransaction } from "../../server/auth/transaction.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import { preparationContext } from "./account_preparation.ts";
import { UPDATE, VAULT_A } from "./identity.ts";
import type { FixtureScope } from "./fixture_scope.ts";

/** Domain fixture composition only; P03 owns the supplied root and every owner. */
export function transactionContext(
  root: string,
  scope?: FixtureScope,
  checkpoint?: (phase: string) => void,
) {
  const f = preparationContext(root, {});
  scope?.defer(() => f.accounts.retireCredentials());
  scope?.defer(() => f.retire());
  const lifetime = createOperationLease("live", [() => undefined]);
  scope?.defer(() => lifetime.retire());
  const vaultRoot = `${root}/vault`;
  const acl = new AclRepository(vaultRoot, VAULT_A, { accounts: f.accounts });
  const transaction = new IdentityTransaction(f.accounts, acl, {
    vaultRoot,
    lease: lifetime.lease,
    checkpoint,
  });
  const stage = async () => {
    f.accounts.prepareParents();
    acl.prepareParents();
    const prepared = await f.accounts.credentials.prepareInitialAccount(
      f.authority("initial"),
      f.request(),
    );
    const before = f.accounts.capture();
    const parts = transaction.prepareInitial(
      prepared,
      "view",
      acl.capture(),
      lifetime.lease,
      UPDATE,
    );
    scope?.defer(() => parts.discard());
    return {
      before,
      parts,
      identity: prepared.identity,
      meta: {
        kind: "setup" as const,
        operationId: UPDATE,
        actorId: prepared.identity.id,
        vaultId: VAULT_A,
      },
    };
  };
  return {
    ...f,
    acl,
    transaction,
    lease: lifetime.lease,
    retire: () => {
      lifetime.retire();
      f.retire();
    },
    stage,
  };
}
