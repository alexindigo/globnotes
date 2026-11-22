// SPDX-License-Identifier: LGPL-3.0-only
import { AclRepository } from "../../server/auth/acl.ts";
import { IdentityBootstrap } from "../../server/auth/bootstrap.ts";
import { preparationContext } from "./account_preparation.ts";
import { createOperationLease } from "../../server/operation_lease.ts";
import { VAULT_A } from "./identity.ts";
import type { FixtureScope } from "./fixture_scope.ts";
import type { CredentialOptions } from "../../server/auth/account_credentials.ts";

export function bootstrapContext(
  root: string,
  scope: FixtureScope,
  options: CredentialOptions & {
    first?: { login: string; password: string };
    legacy?: () => boolean;
    declaredAdmin?: string;
    target?: boolean;
  } = {},
) {
  const f = preparationContext(root, options);
  scope.defer(() => f.accounts.retireCredentials());
  scope.defer(() => f.retire());
  const lifetime = createOperationLease("live", [() => undefined]);
  scope.defer(() => lifetime.retire());
  const acl = new AclRepository(`${root}/vault`, VAULT_A, {
    accounts: f.accounts,
    declaredAdmin: options.declaredAdmin,
  });
  const bootstrap = new IdentityBootstrap(f.accounts, f.sessions, {
    lease: lifetime.lease,
    legacy: options.legacy ?? (() => false),
    first: options.first,
    ...(options.target === false
      ? {}
      : { target: { acl, root: `${root}/vault` } }),
  });
  scope.defer(() => bootstrap.dispose());
  return {
    ...f,
    acl,
    bootstrap,
    lease: lifetime.lease,
    retire() {
      lifetime.retire();
      bootstrap.dispose();
    },
  };
}
