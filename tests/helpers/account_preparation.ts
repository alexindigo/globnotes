// SPDX-License-Identifier: LGPL-3.0-only
import { AccountRepository } from "../../server/auth/accounts.ts";
import {
  type AccountPreparationRequest,
  type CredentialOptions,
} from "../../server/auth/account_credentials.ts";
import { bindAccountPreparationAuthority } from "../../server/auth/internal/account_credentials.ts";
import { acquireOfflineRecovery } from "../../server/auth/offline_recovery.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../../server/auth/sessions.ts";
import { identityFixture, UPDATE } from "./identity.ts";
import { fixturePasswordHash } from "./config.ts";
export const recoveryForRoot = (root: string) => acquireOfflineRecovery(root);

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
  const authority = (purpose: "initial" | "recipient") =>
    bindAccountPreparationAuthority(
      accounts.credentials,
      purpose,
      lifetime.lease,
    );
  const request = (
    changes: Partial<AccountPreparationRequest> = {},
  ): AccountPreparationRequest => ({
    login: "alice",
    password: "password",
    updateId: UPDATE,
    ...changes,
  });
  const signing = new SessionRepository(root);
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
    root,
    accounts,
    authority,
    request,
    signing,
    sessions,
    createInitial,
    retire: lifetime.retire,
    offline: () => recoveryForRoot(root),
  };
}
