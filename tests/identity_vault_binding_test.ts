// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  openSingleVaultBinding,
  VaultBindingError,
} from "../server/config/vault_binding.ts";
import { identityFixture, VAULT_A, VAULT_B } from "./helpers/identity.ts";

const saved = {
  version: 1,
  id: VAULT_A,
  createdAt: "2026-11-17T11:22:00.000Z",
};
const policy = (vaultId = VAULT_A) => ({
  version: 1,
  vaultId,
  revision: 1,
  updateId: null,
  updateActorId: null,
  everybody: "view",
  grants: {},
});
function fixture(run: (root: string, open: () => typeof saved) => void) {
  return identityFixture((root) => {
    Deno.mkdirSync(`${root}/instance`);
    Deno.mkdirSync(`${root}/vault`);
    run(root, () =>
      openSingleVaultBinding(
        `${root}/instance`,
        `${root}/vault/access.json`,
        () => {},
      ));
  });
}
Deno.test("single-vault binding: fresh identity persists without accounts or ACL", () =>
  fixture((root, open) => {
    const binding = open();
    assertEquals(
      JSON.parse(Deno.readTextFileSync(`${root}/instance/single-vault.json`)),
      binding,
    );
    assertEquals(Object.keys(binding).sort(), ["createdAt", "id", "version"]);
    assertEquals(Object.isFrozen(binding), true);
    assertEquals([...Deno.readDirSync(`${root}/instance`)].map((e) => e.name), [
      "single-vault.json",
    ]);
    assertEquals([...Deno.readDirSync(`${root}/vault`)], []);
    assertEquals(
      Deno.statSync(`${root}/instance/single-vault.json`).mode! & 0o777,
      0o600,
    );
    assertEquals(open(), binding);
  }));
Deno.test("single-vault binding: persisted binding and creation record are unchanged", () =>
  fixture((root, open) => {
    const raw = JSON.stringify(saved);
    Deno.writeTextFileSync(`${root}/instance/single-vault.json`, raw);
    const ino = Deno.statSync(`${root}/instance/single-vault.json`).ino;
    assertEquals(open(), saved);
    assertEquals([
      Deno.readTextFileSync(`${root}/instance/single-vault.json`),
      Deno.statSync(`${root}/instance/single-vault.json`).ino,
    ], [raw, ino]);
  }));
Deno.test("single-vault binding: adopt valid ACL ID without changing its bytes or inode", () =>
  fixture((root, open) => {
    const raw = JSON.stringify(policy());
    Deno.writeTextFileSync(`${root}/vault/access.json`, raw);
    const ino = Deno.statSync(`${root}/vault/access.json`).ino;
    assertEquals(open().id, VAULT_A);
    assertEquals([
      Deno.readTextFileSync(`${root}/vault/access.json`),
      Deno.statSync(`${root}/vault/access.json`).ino,
    ], [raw, ino]);
    assertEquals(
      JSON.parse(Deno.readTextFileSync(`${root}/instance/single-vault.json`))
        .id,
      VAULT_A,
    );
  }));
for (
  const [name, raw] of Object.entries({
    malformed: "broken",
    null: "null",
    version: JSON.stringify({ ...saved, version: 2 }),
    timestamp: JSON.stringify({ ...saved, createdAt: "not-a-date" }),
    noncanonical: JSON.stringify({ ...saved, createdAt: "2026-11-17" }),
    foreign: JSON.stringify({ ...saved, extra: "foreign" }),
  })
) {
  Deno.test(`single-vault binding: corrupt ${name} record is not repaired`, () =>
    fixture((root, open) => {
      Deno.writeTextFileSync(`${root}/instance/single-vault.json`, raw);
      assertThrows(
        open,
        VaultBindingError,
        "Single-vault binding requires operator recovery",
      );
      assertEquals(
        Deno.readTextFileSync(`${root}/instance/single-vault.json`),
        raw,
      );
      assertEquals([...Deno.readDirSync(`${root}/vault`)], []);
    }));
}
for (
  const [name, raw] of Object.entries({
    malformed: "broken",
    null: "null",
    partial: JSON.stringify({ version: 1, vaultId: VAULT_A }),
    invalid: JSON.stringify({ ...policy(), everybody: "admin" }),
  })
) {
  Deno.test(`single-vault binding: corrupt ${name} ACL cannot seed an identity`, () =>
    fixture((root, open) => {
      Deno.writeTextFileSync(`${root}/vault/access.json`, raw);
      assertThrows(
        open,
        VaultBindingError,
        "Single-vault binding requires operator recovery",
      );
      assertEquals(Deno.readTextFileSync(`${root}/vault/access.json`), raw);
      assertEquals([...Deno.readDirSync(`${root}/instance`)], []);
    }));
}
Deno.test("single-vault binding: mismatched ACL preserves both records", () =>
  fixture((root, open) => {
    const binding = JSON.stringify(saved),
      acl = JSON.stringify(policy(VAULT_B));
    Deno.writeTextFileSync(`${root}/instance/single-vault.json`, binding);
    Deno.writeTextFileSync(`${root}/vault/access.json`, acl);
    assertThrows(
      open,
      VaultBindingError,
      "Single-vault binding requires operator recovery",
    );
    assertEquals([
      Deno.readTextFileSync(`${root}/instance/single-vault.json`),
      Deno.readTextFileSync(`${root}/vault/access.json`),
    ], [binding, acl]);
  }));
Deno.test("single-vault binding: unreadable binding refuses without replacement", () =>
  fixture((root, open) => {
    const filename = `${root}/instance/single-vault.json`,
      raw = JSON.stringify(saved);
    Deno.writeTextFileSync(filename, raw);
    const read = Deno.readTextFileSync;
    try {
      Deno.readTextFileSync = (file) => {
        if (String(file) === filename) {
          throw new Deno.errors.PermissionDenied("fixture");
        }
        return read(file);
      };
      assertThrows(
        open,
        VaultBindingError,
        "Single-vault binding requires operator recovery",
      );
    } finally {
      Deno.readTextFileSync = read;
    }
    assertEquals(read(filename), raw);
  }));

for (const kind of ["retired", "async", "thenable"] as const) {
  Deno.test(`single-vault binding: ${kind} ownership cannot create state`, () =>
    fixture((root) => {
      let entered = 0;
      const ownership = kind === "async"
        ? async () => {
          entered++;
          await Promise.resolve();
        }
        : () => {
          entered++;
          if (kind === "retired") throw new Error("fixture owner retired");
          return Promise.reject(new Error("fixture asynchronous rejection"));
        };
      assertThrows(
        () =>
          openSingleVaultBinding(
            `${root}/instance`,
            `${root}/vault/access.json`,
            ownership,
          ),
        VaultBindingError,
        "Single-vault binding requires operator recovery",
      );
      assertEquals(entered, kind === "async" ? 0 : 1);
      assertEquals([...Deno.readDirSync(`${root}/instance`)], []);
      assertEquals([...Deno.readDirSync(`${root}/vault`)], []);
    }));
}
