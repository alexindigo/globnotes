// SPDX-License-Identifier: LGPL-3.0-only
import { AclRepository } from "../../server/auth/acl.ts";
import { InstanceAuthority } from "../../server/auth/authority.ts";
import type { AuthorityReadContext } from "../../server/auth/authority_context.ts";
import { VaultAccess } from "../../server/auth/access.ts";
import { AccountProvisioning } from "../../server/auth/provisioning.ts";
import { IdentityTransaction } from "../../server/auth/transaction.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import { createUuid } from "../../shared/uuid.ts";
import {
  importFixtureAccount,
  preparationContext,
  recoveryForRoot,
} from "./account_preparation.ts";
import { fixturePasswordHash } from "./config.ts";
import type { FixtureScope } from "./fixture_scope.ts";
import { identityAccount, identityFixture, VAULT_A } from "./identity.ts";
import { signIn } from "./session_delivery.ts";

export type WorkflowOptions = {
  /** Injected before the fixture's deterministic hash of each password. */
  hashing?: (password: string) => Promise<void> | void;
  checkpoint?: (phase: string) => void;
};
export type IdentityWorkflows = Awaited<ReturnType<typeof identityWorkflows>>;

/** P03 owns the root and every owner below from allocation. */
export async function identityWorkflowFixture(
  run: (f: IdentityWorkflows, scope: FixtureScope) => Promise<void>,
  options: WorkflowOptions = {},
) {
  await identityFixture(async (root, scope) =>
    await run(await identityWorkflows(root, scope, options), scope)
  );
}
/** Real issued owners: initial account, offline fixture import of bob, signing,
 * actual sign-in, creator ACL, transaction and a composition lifetime. A restart
 * constructs fresh owners on the same root and recovers under offline authority. */
export async function identityWorkflows(
  root: string,
  scope: FixtureScope,
  options: WorkflowOptions = {},
  restart = false,
) {
  const f = preparationContext(root, {
    hash: async (password) => {
      await options.hashing?.(password);
      return fixturePasswordHash(password);
    },
  });
  scope.defer(() => f.accounts.retireCredentials());
  scope.defer(() => f.retire());
  const lifetime = createOperationLease("live", [() => undefined]);
  scope.defer(() => lifetime.retire());
  const vaultRoot = `${root}/vault`;
  const acl = new AclRepository(vaultRoot, VAULT_A, { accounts: f.accounts });
  const transaction = new IdentityTransaction(f.accounts, acl, {
    vaultRoot,
    lease: lifetime.lease,
    checkpoint: options.checkpoint,
  });
  scope.defer(() => transaction.close());
  if (restart) {
    const recovery = recoveryForRoot(root);
    try {
      transaction.recover(recovery.authority);
    } finally {
      recovery.close();
    }
  } else {
    f.accounts.prepareParents();
    acl.prepareParents();
    const alice = await f.createInitial();
    f.signing.initialize();
    importFixtureAccount(
      f.accounts,
      identityAccount({
        id: createUuid(),
        login: "bob",
        passwordHash: fixturePasswordHash("password"),
      }),
    );
    acl.initializeForCreator(alice, "none");
  }
  const alice = f.accounts.byLogin("alice")!, bob = f.accounts.byLogin("bob")!;
  const a = (await signIn(f.sessions, {
    username: "alice",
    password: "password",
  })).principal;
  const b = (await signIn(f.sessions, {
    username: "bob",
    password: "password",
  })).principal;
  const vault = {
    identity: {},
    id: VAULT_A,
    acl,
    lifecycle: {
      epoch: 0,
      operational: (context: AuthorityReadContext) =>
        context.accounts(f.accounts).value.initialized &&
        context.signing(f.signing).initialized,
    },
  };
  const authority = new InstanceAuthority(
    f.sessions,
    () => vault,
    lifetime.lease,
  );
  const access = new VaultAccess(authority, vault);
  return {
    ...f,
    alice,
    bob,
    a,
    b,
    acl,
    vault,
    lease: lifetime.lease,
    authority,
    transaction,
    access,
    provisioning: new AccountProvisioning(access, transaction),
    restart(next: WorkflowOptions = {}) {
      transaction.close();
      lifetime.retire();
      return identityWorkflows(root, scope, next, true);
    },
    policy: (
      grants: Record<string, "none" | "view" | "edit" | "admin">,
      everybody: "none" | "view" | "edit" = "none",
    ) =>
      acl.save({ everybody, grants }, acl.capture(), {
        updateId: createUuid(),
        actorId: alice.id,
      }),
    /** Actual response consumption, not an unwrapped workflow value. */
    read: async (
      body: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
    ): Promise<Record<string, unknown>> =>
      await new Response(await body).json(),
  };
}
