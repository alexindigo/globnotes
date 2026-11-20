// SPDX-License-Identifier: LGPL-3.0-only
/** Stored DTO/codec only. Ordinary directory and ACL consumers use AccountIdentity. */
import {
  decodeStoredAuthenticator,
  type TotpKeyEncoding,
} from "../credentials.ts";
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
}
export interface AccountState {
  readonly version: 1;
  readonly revision: number;
  readonly initialized: boolean;
  readonly updateId: string | null;
  readonly accounts: readonly Account[];
  readonly provisioning: readonly ProvisioningReceipt[];
}
export type AccountSnapshot = IdentitySnapshot<AccountState>;
export function normalizeLogin(value: string): string {
  const login = value.trim().toLowerCase();
  const control = [...login].some((char) => {
    const point = char.codePointAt(0)!;
    return point < 32 || point === 127;
  });
  if (!login || login === "guest" || control) throw new IdentityStateError();
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
    ]) || value.version !== 1 || !integer(value.revision) ||
    typeof value.initialized !== "boolean" ||
    !(value.updateId === null || identity(value.updateId)) ||
    !Array.isArray(value.accounts) || !Array.isArray(value.provisioning)
  ) throw new IdentityStateError();
  const accounts = value.accounts.map(validateAccount);
  if (
    new Set(accounts.map((a) => a.id)).size !== accounts.length ||
    new Set(accounts.map((a) => a.login)).size !== accounts.length ||
    (!value.initialized && accounts.length > 0)
  ) throw new IdentityStateError();
  const operations = new Set<string>();
  for (const receipt of value.provisioning) {
    if (
      !record(receipt) ||
      !fields(receipt, [
        "operationId",
        "actorId",
        "vaultId",
        "accountId",
        "payloadHash",
      ]) || !identity(receipt.operationId) || !identity(receipt.actorId) ||
      !identity(receipt.vaultId) || !identity(receipt.accountId) ||
      !accounts.some((a) => a.id === receipt.accountId) ||
      typeof receipt.payloadHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(receipt.payloadHash) ||
      operations.has(receipt.operationId)
    ) throw new IdentityStateError();
    operations.add(receipt.operationId);
  }
  return value as unknown as AccountState;
}
