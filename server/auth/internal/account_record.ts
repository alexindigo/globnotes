// SPDX-License-Identifier: LGPL-3.0-only
/** Stored DTO/codec only. Ordinary directory and ACL consumers use AccountIdentity. */
import {
  decodeStoredAuthenticator,
  type TotpKeyEncoding,
} from "../credentials.ts";
import { parseLoginName } from "../login_name.ts";
import {
  fields,
  identity,
  type IdentitySnapshot,
  IdentityStateError,
  integer,
  record,
} from "../records.ts";
export interface Account {
  readonly id: string;
  readonly login: string;
  readonly passwordHash: string;
  readonly totpKey: string | null;
  readonly totpKeyEncoding?: TotpKeyEncoding;
  readonly lastTotpStep: number | null;
  readonly credentialRevision: number;
  readonly passwordChangeRequired: boolean;
  readonly credentialUpdateId: string | null;
}
export interface ProvisioningReceipt {
  readonly operationId: string;
  readonly actorId: string;
  readonly vaultId: string;
  readonly accountId: string;
  readonly payloadHash: string;
  readonly committed: true;
  readonly level: "none" | "view" | "edit" | "admin";
  readonly aclUpdateId: string;
}
export interface ProvisioningFailure {
  readonly operationId: string;
  readonly actorId: string;
  readonly vaultId: string;
  readonly committed: false;
}
export type ProvisioningOutcome = ProvisioningReceipt | ProvisioningFailure;
export interface AccountState {
  readonly version: 1;
  readonly revision: number;
  readonly initialized: boolean;
  readonly configuredSeedPending?: true;
  readonly updateId: string | null;
  readonly accounts: readonly Account[];
  readonly provisioning: readonly ProvisioningOutcome[];
}
export type AccountSnapshot = IdentitySnapshot<AccountState>;
export function normalizeLogin(value: string): string {
  const login = parseLoginName(value);
  if (login === null) throw new IdentityStateError();
  return login;
}
function validPasswordHash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^pbkdf2_sha256\$([1-9][0-9]*)\$([0-9a-f]+)\$([0-9a-f]{64})$/
    .exec(value);
  return !!match && Number.isSafeInteger(Number(match[1])) &&
    match[2].length % 2 === 0;
}
export function validateAccount(value: unknown): Account {
  if (
    !record(value) ||
    !fields(value, [
      "id",
      "login",
      "passwordHash",
      "totpKey",
      "lastTotpStep",
      "credentialRevision",
      "passwordChangeRequired",
      "credentialUpdateId",
      ...(Object.hasOwn(value, "totpKeyEncoding") ? ["totpKeyEncoding"] : []),
    ]) || !identity(value.id) || typeof value.login !== "string" ||
    normalizeLogin(value.login) !== value.login ||
    !validPasswordHash(value.passwordHash) ||
    !integer(value.credentialRevision) ||
    typeof value.passwordChangeRequired !== "boolean" ||
    !(value.credentialUpdateId === null || identity(value.credentialUpdateId))
  ) throw new IdentityStateError();
  decodeStoredAuthenticator(
    value.totpKey,
    value.totpKeyEncoding,
    value.lastTotpStep,
  );
  return value as unknown as Account;
}
export function validateState(value: unknown): AccountState {
  if (
    !record(value) ||
    !fields(value, [
      "version",
      "revision",
      "initialized",
      "updateId",
      "accounts",
      "provisioning",
      ...(Object.hasOwn(value, "configuredSeedPending")
        ? ["configuredSeedPending"]
        : []),
    ]) || value.version !== 1 || !integer(value.revision) ||
    typeof value.initialized !== "boolean" ||
    !(value.updateId === null || identity(value.updateId)) ||
    !Array.isArray(value.accounts) || !Array.isArray(value.provisioning)
  ) throw new IdentityStateError();
  const accounts = value.accounts.map(validateAccount);
  if (Object.hasOwn(value, "configuredSeedPending")) {
    const [seed] = accounts;
    if (
      value.configuredSeedPending !== true || !value.initialized ||
      value.revision !== 1 || !identity(value.updateId) ||
      accounts.length !== 1 || value.provisioning.length !== 0 ||
      seed.credentialRevision !== 0 || seed.credentialUpdateId !== null ||
      seed.passwordChangeRequired || seed.totpKey !== null ||
      Object.hasOwn(seed, "totpKeyEncoding") || seed.lastTotpStep !== null
    ) throw new IdentityStateError();
  }
  if (
    new Set(accounts.map((a) => a.id)).size !== accounts.length ||
    new Set(accounts.map((a) => a.login)).size !== accounts.length ||
    (!value.initialized && accounts.length > 0)
  ) throw new IdentityStateError();
  const operations = new Set<string>();
  for (const receipt of value.provisioning) {
    if (
      !record(receipt) || !identity(receipt.operationId) ||
      !identity(receipt.vaultId) || !identity(receipt.actorId) ||
      !accounts.some((a) => a.id === receipt.actorId) ||
      operations.has(receipt.operationId)
    ) throw new IdentityStateError();
    operations.add(receipt.operationId);
    if (receipt.committed === false) {
      if (
        !fields(receipt, ["operationId", "actorId", "vaultId", "committed"])
      ) {
        throw new IdentityStateError();
      }
      continue;
    }
    if (
      !fields(receipt, [
        "operationId",
        "actorId",
        "vaultId",
        "accountId",
        "payloadHash",
        "committed",
        "level",
        "aclUpdateId",
      ]) || !identity(receipt.accountId) ||
      !accounts.some((a) => a.id === receipt.accountId) ||
      receipt.committed !== true || !identity(receipt.aclUpdateId) ||
      !["none", "view", "edit", "admin"].includes(receipt.level as string) ||
      typeof receipt.payloadHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(receipt.payloadHash)
    ) throw new IdentityStateError();
  }
  return value as unknown as AccountState;
}
