// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, join } from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { StoredConfigConflict } from "../config/file_store.ts";
import type { OperationLease } from "../operation_lease.ts";
import {
  type AccountCredentials,
  type CredentialOptions,
} from "./account_credentials.ts";
import { bindAccountCredentials } from "./internal/account_credentials.ts";
import {
  authorityRead,
  registerAuthorityReader,
} from "./internal/authority_read.ts";
import {
  decodeStoredAuthenticator,
  type StoredAuthenticator,
} from "./credentials.ts";
import {
  type Account,
  type AccountSnapshot,
  type AccountState,
  normalizeLogin,
  validateAccount,
  validateState,
} from "./internal/account_record.ts";
import {
  fields,
  identity,
  IdentityFile,
  IdentityStateError,
  integer,
  record,
} from "./records.ts";
export { normalizeLogin } from "./internal/account_record.ts";
export interface AccountIdentity {
  readonly id: string;
  readonly login: string;
  readonly credentialRevision: number;
  readonly passwordChangeRequired: boolean;
  readonly credentialUpdateId: string | null;
  readonly totpEnabled: boolean;
}
export function validateAccountIdentity(value: unknown): AccountIdentity {
  if (
    !record(value) ||
    !fields(value, [
      "id",
      "login",
      "credentialRevision",
      "passwordChangeRequired",
      "credentialUpdateId",
      "totpEnabled",
    ]) || !identity(value.id) || typeof value.login !== "string" ||
    normalizeLogin(value.login) !== value.login ||
    !integer(value.credentialRevision) ||
    typeof value.passwordChangeRequired !== "boolean" ||
    typeof value.totpEnabled !== "boolean" ||
    !(value.credentialUpdateId === null || identity(value.credentialUpdateId))
  ) throw new IdentityStateError();
  return value as unknown as AccountIdentity;
}
declare const directoryBrand: unique symbol;
export interface AccountDirectorySnapshot {
  readonly [directoryBrand]: true;
  readonly value: Omit<AccountState, "accounts"> & {
    readonly accounts: readonly AccountIdentity[];
  };
}
/** Repository owns stored records; only its aggregate binding sees credentials. */
export class AccountRepository {
  readonly root: string;
  readonly #file: IdentityFile<AccountState>;
  readonly #authenticators = new WeakMap<Account, StoredAuthenticator>();
  #directory?: { stored: AccountSnapshot; public: AccountDirectorySnapshot };
  readonly #credentials: AccountCredentials;
  readonly #retireCredentials: () => boolean;
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
    credentialOptions: CredentialOptions = {},
  ) {
    this.#file = file;
    const snapshot = this.#file.capture();
    // Recovery and fixture integrations share the same resolved binding as writes.
    this.root = dirname(snapshot.persistence.binding.configured);
    this.capture();
    const owner: ReturnType<typeof bindAccountCredentials> =
      bindAccountCredentials({
        root: this.root,
        capture: () => this.#file.capture(),
        assertSnapshot: (snapshot) => this.#file.assertUnchanged(snapshot),
        normalizeLogin,
        validateAccount,
        byLogin: (login) => this.#byLogin(login),
        byId: (id) => this.#byId(id),
        authenticator: (account) => this.#decode(account),
        identity: (account) => this.#identity(account),
        assertBound: () => this.#file.assertUnchanged(),
        consume: (account, step, guard, lease) =>
          this.#consumeTotp(
            account.id,
            account.credentialRevision,
            step,
            guard,
            [lease],
          ),
        publish: (transition) => {
          const prepared = owner.resolveTransition(transition);
          const next = validateAccount(prepared.account);
          const expected = this.#file.capture();
          this.#file.commit(
            {
              ...expected.value,
              revision: expected.value.revision + 1,
              updateId: next.credentialUpdateId,
              accounts: expected.value.accounts.map((account) =>
                account.id === next.id ? next : account
              ),
            },
            expected,
            () => {
              owner.resolveTransition(transition);
            },
            [prepared.lease],
          );
        },
        create: (prepared) => {
          const value = owner.resolvePreparedAccount(prepared);
          const account = validateAccount(value.account);
          const expected = value.snapshot;
          this.#file.commit(
            {
              ...expected.value,
              initialized: true,
              revision: expected.value.revision + 1,
              updateId: value.updateId,
              accounts: [...expected.value.accounts, account],
            },
            expected,
            () => {
              owner.resolvePreparedAccount(prepared);
            },
            [value.lease],
          );
        },
        participant: (prepared, setId) => {
          const value = owner.resolvePreparedAccount(prepared, setId);
          const expected = value.snapshot;
          return this.#file.prepareParticipant(
            {
              ...expected.value,
              initialized: true,
              revision: expected.value.revision + 1,
              updateId: value.updateId,
              accounts: [
                ...expected.value.accounts,
                validateAccount(value.account),
              ],
              provisioning: value.receipt
                ? [...expected.value.provisioning, value.receipt]
                : expected.value.provisioning,
            },
            expected,
            value.lease,
            setId,
            "accounts",
          );
        },
      }, credentialOptions);
    this.#credentials = owner.credentials;
    this.#retireCredentials = owner.retire;
    registerAuthorityReader(
      this,
      (context) =>
        this.#directorySnapshot(
          authorityRead<AccountSnapshot>(this.#file, context),
        ),
    );
  }
  retireCredentials(): void {
    this.#retireCredentials();
  }
  get credentials(): AccountCredentials {
    return this.#credentials;
  }
  #identity(account: Account): AccountIdentity {
    return Object.freeze({
      id: account.id,
      login: account.login,
      credentialRevision: account.credentialRevision,
      passwordChangeRequired: account.passwordChangeRequired,
      credentialUpdateId: account.credentialUpdateId,
      totpEnabled: this.#decode(account).kind === "totp",
    });
  }
  identityById(id: string): AccountIdentity | null {
    return this.byId(id);
  }
  capture(): AccountDirectorySnapshot {
    return this.#directorySnapshot(this.#file.capture());
  }
  #directorySnapshot(snapshot: AccountSnapshot): AccountDirectorySnapshot {
    if (snapshot !== this.#directory?.stored) {
      const value = Object.freeze({
        ...snapshot.value,
        accounts: Object.freeze(
          snapshot.value.accounts.map((account) => this.#identity(account)),
        ),
      });
      this.#directory = {
        stored: snapshot,
        public: Object.freeze({ value }) as AccountDirectorySnapshot,
      };
    }
    return this.#directory!.public;
  }
  #decode(account: Account): StoredAuthenticator {
    let authenticator = this.#authenticators.get(account);
    if (!authenticator) {
      authenticator = decodeStoredAuthenticator(
        account.totpKey,
        account.totpKeyEncoding,
        account.lastTotpStep,
      );
      this.#authenticators.set(account, authenticator);
    }
    return authenticator;
  }
  assertUnchanged(expected = this.capture()): void {
    if (expected !== this.capture()) throw new StoredConfigConflict();
    this.#file.assertUnchanged(this.#directory!.stored);
  }
  prepareParents(): void {
    this.#file.prepareParents();
  }
  get initialized(): boolean {
    return this.#file.capture().value.initialized;
  }
  #byId(id: string): Account | null {
    return this.#file.capture().value.accounts.find((a) => a.id === id) ?? null;
  }
  #byLogin(login: string): Account | null {
    const normalized = normalizeLogin(login);
    return this.#file.capture().value.accounts.find((a) =>
      a.login === normalized
    ) ?? null;
  }
  byId(id: string): AccountIdentity | null {
    return this.capture().value.accounts.find((a) => a.id === id) ?? null;
  }
  byLogin(login: string): AccountIdentity | null {
    const normalized = normalizeLogin(login);
    return this.capture().value.accounts.find((a) => a.login === normalized) ??
      null;
  }
  #consumeTotp(
    id: string,
    credentialRevision: number,
    step: number,
    guard: () => void = () => {},
    parents: readonly OperationLease<"live">[] = [],
  ): Account {
    const expected = this.#file.capture(), account = this.#byId(id);
    if (
      !account?.totpKey || account.credentialRevision !== credentialRevision ||
      !integer(step) ||
      (account.lastTotpStep !== null && step <= account.lastTotpStep)
    ) throw new StoredConfigConflict();
    const consumed = Object.freeze({ ...account, lastTotpStep: step });
    this.#file.commit(
      {
        ...expected.value,
        revision: expected.value.revision + 1,
        updateId: createUuid(),
        accounts: expected.value.accounts.map((a) =>
          a.id === id ? consumed : a
        ),
      },
      expected,
      guard,
      parents,
    );
    return consumed;
  }
}
