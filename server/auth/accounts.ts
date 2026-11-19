// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { hashPassword } from "../helpers.ts";
import { StoredConfigConflict } from "../config/file_store.ts";
import {
  fields,
  identity,
  IdentityFile,
  type IdentitySnapshot,
  IdentityStateError,
  integer,
  record,
} from "./records.ts";

export interface Account {
  readonly id: string;
  readonly login: string;
  readonly passwordHash: string;
  readonly totpKey: string | null;
  readonly lastTotpStep: number | null;
  readonly credentialRevision: number;
  readonly passwordChangeRequired: boolean;
  readonly credentialUpdateId: string | null;
}
/** Snapshot returned by current-credential confirmation, not a session lifetime. */
export type CredentialProof = Pick<
  Account,
  "id" | "credentialRevision" | "totpKey" | "lastTotpStep"
>;
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
  if (!login || login === "guest" || control) {
    throw new IdentityStateError();
  }
  return login;
}
export function validPasswordHash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^pbkdf2_sha256\$([1-9][0-9]*)\$([0-9a-f]+)\$([0-9a-f]{64})$/
    .exec(value);
  return !!match && Number.isSafeInteger(Number(match[1])) &&
    match[2].length % 2 === 0;
}
export function validateAccount(value: unknown): Account {
  if (
    !record(value) || !fields(value, [
      "id",
      "login",
      "passwordHash",
      "totpKey",
      "lastTotpStep",
      "credentialRevision",
      "passwordChangeRequired",
      "credentialUpdateId",
    ]) || !identity(value.id) || typeof value.login !== "string" ||
    normalizeLogin(value.login) !== value.login ||
    !validPasswordHash(value.passwordHash) ||
    !(value.totpKey === null ||
      (typeof value.totpKey === "string" && value.totpKey.length > 0)) ||
    !(value.lastTotpStep === null || integer(value.lastTotpStep)) ||
    (value.totpKey === null && value.lastTotpStep !== null) ||
    !integer(value.credentialRevision) ||
    typeof value.passwordChangeRequired !== "boolean" ||
    !(value.credentialUpdateId === null || identity(value.credentialUpdateId))
  ) throw new IdentityStateError();
  return value as unknown as Account;
}
function validateState(value: unknown): AccountState {
  if (
    !record(value) || !fields(value, [
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
      !record(receipt) || !fields(receipt, [
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

/** Hash outside the repository's short synchronous commit boundary. */
export async function prepareAccount(
  login: string,
  password: string,
  options: {
    temporary?: boolean;
    hash?: (password: string) => Promise<string>;
  } = {},
): Promise<Account> {
  const normalized = normalizeLogin(login);
  if (!password) throw new IdentityStateError();
  return Object.freeze(validateAccount({
    id: createUuid(),
    login: normalized,
    passwordHash: await (options.hash ?? hashPassword)(password),
    totpKey: null,
    lastTotpStep: null,
    credentialRevision: 0,
    passwordChangeRequired: options.temporary ?? false,
    credentialUpdateId: null,
  }));
}

/** Instance-owned records. Synchronous commits serialize effects in one process;
 * slow proof/hash preparation happens before capture revalidation, never inside it. */
export class AccountRepository {
  readonly #file: IdentityFile<AccountState>;
  constructor(
    root: string,
    file = new IdentityFile<AccountState>(
      join(root, "accounts.json"),
      validateState,
      {
        version: 1,
        revision: 0,
        initialized: false,
        updateId: null,
        accounts: [],
        provisioning: [],
      },
    ),
  ) {
    this.#file = file;
  }
  capture(): AccountSnapshot {
    return this.#file.capture();
  }
  assertUnchanged(expected = this.capture()): void {
    this.#file.assertUnchanged(expected);
  }
  prepareParents(): void {
    this.#file.prepareParents();
  }
  get initialized(): boolean {
    return this.capture().value.initialized;
  }
  byId(id: string): Account | null {
    return this.capture().value.accounts.find((a) => a.id === id) ?? null;
  }
  byLogin(login: string): Account | null {
    const normalized = normalizeLogin(login);
    return this.capture().value.accounts.find((a) => a.login === normalized) ??
      null;
  }
  create(
    account: Account,
    expected = this.capture(),
    guard: () => void = () => {},
  ): Account {
    validateAccount(account);
    if (
      expected.value.accounts.some((a) =>
        a.id === account.id || a.login === account.login
      )
    ) {
      throw new StoredConfigConflict();
    }
    this.#file.commit(
      {
        ...expected.value,
        initialized: true,
        revision: expected.value.revision + 1,
        updateId: createUuid(),
        accounts: [...expected.value.accounts, account],
      },
      expected,
      guard,
    );
    return this.byId(account.id)!;
  }
  /** Host-only validated import seam, never an HTTP hash/password endpoint. */
  importAccount(account: Account, expected = this.capture()): Account {
    return this.create(account, expected);
  }
  #assertCredentialProof(
    account: Account | null,
    proof: CredentialProof,
  ): void {
    if (
      !account || account.id !== proof.id ||
      account.credentialRevision !== proof.credentialRevision ||
      account.totpKey !== proof.totpKey ||
      account.lastTotpStep !== proof.lastTotpStep
    ) throw new StoredConfigConflict();
  }
  /** Recheck an admitted proof at final disclosure after asynchronous work. */
  assertCredentialProof(proof: CredentialProof): void {
    const expected = this.capture();
    this.#assertCredentialProof(
      expected.value.accounts.find((account) => account.id === proof.id) ??
        null,
      proof,
    );
    this.#file.assertUnchanged(expected);
  }
  changeCredentials(
    id: string,
    credentialRevision: number,
    changes: Partial<
      Pick<Account, "passwordHash" | "totpKey" | "passwordChangeRequired">
    >,
    updateId: string,
    guard: () => void = () => {},
    confirmedTotpStep?: number,
    proof?: CredentialProof,
  ): Account {
    const expected = this.capture(), account = this.byId(id);
    if (
      Object.keys(changes).some((key) =>
        !["passwordHash", "totpKey", "passwordChangeRequired"].includes(key)
      )
    ) {
      throw new IdentityStateError();
    }
    if (!account || account.credentialRevision !== credentialRevision) {
      throw new StoredConfigConflict();
    }
    if (proof) this.#assertCredentialProof(account, proof);
    if (
      confirmedTotpStep !== undefined && changes.totpKey === account.totpKey &&
      account.lastTotpStep !== null &&
      (confirmedTotpStep < account.lastTotpStep ||
        confirmedTotpStep === account.lastTotpStep &&
          (!proof || confirmedTotpStep !== proof.lastTotpStep))
    ) {
      throw new StoredConfigConflict();
    }
    const next = validateAccount({
      ...account,
      ...changes,
      lastTotpStep: confirmedTotpStep ?? (
        changes.totpKey !== undefined && changes.totpKey !== account.totpKey
          ? null
          : account.lastTotpStep
      ),
      credentialRevision: account.credentialRevision + 1,
      credentialUpdateId: updateId,
    });
    this.#file.commit(
      {
        ...expected.value,
        revision: expected.value.revision + 1,
        updateId,
        accounts: expected.value.accounts.map((a) => a.id === id ? next : a),
      },
      expected,
      guard,
    );
    return this.byId(id)!;
  }
  consumeTotp(id: string, credentialRevision: number, step: number): Account {
    const expected = this.capture(), account = this.byId(id);
    if (
      !account?.totpKey || account.credentialRevision !== credentialRevision ||
      !integer(step) ||
      (account.lastTotpStep !== null && step <= account.lastTotpStep)
    ) throw new StoredConfigConflict();
    const consumed = Object.freeze({ ...account, lastTotpStep: step });
    this.#file.commit({
      ...expected.value,
      revision: expected.value.revision + 1,
      updateId: createUuid(),
      accounts: expected.value.accounts.map((a) => a.id === id ? consumed : a),
    }, expected);
    return consumed;
  }
}
