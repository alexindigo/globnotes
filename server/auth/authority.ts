// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { StoredConfigConflict } from "../config/file_store.ts";
import { OperationError } from "../plugins/errors.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import {
  type AuthorityDisclosure,
  createAuthorityDisclosure,
} from "../internal/authority_disclosure.ts";
export type {
  AuthorityDisclosure,
  PreparedAuthorityRead,
} from "../internal/authority_disclosure.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { ACCESS_LEVELS, type AclRepository, type AclSnapshot } from "./acl.ts";
import { withAuthorityContext } from "./internal/authority_context.ts";
import type {
  AuthorityCallback,
  AuthorityReadContext,
} from "./authority_context.ts";
import {
  type AccountPrincipal,
  AuthenticationError,
  type InstanceSessions,
  type Principal,
} from "./sessions.ts";

const REQUIREMENTS = {
  readVault: "view",
  editNotes: "edit",
  manageVault: "admin",
} as const;
export type VaultOperation = keyof typeof REQUIREMENTS;
export type InstanceOperation =
  | "readInstance"
  | "manageOwnAccount"
  | "createVault";
export interface AuthorityVault {
  /** Retained host bundle identity, shared by projections; replace on rebind. */
  readonly identity: object;
  readonly id: string;
  readonly acl: AclRepository;
  readonly lifecycle: {
    readonly epoch: number;
    readonly operational: AuthorityCallback<boolean>;
  };
}
/** Projection allocation is not an owner change. Owner bindings still must agree. */
export function sameAuthorityVault(
  current: AuthorityVault | null,
  captured: AuthorityVault,
): boolean {
  return current !== null && current.identity === captured.identity &&
    current.id === captured.id && current.acl === captured.acl &&
    current.lifecycle === captured.lifecycle;
}
export interface InstanceAuthorityLease extends AuthorityDisclosure {
  readonly lease: OperationLease<"live">;
  readonly operation: InstanceOperation;
  readonly principal: Principal;
  assertCurrent(operationId?: string): void;
}
export interface VaultAuthorityLease
  extends NoteMutationLease, AuthorityDisclosure {
  readonly lease: OperationLease<"live">;
  readonly vaultId: string;
  readonly aclRevision: number;
  readonly operation: VaultOperation;
  readonly principal: Principal;
}
function unauthorized(): never {
  throw new HttpError(401, "Invalid authentication credentials.", {
    "WWW-Authenticate": "Bearer",
  });
}
const forbidden = () => {
  throw new HttpError(403, "This account cannot perform that operation.");
};
function changed(operationId?: string): never {
  throw new OperationError(
    409,
    "operation_conflict",
    "Access policy changed while this operation was pending; it was not applied.",
    { operationId },
  );
}

/** One evaluator, injected instance session owner and concrete vault selector.
 * Nothing here selects a process-wide active user/vault or uses HTTP methods. */
export class InstanceAuthority {
  constructor(
    readonly sessions: InstanceSessions,
    readonly currentVault: AuthorityCallback<AuthorityVault | null>,
    readonly lifetime: OperationLease<"live">,
  ) {}
  #principal(principal: Principal, context: AuthorityReadContext): void {
    if (principal.kind === "account") {
      try {
        context.assertPrincipal(this.sessions, principal);
      } catch (error) {
        if (error instanceof AuthenticationError) unauthorized();
        throw error;
      }
    }
  }
  instanceGuard(
    principal: Principal,
    operation: InstanceOperation,
  ): () => void {
    return this.instanceLease(principal, operation).assertCurrent;
  }
  instanceLease(
    admittedPrincipal: Principal,
    operation: InstanceOperation,
  ): InstanceAuthorityLease {
    const lifetime = this.lifetime;
    assertOperationLease(lifetime, "live");
    const principal = Object.freeze({ ...admittedPrincipal });
    const guard = (context: AuthorityReadContext) => {
      this.#principal(principal, context);
      if (operation === "readInstance") return;
      if (principal.kind !== "account") unauthorized();
      if (operation === "createVault" && principal.passwordChangeRequired) {
        forbidden();
      }
      if (!["manageOwnAccount", "createVault"].includes(operation)) forbidden();
    };
    const { lease } = createOperationLease("live", [(_id, native) => {
      withAuthorityContext(native, guard);
    }], [lifetime]);
    return Object.freeze({
      ...createAuthorityDisclosure(lease, "live"),
      lease,
      principal,
      operation,
      assertCurrent: lease.assertCurrent,
    });
  }
  /** Domain-issued exact acknowledgment only; no session exception or new write.
   * Composition remains a parent even if the domain outcome survives self-change. */
  acknowledgment(outcome: OperationLease<"outcome">): AuthorityDisclosure {
    assertOperationLease(this.lifetime, "live");
    assertOperationLease(outcome, "outcome");
    const { lease } = createOperationLease("outcome", [() => {}], [
      this.lifetime,
      outcome,
    ]);
    return createAuthorityDisclosure(lease, "outcome");
  }
  /** Final body fence for vault access workflows, including exact receipts that
   * may survive Admin loss. Admin-only bodies also retain their admission lease. */
  vaultDisclosure(
    actor: AccountPrincipal,
    vault: AuthorityVault,
    snapshot: AclSnapshot,
    options: {
      signal?: AbortSignal;
      admin?: VaultAuthorityLease;
      exact?: AuthorityCallback<void>;
    } = {},
  ): AuthorityDisclosure {
    const { signal, admin, exact } = options;
    const principal = Object.freeze({ ...actor });
    const { acl, lifecycle } = vault, epoch = lifecycle.epoch;
    const policy = withAuthorityContext(
      undefined,
      (context) => context.acl(acl).policyKey,
    );
    const { lease } = createOperationLease("outcome", [
      () =>
        withAuthorityContext(undefined, (context) => {
          signal?.throwIfAborted();
          context.assertPrincipal(this.sessions, principal);
          if (!sameAuthorityVault(this.currentVault(context), vault)) {
            throw new HttpError(404, "Vault unavailable.");
          }
          if (!lifecycle.operational(context)) {
            throw new HttpError(503, "Vault unavailable.");
          }
          exact?.(context);
          context.assertAclUnchanged(acl, snapshot);
          if (
            lifecycle.epoch !== epoch || context.acl(acl).policyKey !== policy
          ) {
            throw new StoredConfigConflict();
          }
          signal?.throwIfAborted();
          return undefined;
        }),
    ], admin ? [admin.lease] : [this.lifetime]);
    return this.acknowledgment(lease);
  }
  capabilities(
    principal: Principal,
    vault?: AuthorityVault | null,
  ) {
    return withAuthorityContext(undefined, (context) => {
      const selected = vault === undefined ? this.currentVault(context) : vault;
      this.#principal(principal, context);
      const signedIn = principal.kind === "account",
        unrestricted = !signedIn || !principal.passwordChangeRequired;
      const granted = selected && selected.id === selected.acl.vaultId &&
          selected.lifecycle.operational(context) && unrestricted
        ? ACCESS_LEVELS.indexOf(
          context.acl(selected.acl).effectiveLevel(principal, context),
        )
        : 0;
      return Object.freeze({
        canRead: granted >= 1,
        canEdit: granted >= 2,
        canManageVault: granted >= 3,
        canManageOwnAccount: signedIn,
        canCreateVault: signedIn && unrestricted,
      });
    });
  }
  lease(principal: Principal, operation: VaultOperation): VaultAuthorityLease {
    return this.prepareLease(operation)(principal);
  }
  /** Capture concrete owner witnesses before token validation or any other wait.
   * This is preparation, not permission: binding still evaluates the principal. */
  prepareLease(
    operation: VaultOperation,
  ): (principal: Principal) => VaultAuthorityLease {
    const lifetime = this.lifetime;
    assertOperationLease(lifetime, "live");
    // Capture now, but report target/storage errors only after authenticating.
    // A failed capture is retained too; it must never be retried under a new owner.
    const captured = withAuthorityContext(undefined, (context) => {
      try {
        const selected = this.currentVault(context);
        if (!selected || selected.id !== selected.acl.vaultId) {
          throw new HttpError(404, "Vault unavailable.");
        }
        const vault = Object.freeze({ ...selected });
        return {
          value: {
            vault,
            snapshot: vault.acl.capture(),
            policy: vault.acl.policyKey,
            epoch: vault.lifecycle.epoch,
          },
        };
      } catch (error) {
        return { error };
      }
    });
    return (admittedPrincipal: Principal): VaultAuthorityLease => {
      const principal = Object.freeze({ ...admittedPrincipal });
      withAuthorityContext(
        undefined,
        (context) => this.#principal(principal, context),
      );
      if ("error" in captured) throw captured.error;
      const { vault, snapshot, policy, epoch } = captured.value;
      const allows = (context: AuthorityReadContext) => {
        this.#principal(principal, context);
        if (!vault.lifecycle.operational(context)) {
          throw new HttpError(503, "Vault unavailable.");
        }
        if (principal.kind === "account" && principal.passwordChangeRequired) {
          forbidden();
        }
        const requirement = REQUIREMENTS[operation];
        if (
          !requirement ||
          ACCESS_LEVELS.indexOf(
              context.acl(vault.acl).effectiveLevel(principal, context),
            ) <
            ACCESS_LEVELS.indexOf(requirement)
        ) forbidden();
      };
      withAuthorityContext(undefined, allows);
      const guard = (
        context: AuthorityReadContext,
        operationId?: string,
      ): undefined => {
        this.#principal(principal, context);
        const acl = context.acl(vault.acl);
        if (
          !sameAuthorityVault(this.currentVault(context), vault) ||
          vault.lifecycle.epoch !== epoch ||
          acl.policyKey !== policy
        ) changed(operationId);
        try {
          context.assertAclUnchanged(vault.acl, snapshot);
        } catch (error) {
          if (error instanceof StoredConfigConflict) changed(operationId);
          throw error;
        }
        allows(context);
      };
      const { lease } = createOperationLease("live", [
        (id, native) =>
          withAuthorityContext(native, (context) => guard(context, id)),
      ], [lifetime]);
      const assertCurrent = lease.assertCurrent;
      assertCurrent();
      return Object.freeze({
        ...createAuthorityDisclosure(lease, "live"),
        lease,
        vaultId: vault.id,
        aclRevision: snapshot.value.revision,
        operation,
        principal: Object.freeze({ ...principal }),
        epoch,
        assertCurrent,
      });
    };
  }
}
