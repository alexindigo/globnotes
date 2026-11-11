// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { StoredConfigConflict } from "../config/file_store.ts";
import { OperationError } from "../plugins/errors.ts";
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
export type InstanceOperation = "manageOwnAccount" | "createVault";
export interface AuthorityVault {
  readonly id: string;
  readonly acl: AclRepository;
  readonly lifecycle: Pick<PluginLifecycle, "epoch" | "operational">;
}
export interface VaultAuthorityLease extends NoteMutationLease {
  readonly vaultId: string;
  readonly aclRevision: number;
  readonly operation: VaultOperation;
  readonly principal: Principal;
  /** Call at actual response/worker/event enqueue, not just after preparation. */
  disclose<T>(prepare: () => T): T;
  read<T>(prepare: () => Promise<T>): Promise<T>;
  stream<T>(source: ReadableStream<T>): ReadableStream<T>;
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
    const guard = () => {
      this.#principal(principal);
      if (principal.kind !== "account") unauthorized();
      if (operation === "createVault" && principal.passwordChangeRequired) {
        forbidden();
      }
      if (!["manageOwnAccount", "createVault"].includes(operation)) forbidden();
    };
    guard();
    return guard;
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
    this.#principal(principal);
    const vault = this.currentVault();
    if (!vault || vault.id !== vault.acl.vaultId) {
      throw new HttpError(404, "Vault unavailable.");
    }
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
    const snapshot = vault.acl.capture(),
      policy = vault.acl.policyKey,
      epoch = vault.lifecycle.epoch;
    const assertCurrent = (operationId?: string) => {
      this.#principal(principal);
      if (
        this.currentVault() !== vault || vault.lifecycle.epoch !== epoch ||
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
    const disclose = <T>(prepare: () => T): T => {
      assertCurrent();
      const value = prepare();
      assertCurrent();
      return value;
    };
    assertCurrent();
    return Object.freeze({
      vaultId: vault.id,
      aclRevision: snapshot.value.revision,
      operation,
      principal: Object.freeze({ ...principal }),
      epoch,
      assertCurrent,
      disclose,
      async read<T>(prepare: () => Promise<T>): Promise<T> {
        assertCurrent();
        const value = await prepare();
        return disclose(() => value);
      },
      stream<T>(source: ReadableStream<T>): ReadableStream<T> {
        const reader = source.getReader();
        let finished = false;
        const release = () => {
          if (!finished) {
            finished = true;
            reader.releaseLock();
          }
        };
        return new ReadableStream<T>({
          async pull(controller) {
            try {
              assertCurrent();
              const result = await reader.read();
              assertCurrent();
              if (result.done) {
                release();
                controller.close();
              } else disclose(() => controller.enqueue(result.value));
            } catch (error) {
              controller.error(error);
              reader.cancel(error).catch(() => {}).finally(release);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        }, { highWaterMark: 0 });
      },
    });
  }
}
