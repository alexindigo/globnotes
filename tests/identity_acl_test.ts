// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ACCESS_LEVELS,
  AclRepository,
  prepareInitialAcl,
} from "../server/auth/acl.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import { type AccountPrincipal, GUEST } from "../server/auth/sessions.ts";
import { StoredConfigConflict } from "../server/config/file_store.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
  VAULT_A,
  VAULT_B,
} from "./helpers/identity.ts";

export const principal = (accountId: string): AccountPrincipal => ({
  kind: "account",
  accountId,
  credentialRevision: 0,
  signingRevision: 1,
  expiresAt: 1_900_000_000_000,
  passwordChangeRequired: false,
});

Deno.test("identity ACL: all named levels override, rather than maximize, Everybody else", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    accounts.create(identityAccount());
    accounts.create(identityAccount({ id: ACCOUNT_B, login: "bob" }));
    const acl = new AclRepository(`${root}/vault`, VAULT_A, { accounts });
    assertEquals(acl.effectiveLevel(GUEST), "none");
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [
      "accounts.json",
    ]);
    for (const everybody of ["none", "view", "edit"] as const) {
      for (const grant of ACCESS_LEVELS) {
        acl.save({ everybody, grants: { [ACCOUNT_A]: grant } }, acl.capture(), {
          updateId: UPDATE,
          actorId: ACCOUNT_A,
        });
        assertEquals(acl.effectiveLevel(GUEST), everybody);
        assertEquals(acl.effectiveLevel(principal(ACCOUNT_B)), everybody);
        assertEquals(acl.effectiveLevel(principal(ACCOUNT_A)), grant);
      }
    }
    assertEquals(
      new AclRepository(`${root}/vault`, VAULT_A, { accounts }).effectiveLevel(
        principal(ACCOUNT_A),
      ),
      "admin",
    );
    assertEquals(
      Deno.statSync(`${root}/vault/access.json`).mode! & 0o777,
      0o600,
    );
  }));

Deno.test("identity ACL: guest Admin, malformed grants, unknown account IDs and unknown fields cannot persist", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    accounts.create(identityAccount());
    const acl = new AclRepository(root, VAULT_A, { accounts });
    const before = acl.capture();
    for (
      const values of [
        { everybody: "admin", grants: {} },
        { everybody: "edit", grants: { guest: "admin" } },
        { everybody: "view", grants: { [ACCOUNT_A]: "owner" } },
        { everybody: "none", grants: { [ACCOUNT_B]: "admin" } },
        { everybody: "none", grants: {}, instanceAdmin: true },
      ]
    ) {
      assertThrows(() =>
        acl.save(values as never, before, {
          updateId: UPDATE,
          actorId: ACCOUNT_A,
        }), IdentityStateError);
    }
    assertEquals(acl.capture(), before);
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [
      "accounts.json",
    ]);
  }));

Deno.test("identity ACL: creator/adopter preparation gives only that account Admin, without registry effects", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root),
      creator = accounts.create(identityAccount());
    const acl = new AclRepository(`${root}/vault`, VAULT_A, { accounts });
    const prepared = prepareInitialAcl(VAULT_A, creator, "view");
    assertEquals(prepared.grants, { [creator.id]: "admin" });
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [
      "accounts.json",
    ]);
    acl.initializeForCreator(creator, "view");
    assertEquals(acl.effectiveLevel(principal(creator.id)), "admin");
    assertThrows(
      () => acl.initializeForCreator(creator, "edit"),
      StoredConfigConflict,
    );
    assertThrows(
      () =>
        prepareInitialAcl(
          VAULT_A,
          identityAccount({ passwordChangeRequired: true }),
          "none",
        ),
      IdentityStateError,
    );
    assertThrows(
      () => prepareInitialAcl(VAULT_A, creator, "admin" as never),
      IdentityStateError,
    );
  }));

Deno.test("identity ACL: safe view exposes CAS facts, not private account or filesystem state", () =>
  identityFixture(async (root) => {
    const accounts = new AccountRepository(root);
    accounts.create(identityAccount({ totpKey: "fixture-secret" }));
    const acl = new AclRepository(root, VAULT_A, { accounts });
    const before = await acl.view();
    acl.save(
      { everybody: "edit", grants: { [ACCOUNT_A]: "none" } },
      acl.capture(),
      { updateId: UPDATE, actorId: ACCOUNT_A },
    );
    const after = await acl.view();
    assert(after.signature !== before.signature);
    assertEquals(after.updateId, UPDATE);
    assert(!JSON.stringify(after).includes("fixture-secret"));
    assert(!JSON.stringify(after).includes(root));
    assert(Object.isFrozen(after.grants));
    const stale = acl.capture();
    Deno.writeTextFileSync(`${root}/access.json`, "external");
    await assertRejects(() => acl.view(), StoredConfigConflict);
    assertThrows(
      () =>
        acl.save({ everybody: "none", grants: {} }, stale, {
          updateId: UPDATE,
          actorId: ACCOUNT_A,
        }),
      StoredConfigConflict,
    );
    assertEquals(Deno.readTextFileSync(`${root}/access.json`), "external");
  }));

for (
  const interference of ["equal-file", "retarget", "rename-failure", "guard"]
) {
  Deno.test(`identity ACL: ${interference} retains original state and rejects stale writes`, () =>
    identityFixture((root) => {
      const accounts = new AccountRepository(root);
      accounts.create(identityAccount());
      const acl = new AclRepository(`${root}/vault`, VAULT_A, { accounts });
      acl.initializeForCreator(identityAccount(), "none");
      const before = acl.capture(),
        raw = Deno.readTextFileSync(`${root}/vault/access.json`),
        rename = Deno.renameSync;
      try {
        if (interference === "equal-file") {
          Deno.writeTextFileSync(`${root}/replacement`, raw);
          rename(`${root}/replacement`, `${root}/vault/access.json`);
        }
        if (interference === "retarget") {
          rename(`${root}/vault`, `${root}/old`);
          Deno.symlinkSync("old", `${root}/vault`);
        }
        if (interference === "rename-failure") {
          Deno.renameSync = () => {
            throw new Deno.errors.PermissionDenied("fixture");
          };
        }
        assertThrows(() =>
          acl.save({ everybody: "edit", grants: {} }, before, {
            updateId: UPDATE,
            actorId: ACCOUNT_A,
          }, () => {
            if (interference === "guard") throw new Error("revoked");
          })
        );
        assertEquals(acl.capture(), before);
        assertEquals(Deno.readTextFileSync(`${root}/vault/access.json`), raw);
      } finally {
        Deno.renameSync = rename;
      }
    }));
}

Deno.test("identity ACL: vault bindings and imported records cannot cross owners or grant guest Admin", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root),
      creator = accounts.create(identityAccount());
    const acl = new AclRepository(root, VAULT_A, { accounts });
    const prepared = prepareInitialAcl(VAULT_A, creator, "none");
    assertThrows(
      () => acl.importAcl({ ...prepared, vaultId: VAULT_B }),
      IdentityStateError,
    );
    assertThrows(
      () => acl.importAcl({ ...prepared, everybody: "admin" } as never),
      IdentityStateError,
    );
    acl.importAcl(prepared);
    const raw = Deno.readTextFileSync(`${root}/access.json`);
    assertThrows(
      () => new AclRepository(root, VAULT_B, { accounts }),
      IdentityStateError,
    );
    assertEquals(Deno.readTextFileSync(`${root}/access.json`), raw);
  }));

Deno.test("identity ACL: corrupt existing bytes never become an empty public policy", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    for (const raw of ["{bad", "null", "{}", "[]"]) {
      Deno.writeTextFileSync(`${root}/access.json`, raw);
      assertThrows(
        () => new AclRepository(root, VAULT_A, { accounts }),
        IdentityStateError,
      );
      assertEquals(Deno.readTextFileSync(`${root}/access.json`), raw);
    }
  }));
