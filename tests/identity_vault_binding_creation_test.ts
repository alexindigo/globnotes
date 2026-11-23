// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  openSingleVaultBinding,
  VaultBindingError,
} from "../server/config/vault_binding.ts";
import { identityFixture, VAULT_A, VAULT_B } from "./helpers/identity.ts";

for (
  const failure of [
    "ownership",
    "acl",
    "publication",
    "foreign",
    "competing",
    "acl-same-bytes",
  ] as const
) {
  Deno.test(`single-vault binding: exact candidate custody on ${failure} rejection`, () =>
    identityFixture((root) => {
      const instance = `${root}/instance`, acl = `${root}/vault/access.json`;
      Deno.mkdirSync(instance);
      Deno.mkdirSync(`${root}/vault`);
      const filename = `${instance}/single-vault.json`, link = Deno.linkSync;
      let entered = false,
        candidate = "",
        bytes = "",
        inode: number | null = null;
      const winner = JSON.stringify({
        version: 1,
        id: VAULT_B,
        createdAt: "2026-11-17T11:22:00.000Z",
      });
      const originalAcl = JSON.stringify({
        version: 1,
        vaultId: VAULT_A,
        revision: 1,
        updateId: null,
        updateActorId: null,
        everybody: "view",
        grants: {},
      });
      if (failure === "acl-same-bytes") {
        Deno.writeTextFileSync(acl, originalAcl);
      }
      try {
        Deno.linkSync = (from, to) => {
          if (failure === "publication" && String(to) === filename) {
            entered = true;
            throw new Deno.errors.PermissionDenied(
              "fixture publication refused",
            );
          }
          link(from, to);
        };
        assertThrows(
          () =>
            openSingleVaultBinding(instance, acl, () => {
              const candidates = [...Deno.readDirSync(instance)].filter((e) =>
                e.name.startsWith(".config-")
              );
              if (entered || candidates.length === 0) return;
              candidate = `${instance}/${candidates[0].name}`;
              if (failure === "publication") return;
              entered = true;
              if (failure === "ownership") throw Error("fixture owner retired");
              if (failure === "acl") {
                Deno.writeTextFileSync(
                  acl,
                  JSON.stringify({ version: 1, vaultId: VAULT_A }),
                );
              } else if (failure === "acl-same-bytes") {
                Deno.writeTextFileSync(`${root}/foreign-acl`, originalAcl);
                Deno.renameSync(`${root}/foreign-acl`, acl);
                inode = Deno.statSync(acl).ino;
              } else if (failure === "foreign") {
                bytes = Deno.readTextFileSync(candidate);
                Deno.writeTextFileSync(`${root}/foreign`, bytes);
                Deno.renameSync(`${root}/foreign`, candidate);
                inode = Deno.statSync(candidate).ino;
              } else {
                Deno.writeTextFileSync(filename, winner);
                inode = Deno.statSync(filename).ino;
              }
            }),
          VaultBindingError,
          "Single-vault binding requires operator recovery",
        );
      } finally {
        Deno.linkSync = link;
      }
      assertEquals(entered, true);
      assertEquals(
        [...Deno.readDirSync(instance)].map((e) => e.name),
        failure === "foreign"
          ? [candidate.slice(instance.length + 1)]
          : failure === "competing"
          ? ["single-vault.json"]
          : [],
      );
      if (failure === "foreign") {
        assertEquals([
          Deno.readTextFileSync(candidate),
          Deno.statSync(candidate).ino,
        ], [bytes, inode]);
      }
      if (failure === "competing") {
        assertEquals([
          Deno.readTextFileSync(filename),
          Deno.statSync(filename).ino,
        ], [winner, inode]);
      }
      assertEquals(
        [...Deno.readDirSync(`${root}/vault`)].map((e) => e.name),
        failure === "acl" || failure === "acl-same-bytes"
          ? ["access.json"]
          : [],
      );
      if (failure === "acl") {
        assertEquals(JSON.parse(Deno.readTextFileSync(acl)), {
          version: 1,
          vaultId: VAULT_A,
        });
      }
      if (failure === "acl-same-bytes") {
        assertEquals([Deno.readTextFileSync(acl), Deno.statSync(acl).ino], [
          originalAcl,
          inode,
        ]);
      }
    }));
}
