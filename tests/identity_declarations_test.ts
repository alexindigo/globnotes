// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { AclRepository } from "../server/auth/acl.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import { type AccountPrincipal, GUEST } from "../server/auth/sessions.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
  VAULT_A,
  VAULT_B,
} from "./helpers/identity.ts";

const principal = (accountId: string): AccountPrincipal => ({
  kind: "account",
  accountId,
  credentialRevision: 0,
  signingRevision: 1,
  expiresAt: 1_900_000_000_000,
  passwordChangeRequired: false,
});

Deno.test("identity declarations: missing login stays pending; the eventual account immediately becomes Admin", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root),
      acl = new AclRepository(`${root}/vault`, VAULT_A, {
        accounts,
        declaredAdmin: " ALICE ",
      });
    assertEquals(acl.declaredAdmin, {
      login: "alice",
      accountId: null,
      pending: true,
      pinned: true,
    });
    assertEquals(acl.effectiveLevel(GUEST), "none");
    assertEquals([...Deno.readDirSync(root)], []);
    accounts.create(identityAccount());
    assertEquals(acl.declaredAdmin.pending, false);
    assertEquals(acl.effectiveLevel(principal(ACCOUNT_A)), "admin");
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [
      "accounts.json",
    ]);
    assertEquals(
      new AclRepository(`${root}/vault`, VAULT_A, {
        accounts: new AccountRepository(root),
        declaredAdmin: "alice",
      }).effectiveLevel(principal(ACCOUNT_A)),
      "admin",
    );
  }));

Deno.test("identity declarations: configured Admin is independent of saved grants and removal changes only the overlay", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    accounts.create(identityAccount());
    accounts.create(identityAccount({ id: ACCOUNT_B, login: "bob" }));
    const acl = new AclRepository(`${root}/vault`, VAULT_A, {
      accounts,
      declaredAdmin: "alice",
    });
    acl.save(
      {
        everybody: "edit",
        grants: { [ACCOUNT_A]: "none", [ACCOUNT_B]: "view" },
      },
      acl.capture(),
      { updateId: UPDATE, actorId: ACCOUNT_A },
    );
    const raw = Deno.readTextFileSync(`${root}/vault/access.json`);
    assertEquals(acl.effectiveLevel(principal(ACCOUNT_A)), "admin");
    const removed = new AclRepository(`${root}/vault`, VAULT_A, { accounts });
    assertEquals(removed.effectiveLevel(principal(ACCOUNT_A)), "none");
    assertEquals(removed.effectiveLevel(principal(ACCOUNT_B)), "view");
    assertEquals(removed.effectiveLevel(GUEST), "edit");
    assertEquals(Deno.readTextFileSync(`${root}/vault/access.json`), raw);
  }));

Deno.test("identity declarations: separate vault policy keys do not track unrelated account credential writes", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(root);
    accounts.create(identityAccount());
    accounts.create(identityAccount({ id: ACCOUNT_B, login: "bob" }));
    const a = new AclRepository(`${root}/a`, VAULT_A, {
      accounts,
      declaredAdmin: "alice",
    });
    const b = new AclRepository(`${root}/b`, VAULT_B, {
      accounts,
      declaredAdmin: "bob",
    });
    const key = b.policyKey;
    a.initializeForCreator(identityAccount(), "view");
    accounts.changeCredentials(
      ACCOUNT_A,
      0,
      { passwordChangeRequired: true },
      UPDATE,
    );
    assertEquals(b.policyKey, key);
    assertEquals(b.effectiveLevel(principal(ACCOUNT_A)), "none");
    assertEquals(b.effectiveLevel(principal(ACCOUNT_B)), "admin");
    assertEquals(a.effectiveLevel(principal(ACCOUNT_B)), "view");
  }));
