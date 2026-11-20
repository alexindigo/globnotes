// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AccountRepository } from "../server/auth/accounts.ts";
import * as accountExports from "../server/auth/accounts.ts";
import { type OfflineRecoveryAuthority } from "../server/auth/offline_recovery.ts";
import { type LoginProof } from "../server/auth/account_credentials.ts";
import { AuthenticationError } from "../server/auth/sessions.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  importFixtureAccount,
  preparationFixture,
  recoveryForRoot,
} from "./helpers/account_preparation.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  storedAccount,
  storedState,
} from "./helpers/identity.ts";

Deno.test("credential import: validated historical input is captured, redacted and is never a sign-in proof", () =>
  preparationFixture(async (f) => {
    const input = identityAccount({
      totpKey: "key\0",
      totpKeyEncoding: null,
      lastTotpStep: 100,
    });
    const before = structuredClone(input), owner = f.offline();
    try {
      const imported = f.accounts.credentials.importAccount(
        owner.authority,
        input,
      );
      assertEquals(storedAccount(f.accounts, ACCOUNT_A), before);
      assertEquals(Object.keys(imported).sort(), [
        "credentialRevision",
        "credentialUpdateId",
        "id",
        "login",
        "passwordChangeRequired",
        "totpEnabled",
      ]);
      assert(!Object.isFrozen(input));
      Object.assign(input, {
        passwordHash: "changed",
        totpKey: "changed",
        lastTotpStep: 999,
      });
      assertEquals(
        storedAccount(new AccountRepository(f.root), ACCOUNT_A),
        before,
      );
      await assertRejects(
        () => f.sessions.issue(imported as unknown as LoginProof),
        AuthenticationError,
        "Invalid authentication credentials.",
      );
      assertThrows(
        () => f.accounts.credentials.importAccount(owner.authority, before),
        StoredConfigConflict,
        "Stored configuration changed before commit.",
      );
    } finally {
      owner.close();
    }
  }));

Deno.test("credential import: forged, cloned, foreign, released and other-purpose authority never writes", () =>
  preparationFixture(async (f) => {
    const owner = f.offline();
    try {
      for (
        const value of [
          {},
          { ...owner.authority },
          structuredClone(owner.authority),
          f.authority("initial"),
          null,
        ]
      ) {
        assertThrows(
          () =>
            f.accounts.credentials.importAccount(
              value as OfflineRecoveryAuthority,
              identityAccount(),
            ),
          IdentityStateError,
          "Invalid identity state; original bytes retained.",
        );
      }
      await identityFixture((other) => {
        const foreign = recoveryForRoot(other);
        try {
          assertThrows(
            () =>
              f.accounts.credentials.importAccount(
                foreign.authority,
                identityAccount(),
              ),
            IdentityStateError,
            "Invalid identity state; original bytes retained.",
          );
        } finally {
          foreign.close();
        }
      });
    } finally {
      owner.close();
    }
    assertThrows(
      () =>
        f.accounts.credentials.importAccount(
          owner.authority,
          identityAccount(),
        ),
      OwnershipError,
      "Owner is retired",
    );
    assertEquals(f.accounts.capture().value.accounts, []);
    assertThrows(
      () => Deno.statSync(`${f.root}/accounts.json`),
      Deno.errors.NotFound,
    );
  }));

Deno.test("credential import: release at staging rejects before the actual account effect and removes its candidate", () =>
  preparationFixture((f) => {
    const owner = f.offline(), write = Deno.writeTextFileSync;
    let staged = false;
    Deno.writeTextFileSync = (file, data, options) => {
      write(file, data, options);
      if (String(file).startsWith(`${f.root}/.config-`)) {
        staged = true;
        owner.close();
      }
    };
    try {
      assertThrows(
        () =>
          f.accounts.credentials.importAccount(
            owner.authority,
            identityAccount(),
          ),
        OwnershipError,
        "Owner is retired",
      );
    } finally {
      Deno.writeTextFileSync = write;
      owner.close();
    }
    assert(staged);
    assertEquals(f.accounts.capture().value.accounts, []);
    assertThrows(
      () => Deno.statSync(`${f.root}/accounts.json`),
      Deno.errors.NotFound,
    );
    assertEquals(
      [...Deno.readDirSync(f.root)].filter((entry) =>
        entry.name.startsWith(".config-")
      ),
      [],
    );
    return Promise.resolve();
  }));

Deno.test("credential import: reentrant publication has one exact winner, not an overwritten import", () =>
  preparationFixture((f) => {
    const owner = f.offline(), write = Deno.writeTextFileSync;
    let entered = false;
    const winner = identityAccount({ id: ACCOUNT_B, login: "winner" });
    Deno.writeTextFileSync = (file, data, options) => {
      write(file, data, options);
      if (!entered && String(file).startsWith(`${f.root}/.config-`)) {
        entered = true;
        f.accounts.credentials.importAccount(owner.authority, winner);
      }
    };
    try {
      assertThrows(
        () =>
          f.accounts.credentials.importAccount(
            owner.authority,
            identityAccount(),
          ),
        StoredConfigConflict,
        "Stored configuration changed before commit.",
      );
    } finally {
      Deno.writeTextFileSync = write;
      owner.close();
    }
    assert(entered);
    assertEquals(f.accounts.byId(ACCOUNT_A), null);
    assertEquals(storedAccount(f.accounts, ACCOUNT_B), winner);
    assertEquals(f.accounts.capture().value.accounts, [{
      id: ACCOUNT_B,
      login: "winner",
      credentialRevision: 0,
      passwordChangeRequired: false,
      credentialUpdateId: null,
      totpEnabled: false,
    }]);
    return Promise.resolve();
  }));

Deno.test("credential import: malformed records never replace or repair saved credentials", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    importFixtureAccount(accounts, identityAccount());
    const bytes = Deno.readTextFileSync(`${root}/accounts.json`),
      owner = recoveryForRoot(root);
    try {
      for (
        const extra of [
          { passwordHash: "plaintext" },
          { totpKeyEncoding: "base32" },
          { lastTotpStep: 100 },
          { totpKey: "short", totpKeyEncoding: "base32" },
          { committed: true },
          { credentialRevision: -1 },
        ]
      ) {
        assertThrows(
          () =>
            accounts.credentials.importAccount(owner.authority, {
              ...identityAccount({ id: ACCOUNT_B, login: "bob" }),
              ...extra,
            }),
          IdentityStateError,
          "Invalid identity state; original bytes retained.",
        );
      }
      assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), bytes);
      // Rejected inputs leave the same lock owner able to import exactly once.
      const bob = identityAccount({ id: ACCOUNT_B, login: "bob" });
      accounts.credentials.importAccount(owner.authority, bob);
      assertEquals(storedAccount(accounts, ACCOUNT_B), bob);
      assertEquals(
        storedState(accounts).accounts.map((account) => account.id),
        [ACCOUNT_A, ACCOUNT_B],
      );
    } finally {
      owner.close();
    }
  }));

Deno.test("credential import: repository raw ports and credential exports are absent", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    for (
      const name of [
        "create",
        "importAccount",
        "changeCredentials",
        "consumeTotp",
        "storedAuthenticator",
      ]
    ) assertEquals(Reflect.get(accounts, name), undefined);
    for (
      const name of ["prepareAccount", "validateAccount", "validPasswordHash"]
    ) assertEquals(Reflect.get(accountExports, name), undefined);
    const typeContract = () => {
      // @ts-expect-error No caller-selected patch port remains.
      type RawPatch = AccountRepository["changeCredentials"];
      // @ts-expect-error No caller-selected code counter remains.
      type RawCounter = AccountRepository["consumeTotp"];
      // @ts-expect-error Historical account input requires a real offline authority.
      accounts.credentials.importAccount(identityAccount());
      const removed: RawPatch | RawCounter = undefined;
      void removed;
    };
    void typeContract;
  }));
