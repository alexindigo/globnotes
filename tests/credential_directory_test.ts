// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { AccountRepository } from "../server/auth/accounts.ts";
import { AclRepository, prepareInitialAcl } from "../server/auth/acl.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import {
  importFixtureAccount,
  recoveryForRoot,
} from "./helpers/account_preparation.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  VAULT_A,
} from "./helpers/identity.ts";
Deno.test("credential directory: every public query and snapshot is redacted and immutable", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    const imported = importFixtureAccount(
      accounts,
      identityAccount({ totpKey: "fixture-secret", lastTotpStep: 100 }),
    );
    const expectedKeys = [
      "credentialRevision",
      "credentialUpdateId",
      "id",
      "login",
      "passwordChangeRequired",
      "totpEnabled",
    ];
    for (
      const account of [
        imported,
        accounts.byId(ACCOUNT_A)!,
        accounts.byLogin(" ALICE ")!,
        accounts.identityById(ACCOUNT_A)!,
        accounts.capture().value.accounts[0],
      ]
    ) {
      assertEquals(Object.keys(account).sort(), expectedKeys);
      assert(Object.isFrozen(account));
      assert(account.totpEnabled);
      assertThrows(
        () => Object.assign(account, { login: "replacement" }),
        TypeError,
      );
    }
    const snapshot = accounts.capture();
    assertEquals(Object.keys(snapshot), ["value"]);
    assert(!JSON.stringify(snapshot).includes("fixture-secret"));
    assert(!JSON.stringify(snapshot).includes("passwordHash"));
    assert(Object.isFrozen(snapshot.value.accounts));
    // assertUnchanged accepts only this exact snapshot object.
    assertStrictEquals(accounts.capture(), snapshot);
    assertStrictEquals(accounts.byId(ACCOUNT_A), snapshot.value.accounts[0]);
    assertThrows(
      () => accounts.assertUnchanged({ ...snapshot }),
      StoredConfigConflict,
    );
    accounts.assertUnchanged(snapshot);
    importFixtureAccount(
      accounts,
      identityAccount({ id: ACCOUNT_B, login: "bob" }),
    );
    assertThrows(
      () => accounts.assertUnchanged(snapshot),
      StoredConfigConflict,
    );
    assertEquals(snapshot.value.accounts.length, 1);
  }));

Deno.test("credential import: recovery lock remains a parent through the actual publication fence", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    importFixtureAccount(accounts, identityAccount());
    const owner = recoveryForRoot(root);
    const before = Deno.readTextFileSync(`${root}/accounts.json`),
      read = Deno.readTextFileSync;
    let staged = false;
    Deno.readTextFileSync = (file) => {
      const value = read(file);
      if (String(file).startsWith(`${root}/.config-`)) {
        staged = true;
        owner.close();
      }
      return value;
    };
    try {
      assertThrows(
        () =>
          accounts.credentials.importAccount(
            owner.authority,
            identityAccount({ id: ACCOUNT_B, login: "bob" }),
          ),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      Deno.readTextFileSync = read;
      owner.close();
    }
    assertEquals(staged, true);
    assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), before);
    assertEquals(
      accounts.capture().value.accounts.map((account) => account.login),
      ["alice"],
    );
  }));
Deno.test("credential directory: ACL preparation accepts only redacted account facts", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    const creator = importFixtureAccount(accounts, identityAccount());
    const initial = prepareInitialAcl(VAULT_A, creator, "none");
    assertEquals(initial.grants, { [ACCOUNT_A]: "admin" });
    const acl = new AclRepository(`${root}/vault`, VAULT_A, { accounts });
    acl.initializeForCreator(creator, "none");
    assertEquals(acl.capture().value.grants, initial.grants);
    assertThrows(
      () =>
        prepareInitialAcl(
          VAULT_A,
          { ...creator, passwordHash: "not-an-ACL-input" } as typeof creator,
          "none",
        ),
      IdentityStateError,
    );
    assertThrows(
      () =>
        prepareInitialAcl(
          VAULT_A,
          { ...creator, passwordChangeRequired: true },
          "none",
        ),
      IdentityStateError,
    );
    const typeContract = () => {
      // @ts-expect-error The directory cannot disclose credential fields.
      accounts.byId(ACCOUNT_A)!.passwordHash;
      // @ts-expect-error There are no stored bytes on a public snapshot.
      accounts.capture().persistence;
      // @ts-expect-error Raw stored account fields are not an ACL input.
      prepareInitialAcl(VAULT_A, identityAccount(), "none");
    };
    void typeContract;
  }));
