// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { AccountRepository, validateAccount } from "../server/auth/accounts.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import {
  identityAccount,
  identityFixture,
  UPDATE,
} from "./helpers/identity.ts";

Deno.test("stored TOTP fixed form: marked keys validate at create, import, change and reopen without repair", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    const account = accounts.create(identityAccount());
    const filename = `${root}/accounts.json`;
    const original = Deno.readTextFileSync(filename);
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
      assertThrows(() => accounts.create(malformed), IdentityStateError);
      assertThrows(() => accounts.importAccount(malformed), IdentityStateError);
      assertThrows(
        () =>
          accounts.changeCredentials(account.id, 0, {
            totpKey: key,
            totpKeyEncoding: "base32",
          }, UPDATE),
        IdentityStateError,
      );
      assertEquals(Deno.readTextFileSync(filename), original);
      const bytes = JSON.stringify({
        ...accounts.capture().value,
        accounts: [malformed],
      });
      Deno.writeTextFileSync(filename, bytes);
      assertThrows(() => new AccountRepository(root), IdentityStateError);
      assertEquals(Deno.readTextFileSync(filename), bytes);
      Deno.writeTextFileSync(filename, original);
    }
    accounts.changeCredentials(account.id, 0, {
      totpKey: "A".repeat(32),
      totpKeyEncoding: "base32",
    }, UPDATE);
    assertEquals(
      new AccountRepository(root).byId(account.id)?.totpKeyEncoding,
      "base32",
    );
    assertThrows(
      () =>
        accounts.changeCredentials(
          account.id,
          1,
          { totpKeyEncoding: null },
          UPDATE,
        ),
      IdentityStateError,
    );
    accounts.changeCredentials(account.id, 1, { totpKey: null }, UPDATE);
    assertEquals(accounts.storedAuthenticator(account.id), { kind: "none" });
    assertEquals(accounts.byId(account.id)?.lastTotpStep, null);
  }));
