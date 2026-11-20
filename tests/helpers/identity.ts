// SPDX-License-Identifier: LGPL-3.0-only
import { type FixtureScope, fixtureScope } from "./fixture_scope.ts";
import {
  type Account,
  type AccountState,
  normalizeLogin,
} from "../../server/auth/internal/account_record.ts";
import type { AccountRepository } from "../../server/auth/accounts.ts";
import { hashPassword } from "../../server/helpers.ts";
import { createUuid } from "../../shared/uuid.ts";
export const ACCOUNT_A = "00000000-0000-4000-8000-000000000001";
export const ACCOUNT_B = "00000000-0000-4000-8000-000000000002";
export const VAULT_A = "00000000-0000-4000-8000-000000000003";
export const VAULT_B = "00000000-0000-4000-8000-000000000004";
export const UPDATE = "00000000-0000-4000-8000-000000000005";
export function identityAccount(changes: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT_A,
    login: "alice",
    passwordHash: "pbkdf2_sha256$1$00$" + "00".repeat(32),
    totpKey: null,
    lastTotpStep: null,
    credentialRevision: 0,
    passwordChangeRequired: false,
    credentialUpdateId: null,
    ...changes,
  };
}
/** Explicit stored-state observation, never a credential directory projection. */
export function storedState(accounts: AccountRepository): AccountState {
  return JSON.parse(Deno.readTextFileSync(`${accounts.root}/accounts.json`));
}
export function storedAccount(
  accounts: AccountRepository,
  id: string,
): Account {
  const account = storedState(accounts).accounts.find((account) =>
    account.id === id
  );
  if (!account) throw new Error("Missing fixture account");
  return account;
}
export function storedLogin(
  accounts: AccountRepository,
  login: string,
): Account {
  const account = storedState(accounts).accounts.find((account) =>
    account.login === normalizeLogin(login)
  );
  if (!account) throw new Error("Missing fixture account");
  return account;
}
export async function prepareFixtureAccount(
  login: string,
  password: string,
  options: {
    temporary?: boolean;
    hash?: (password: string) => Promise<string>;
  } = {},
): Promise<Account> {
  return identityAccount({
    id: createUuid(),
    login: normalizeLogin(login),
    passwordHash: await (options.hash ?? hashPassword)(password),
    passwordChangeRequired: options.temporary ?? false,
  });
}
export async function identityFixture(
  run: (root: string, scope: FixtureScope) => Promise<void> | void,
): Promise<void> {
  await fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "identity-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    await scope.admit(() => run(root.value, scope));
  });
}
