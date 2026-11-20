// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { AccountRepository } from "../server/auth/accounts.ts";
import { validateAccount } from "../server/auth/internal/account_record.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import {
  disableFixtureAuthenticator,
  importFixtureAccount,
} from "./helpers/account_preparation.ts";
import {
  identityAccount,
  identityFixture,
  storedAccount,
  storedState,
  UPDATE,
} from "./helpers/identity.ts";
Deno.test("stored TOTP fixed form: marked keys validate at private decode, import and reopen without repair", () =>
  identityFixture(async (root) => {
    const accounts = new AccountRepository(root);
    const account = importFixtureAccount(accounts, identityAccount());
    const filename = `${root}/accounts.json`,
      original = Deno.readTextFileSync(filename);
    for (
      const key of [
        "short",
        "a".repeat(32),
        "A".repeat(31),
        "A".repeat(33),
        "A".repeat(31) + "=",
      ]
    ) {
      const malformed = identityAccount({
        totpKey: key,
        totpKeyEncoding: "base32",
      });
      assertThrows(() => validateAccount(malformed), IdentityStateError);
      assertThrows(
        () => importFixtureAccount(accounts, malformed),
        IdentityStateError,
      );
      assertEquals(Deno.readTextFileSync(filename), original);
      const bytes = JSON.stringify({
        ...storedState(accounts),
        accounts: [malformed],
      });
      Deno.writeTextFileSync(filename, bytes);
      assertThrows(() => new AccountRepository(root), IdentityStateError);
      assertEquals(Deno.readTextFileSync(filename), bytes);
      Deno.writeTextFileSync(filename, original);
    }
    const marked = new AccountRepository(`${root}/marked`);
    importFixtureAccount(
      marked,
      identityAccount({ totpKey: "A".repeat(32), totpKeyEncoding: "base32" }),
    );
    assertEquals(
      storedAccount(new AccountRepository(marked.root), account.id)
        .totpKeyEncoding,
      "base32",
    );
    // No encoding-only patch is a stored import or a normal command.
    assertThrows(
      () => importFixtureAccount(marked, { totpKeyEncoding: null }),
      IdentityStateError,
    );
    await disableFixtureAuthenticator(marked, account.id, UPDATE);
    assertEquals(marked.byId(account.id)?.totpEnabled, false);
    assertEquals(storedAccount(marked, account.id).lastTotpStep, null);
  }));
