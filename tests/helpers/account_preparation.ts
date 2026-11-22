// SPDX-License-Identifier: LGPL-3.0-only
import { AccountRepository } from "../../server/auth/accounts.ts";
import {
  type AccountPreparationRequest,
  type CredentialOptions,
} from "../../server/auth/account_credentials.ts";
import { bindAccountPreparationAuthority } from "../../server/auth/internal/account_credentials.ts";
import { acquireOfflineRecovery } from "../../server/auth/offline_recovery.ts";
import {
  createOperationLease,
  type OperationLease,
} from "../../server/operation_lease.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../../server/auth/sessions.ts";
import { identityFixture, UPDATE } from "./identity.ts";
import { fixturePasswordHash } from "./config.ts";
export const recoveryForRoot = (root: string) => acquireOfflineRecovery(root);
/** Historical fixture input enters only the aggregate's locked import lane. */
export function importFixtureAccount(
  accounts: AccountRepository,
  input: unknown,
) {
  accounts.prepareParents();
  const recovery = recoveryForRoot(accounts.root);
  try {
    return accounts.credentials.importAccount(recovery.authority, input);
  } finally {
    recovery.close();
  }
}
export async function resetFixturePassword(
  accounts: AccountRepository,
  id: string,
  password: string,
  updateId: string,
) {
  const recovery = recoveryForRoot(accounts.root);
  try {
    return await accounts.credentials.resetPassword(recovery.authority, {
      accountId: id,
      credentialRevision: accounts.byId(id)!.credentialRevision,
      password,
      updateId,
    });
  } finally {
    recovery.close();
  }
}
export async function disableFixtureAuthenticator(
  accounts: AccountRepository,
  id: string,
  updateId: string,
) {
  const recovery = recoveryForRoot(accounts.root);
  try {
    return await accounts.credentials.disableAuthenticator(recovery.authority, {
      accountId: id,
      credentialRevision: accounts.byId(id)!.credentialRevision,
      updateId,
    });
  } finally {
    recovery.close();
  }
}

export async function preparationFixture(
  run: (fixture: ReturnType<typeof preparationContext>) => Promise<void>,
  options: CredentialOptions = {},
) {
  await identityFixture(async (root, scope) => {
    const fixture = preparationContext(root, options);
    scope.onCancel(() => fixture.retire());
    scope.onCancel(() => fixture.accounts.retireCredentials());
    await run(fixture);
  });
}
export function preparationContext(root: string, options: CredentialOptions) {
  const accounts = new AccountRepository(root, undefined, {
    hash: (password) => Promise.resolve(fixturePasswordHash(password)),
    ...options,
  });
  const lifetime = createOperationLease("live", [() => undefined]);
  const authority = (
    purpose: "initial" | "recipient",
    completion?: OperationLease<"live">,
    admission = lifetime.lease,
  ) =>
    bindAccountPreparationAuthority(
      accounts.credentials,
      purpose,
      admission,
      completion,
    );
  const request = (
    changes: Partial<AccountPreparationRequest> = {},
  ): AccountPreparationRequest => ({
    login: "alice",
    password: "password",
    updateId: UPDATE,
    ...changes,
  });
  const signing = new SessionRepository(accounts.root);
  const sessions = new InstanceSessions(accounts, signing, {
    expirySeconds: 86400,
  });
  const createInitial = async () => {
    const prepared = await accounts.credentials.prepareInitialAccount(
      authority("initial"),
      request(),
    );
    return accounts.credentials.publishPreparedAccount(prepared.prepared);
  };
  return {
    root: accounts.root,
    accounts,
    authority,
    request,
    signing,
    sessions,
    createInitial,
    retire: lifetime.retire,
    offline: () => recoveryForRoot(accounts.root),
  };
}
