// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AccountDirectorySnapshot,
  AccountRepository,
} from "../accounts.ts";
import type { AccessLevel, AclRepository, AclSnapshot } from "../acl.ts";
import type {
  AccountPrincipal,
  InstanceSessions,
  Principal,
  SessionRepository,
} from "../sessions.ts";
import {
  PublicationSetUnavailable,
  StoredConfigConflict,
} from "../../config/publication_outcome.ts";
import { activeOperationValidation } from "../../internal/operation_validation.ts";
import { authorityRead } from "./authority_read.ts";

declare const contextBrand: unique symbol;
export type AuthorityPrincipalCheck = (
  principal: AccountPrincipal,
  context: AuthorityReadContext,
) => void;
export interface AuthorityReadContext {
  readonly [contextBrand]: true;
  accounts(owner: AccountRepository): AccountDirectorySnapshot;
  signing(
    owner: SessionRepository,
  ): Readonly<{ initialized: boolean; signingRevision: number }>;
  assertPrincipal(owner: InstanceSessions, principal: AccountPrincipal): void;
  acl(owner: AclRepository): Readonly<{
    snapshot: AclSnapshot;
    policyKey: string;
    effectiveLevel(
      principal: Principal,
      context: AuthorityReadContext,
    ): AccessLevel;
  }>;
  assertAclUnchanged(owner: AclRepository, snapshot: AclSnapshot): void;
}
const issued = new WeakMap<
  AuthorityReadContext,
  { native: object | undefined; active(): boolean }
>();
const contexts = new WeakMap<object, AuthorityReadContext>();
export function assertAuthorityContext(context: AuthorityReadContext): void {
  const binding = issued.get(context);
  if (!binding?.active()) throw new PublicationSetUnavailable();
}
function createContext(
  native: object | undefined,
  active: () => boolean,
): AuthorityReadContext {
  const check = () => assertAuthorityContext(context);
  const context: AuthorityReadContext = Object.freeze({
    accounts(owner: AccountRepository) {
      check();
      return native
        ? authorityRead<AccountDirectorySnapshot>(owner, native)
        : owner.capture();
    },
    signing(owner: SessionRepository) {
      check();
      return authorityRead<{ initialized: boolean; signingRevision: number }>(
        owner,
        native,
      );
    },
    assertPrincipal(owner: InstanceSessions, principal: AccountPrincipal) {
      check();
      const validate: AuthorityPrincipalCheck = owner.assertCurrent.bind(owner);
      validate(principal, context);
    },
    acl(owner: AclRepository) {
      check();
      const projection = native
        ? authorityRead<ReturnType<AuthorityReadContext["acl"]>>(owner, native)
        : {
          snapshot: owner.capture(),
          policyKey: owner.policyKey,
          effectiveLevel: (
            principal: Principal,
            _context: AuthorityReadContext,
          ) => owner.effectiveLevel(principal),
        };
      return Object.freeze({
        snapshot: projection.snapshot,
        policyKey: projection.policyKey,
        effectiveLevel(principal: Principal, supplied: AuthorityReadContext) {
          check();
          if (supplied !== context) throw new PublicationSetUnavailable();
          return projection.effectiveLevel(principal, context);
        },
      });
    },
    assertAclUnchanged(owner: AclRepository, snapshot: AclSnapshot) {
      check();
      if (native) {
        if (
          authorityRead<{ snapshot: AclSnapshot }>(owner, native).snapshot !==
            snapshot
        ) throw new StoredConfigConflict();
      } else owner.assertUnchanged(snapshot);
    },
  }) as AuthorityReadContext;
  issued.set(context, { native, active });
  return context;
}
/** All callbacks in a single native check receive the same object. Each native
 * check has a fresh identity; an earlier callback cannot reopen a later check. */
export function withAuthorityContext<T>(
  native: object | undefined,
  run: (context: AuthorityReadContext) => T,
): T {
  if (native) {
    let context = contexts.get(native);
    if (!context) {
      context = createContext(native, () => activeOperationValidation(native));
      contexts.set(native, context);
    }
    assertAuthorityContext(context);
    return run(context);
  }
  let active = true;
  const context = createContext(undefined, () => active);
  try {
    return run(context);
  } finally {
    active = false;
  }
}
