// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AccountRepository, prepareAccount } from "../server/auth/accounts.ts";
import { IdentityStateError } from "../server/auth/records.ts";
import {
  BoundFileStore,
  StoredConfigConflict,
} from "../server/config/file_store.ts";
import {
  ACCOUNT_B,
  identityAccount,
  identityFixture,
  UPDATE,
} from "./helpers/identity.ts";

Deno.test("accounts: absent read is inert, create is durable and restricted, IDs are stable", () =>
  identityFixture((root) => {
    const repo = new AccountRepository(`${root}/state`);
    assertEquals([...Deno.readDirSync(root)], []);
    const alice = repo.create(identityAccount());
    assertEquals(repo.initialized, true);
    assertEquals(repo.byLogin(" Alice "), alice);
    assert(Object.isFrozen(alice));
    assert(Object.isFrozen(repo.capture().value.accounts));
    assertEquals(new AccountRepository(`${root}/state`).byId(alice.id), alice);
    assertEquals(
      Deno.statSync(`${root}/state/accounts.json`).mode! & 0o777,
      0o600,
    );
    assertThrows(
      () => repo.create(identityAccount({ id: ACCOUNT_B })),
      StoredConfigConflict,
    );
    assertThrows(
      () => repo.create(identityAccount({ login: "other" })),
      StoredConfigConflict,
    );
  }));

Deno.test("accounts: initialized empty state cannot reopen setup", () =>
  identityFixture((root) => {
    Deno.writeTextFileSync(
      `${root}/accounts.json`,
      JSON.stringify({
        version: 1,
        revision: 1,
        initialized: true,
        updateId: UPDATE,
        accounts: [],
        provisioning: [],
      }),
    );
    assertEquals(new AccountRepository(root).initialized, true);
  }));

for (const bad of ["guest", " GUEST ", "", "\n", "bad\0login"]) {
  Deno.test(`accounts: rejects reserved or invalid login ${JSON.stringify(bad)}`, () =>
    identityFixture(async (root) => {
      await assertRejects(
        () => prepareAccount(bad, "password"),
        IdentityStateError,
      );
      assertEquals([...Deno.readDirSync(root)], []);
    }));
}

for (
  const bad of [
    "{bad secret bytes",
    "{}",
    "[]",
    JSON.stringify({ version: 999, password: "fixture-secret" }),
  ]
) {
  Deno.test(`accounts: malformed saved state is retained (${bad.length} bytes)`, () =>
    identityFixture((root) => {
      Deno.writeTextFileSync(`${root}/accounts.json`, bad);
      const error = assertThrows(
        () => new AccountRepository(root),
        IdentityStateError,
      );
      assert(!error.message.includes("fixture-secret"));
      assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), bad);
    }));
}

Deno.test("accounts: unknown fields, duplicate IDs/logins and uninitialized populated state are rejected", () =>
  identityFixture((root) => {
    const repo = new AccountRepository(root);
    repo.create(identityAccount());
    const saved = repo.capture().value;
    for (
      const change of [
        { accounts: [identityAccount({ login: "Alice" })] },
        { accounts: [{ ...identityAccount(), instanceAdmin: true }] },
        { accounts: [identityAccount(), identityAccount({ id: ACCOUNT_B })] },
        { accounts: [identityAccount(), identityAccount({ login: "bob" })] },
        { initialized: false },
        { version: 2 },
        { extra: "secret" },
        { accounts: [identityAccount({ credentialRevision: -1 })] },
        { accounts: [identityAccount({ passwordHash: "plaintext" })] },
      ]
    ) {
      const raw = JSON.stringify({ ...saved, ...change });
      Deno.writeTextFileSync(`${root}/accounts.json`, raw);
      assertThrows(() => new AccountRepository(root), IdentityStateError);
      assertEquals(Deno.readTextFileSync(`${root}/accounts.json`), raw);
    }
  }));

Deno.test("accounts: prepared hash cannot overwrite a concurrent first account", () =>
  identityFixture(async (root) => {
    const repo = new AccountRepository(root), before = repo.capture();
    const held = Promise.withResolvers<string>();
    const preparing = prepareAccount("Bob", "password", {
      hash: () => held.promise,
    });
    repo.create(identityAccount());
    held.resolve(identityAccount().passwordHash);
    const prepared = await preparing;
    assertThrows(() => repo.create(prepared, before), StoredConfigConflict);
    assertEquals(repo.capture().value.accounts.length, 1);
    assertEquals(new AccountRepository(root).byLogin("bob"), null);
  }));

Deno.test("accounts: links, private mode and explicit parent preparation preserve bindings", () =>
  identityFixture((root) => {
    const repo = new AccountRepository(`${root}/state`);
    repo.prepareParents();
    repo.create(identityAccount());
    Deno.renameSync(`${root}/state/accounts.json`, `${root}/real.json`);
    Deno.symlinkSync("../real.json", `${root}/state/accounts.json`);
    const link = Deno.lstatSync(`${root}/state/accounts.json`).ino;
    const linked = new AccountRepository(`${root}/state`);
    linked.create(identityAccount({ id: ACCOUNT_B, login: "bob" }));
    assertEquals(Deno.lstatSync(`${root}/state/accounts.json`).ino, link);
    assertEquals(Deno.statSync(`${root}/real.json`).mode! & 0o777, 0o600);
  }));

for (
  const interference of ["external", "equal-file", "guard", "write", "rename"]
) {
  Deno.test(`accounts: ${interference} failure retains bytes and memory`, () =>
    identityFixture((root) => {
      const repo = new AccountRepository(root);
      repo.create(identityAccount());
      const before = repo.capture(),
        raw = Deno.readTextFileSync(`${root}/accounts.json`);
      const write = Deno.writeTextFileSync, rename = Deno.renameSync;
      try {
        if (interference === "external") {
          write(`${root}/accounts.json`, "external");
        }
        if (interference === "equal-file") {
          write(`${root}/replacement`, raw);
          rename(`${root}/replacement`, `${root}/accounts.json`);
        }
        if (interference === "write") {
          Deno.writeTextFileSync = (() => {
            throw new Deno.errors.PermissionDenied("fixture");
          }) as typeof write;
        }
        if (interference === "rename") {
          Deno.renameSync = (() => {
            throw new Deno.errors.PermissionDenied("fixture");
          }) as typeof rename;
        }
        assertThrows(() =>
          repo.create(
            identityAccount({ id: ACCOUNT_B, login: "bob" }),
            before,
            () => {
              if (interference === "guard") throw new Error("revoked");
            },
          )
        );
        assertEquals(repo.capture(), before);
        assertEquals(
          Deno.readTextFileSync(`${root}/accounts.json`),
          interference === "external" ? "external" : raw,
        );
        assertEquals(
          [...Deno.readDirSync(root)].filter((e) =>
            e.name.startsWith(".config-")
          ),
          [],
        );
      } finally {
        Deno.writeTextFileSync = write;
        Deno.renameSync = rename;
      }
    }));
}

Deno.test("accounts: credential CAS and TOTP consumption have different revisions", () =>
  identityFixture((root) => {
    const repo = new AccountRepository(root);
    const alice = repo.create(
      identityAccount({ totpKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }),
    );
    repo.consumeTotp(alice.id, 0, 100);
    assertEquals(repo.byId(alice.id)?.credentialRevision, 0);
    assertThrows(
      () => repo.consumeTotp(alice.id, 0, 100),
      StoredConfigConflict,
    );
    repo.changeCredentials(
      alice.id,
      0,
      { passwordChangeRequired: false },
      UPDATE,
    );
    assertEquals(repo.byId(alice.id)?.lastTotpStep, 100);
    assertThrows(
      () => repo.changeCredentials(alice.id, 0, {}, UPDATE),
      StoredConfigConflict,
    );
    assertThrows(
      () => repo.consumeTotp(alice.id, 0, 101),
      StoredConfigConflict,
    );
    assertEquals(
      new AccountRepository(root).byId(alice.id)?.credentialRevision,
      1,
    );
  }));

for (const interference of ["unreadable", "equal-file"]) {
  Deno.test(`accounts: committed binding survives ${interference} after publication`, () =>
    identityFixture((root) => {
      const repo = new AccountRepository(root);
      repo.create(identityAccount());
      const capture = BoundFileStore.prototype.capture;
      const rename = Deno.renameSync;
      let published = false, reads = 0;
      try {
        BoundFileStore.prototype.capture = function () {
          if (published && this.filename === `${root}/accounts.json`) {
            reads++;
            if (interference === "unreadable") {
              throw new Error("post-publication capture");
            }
          }
          return capture.call(this);
        };
        Deno.renameSync = ((from, to) => {
          rename(from, to);
          if (String(to) !== `${root}/accounts.json`) return;
          published = true;
          if (interference === "equal-file") {
            Deno.writeTextFileSync(
              `${root}/foreign`,
              Deno.readTextFileSync(to),
            );
            rename(`${root}/foreign`, to);
          }
        }) as typeof rename;
        repo.create(identityAccount({ id: ACCOUNT_B, login: "bob" }));
        assertEquals(reads, 0);
      } finally {
        BoundFileStore.prototype.capture = capture;
        Deno.renameSync = rename;
      }
      assertEquals(
        repo.capture().value,
        JSON.parse(Deno.readTextFileSync(`${root}/accounts.json`)),
      );
      if (interference === "equal-file") {
        assertThrows(
          () => repo.changeCredentials(ACCOUNT_B, 0, {}, UPDATE),
          StoredConfigConflict,
        );
      } else {
        repo.changeCredentials(
          ACCOUNT_B,
          0,
          { passwordChangeRequired: false },
          UPDATE,
        );
        assertEquals(
          new AccountRepository(root).byId(ACCOUNT_B)?.credentialRevision,
          1,
        );
      }
    }));
}
