// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { type AccountRepository } from "../auth/accounts.ts";
import {
  type AclState,
  assertKnownAclGrantees,
  validateAcl,
} from "../auth/acl.ts";
import { fields, identity, IdentityFile, record } from "../auth/records.ts";

export interface SingleVaultBinding {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
}
export class VaultBindingError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Single-vault binding requires operator recovery; no identity or access policy was replaced.",
      options,
    );
  }
}
function validateBinding(value: unknown): SingleVaultBinding | null {
  if (value === null) return null;
  if (
    !record(value) || !fields(value, ["version", "id", "createdAt"]) ||
    value.version !== 1 || !identity(value.id) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) throw new VaultBindingError();
  return value as unknown as SingleVaultBinding;
}
function validatePolicy(value: unknown): AclState | null {
  if (value === null) return null;
  if (!record(value) || !identity(value.vaultId)) throw new VaultBindingError();
  return validateAcl(value, value.vaultId);
}

/** Open under instance ownership. Only the instance binding is published.
 * ACL bytes remain read-only, including when adopting their existing ID.
 * A caller about to modify the ACL also checks that its grantees still exist. */
export function bindSingleVault(
  instanceRoot: string,
  aclFilename: string,
  assertOwnership: () => void,
  accounts?: AccountRepository,
) {
  try {
    if (
      typeof assertOwnership !== "function" ||
      Object.prototype.toString.call(assertOwnership) ===
        "[object AsyncFunction]"
    ) throw new TypeError("Binding ownership must be synchronous.");
    const owned = () => {
      const result: unknown = assertOwnership();
      if (result != null) {
        const then = (result as { then?: unknown }).then;
        if (typeof then === "function") {
          Reflect.apply(then, result, [() => undefined, () => undefined]);
          throw new TypeError("Binding ownership must be synchronous.");
        }
      }
    };
    owned();
    const file = new IdentityFile<SingleVaultBinding | null>(
      join(instanceRoot, "single-vault.json"),
      validateBinding,
      null,
    );
    const acl = new IdentityFile<AclState | null>(
      aclFilename,
      validatePolicy,
      null,
    );
    const before = file.capture(), policy = acl.capture();
    // Stored JSON null is corrupt, not an absent record.
    if (
      before.persistence.raw !== null && before.value === null ||
      policy.persistence.raw !== null && policy.value === null
    ) throw new VaultBindingError();
    const binding = before.value ?? Object.freeze({
      version: 1 as const,
      id: policy.value?.vaultId ?? createUuid(),
      createdAt: new Date(Date.now()).toISOString(),
    });
    if (policy.value && policy.value.vaultId !== binding.id) {
      throw new VaultBindingError();
    }
    const guard = () => {
      owned();
      acl.assertUnchanged(policy);
      if (accounts && policy.value) {
        assertKnownAclGrantees(accounts, policy.value.grants);
      }
    };
    guard();
    file.assertUnchanged(before);
    const value = before.persistence.raw === null
      ? file.commit(binding, before, guard)!
      : binding;
    const expected = file.capture();
    return Object.freeze({
      value,
      assertCurrent: () => {
        owned();
        file.assertUnchanged(expected);
      },
    });
  } catch (cause) {
    throw new VaultBindingError({ cause });
  }
}

export function openSingleVaultBinding(
  instanceRoot: string,
  aclFilename: string,
  assertOwnership: () => void,
): SingleVaultBinding {
  return bindSingleVault(instanceRoot, aclFilename, assertOwnership).value;
}
