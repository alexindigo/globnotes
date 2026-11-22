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
import type {
  NoteMutationLease,
  PluginLifecycle,
} from "../plugins/lifecycle.ts";
import { ACCESS_LEVELS, type AclRepository } from "./acl.ts";
import {
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
  readonly lifecycle: Pick<PluginLifecycle, "epoch" | "operational">;
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
    readonly currentVault: () => AuthorityVault | null,
    readonly lifetime: OperationLease<"live">,
  ) {}
  #principal(principal: Principal): void {
    if (principal.kind === "account") {
      try {
        this.sessions.assertCurrent(principal);
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
    const guard = () => {
      this.#principal(principal);
      if (operation === "readInstance") return;
      if (principal.kind !== "account") unauthorized();
      if (operation === "createVault" && principal.passwordChangeRequired) {
        forbidden();
      }
      if (!["manageOwnAccount", "createVault"].includes(operation)) forbidden();
    };
    const { lease } = createOperationLease("live", [() => {
      guard();
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
  capabilities(
    principal: Principal,
    vault: AuthorityVault | null = this.currentVault(),
  ) {
    this.#principal(principal);
    const signedIn = principal.kind === "account",
      unrestricted = !signedIn || !principal.passwordChangeRequired;
    const granted = vault && vault.id === vault.acl.vaultId &&
        vault.lifecycle.operational() && unrestricted
      ? ACCESS_LEVELS.indexOf(vault.acl.effectiveLevel(principal))
      : 0;
    return Object.freeze({
      canRead: granted >= 1,
      canEdit: granted >= 2,
      canManageVault: granted >= 3,
      canManageOwnAccount: signedIn,
      canCreateVault: signedIn && unrestricted,
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
    const captured = (() => {
      try {
        const selected = this.currentVault();
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
    })();
    return (admittedPrincipal: Principal): VaultAuthorityLease => {
      const principal = Object.freeze({ ...admittedPrincipal });
      this.#principal(principal);
      if ("error" in captured) throw captured.error;
      const { vault, snapshot, policy, epoch } = captured.value;
      const allows = () => {
        this.#principal(principal);
        if (!vault.lifecycle.operational()) {
          throw new HttpError(503, "Vault unavailable.");
        }
        if (principal.kind === "account" && principal.passwordChangeRequired) {
          forbidden();
        }
        const requirement = REQUIREMENTS[operation];
        if (
          !requirement ||
          ACCESS_LEVELS.indexOf(vault.acl.effectiveLevel(principal)) <
            ACCESS_LEVELS.indexOf(requirement)
        ) forbidden();
      };
      allows();
      const guard = (operationId?: string): undefined => {
        this.#principal(principal);
        if (
          !sameAuthorityVault(this.currentVault(), vault) ||
          vault.lifecycle.epoch !== epoch ||
          vault.acl.policyKey !== policy
        ) changed(operationId);
        try {
          vault.acl.assertUnchanged(snapshot);
        } catch (error) {
          if (error instanceof StoredConfigConflict) changed(operationId);
          throw error;
        }
        allows();
      };
      const { lease } = createOperationLease("live", [guard], [lifetime]);
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
