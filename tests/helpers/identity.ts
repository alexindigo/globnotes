// SPDX-License-Identifier: LGPL-3.0-only
import type { Account } from "../../server/auth/accounts.ts";
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
export async function identityFixture(
  run: (root: string) => Promise<void> | void,
): Promise<void> {
  const root = Deno.makeTempDirSync({ prefix: "identity-" });
  try {
    await run(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}
