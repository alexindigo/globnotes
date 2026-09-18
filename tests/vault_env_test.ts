// SPDX-License-Identifier: LGPL-3.0-only

import { assertEquals, assertThrows } from "@std/assert";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import {
  bootSpecs,
  childExcludePrefixes,
  parseVaultList,
  VaultEnvError,
} from "../server/vault_env.ts";

Deno.test("vault_env: PATH only is empty slug", () => {
  assertEquals(bootSpecs({ path: "/data" }), [{ slug: "", root: "/data" }]);
});

Deno.test("vault_env: PATH required when VAULTS unset", () => {
  assertThrows(
    () => bootSpecs({}),
    VaultEnvError,
    "GLOBNOTES_PATH is required",
  );
});

Deno.test("vault_env: VAULTS without PATH", () => {
  assertEquals(
    bootSpecs({ vaults: "dad:/data/dad,mom:/data/mom" }),
    [
      { slug: "dad", root: "/data/dad" },
      { slug: "mom", root: "/data/mom" },
    ],
  );
});

Deno.test("vault_env: PATH becomes globnotes when VAULTS set", () => {
  assertEquals(
    bootSpecs({ path: "/data", vaults: "dad:/data/dad" }),
    [
      { slug: "globnotes", root: "/data" },
      { slug: "dad", root: "/data/dad" },
    ],
  );
});

Deno.test("vault_env: reserved and invalid slugs", () => {
  assertThrows(() => parseVaultList("_:/x"), VaultEnvError, "Invalid vault slug");
  assertThrows(
    () => parseVaultList("globnotes:/x"),
    VaultEnvError,
    "Reserved",
  );
  assertThrows(() => parseVaultList("Dad:/x"), VaultEnvError, "Invalid vault slug");
  assertThrows(() => parseVaultList("d-ad:/x"), VaultEnvError, "Invalid vault slug");
  assertThrows(() => parseVaultList("dad:/x,dad:/y"), VaultEnvError, "Duplicate");
  assertThrows(() => parseVaultList("nocolon"), VaultEnvError, "Expected slug:root");
});

Deno.test("vault_env: child roots of PATH are exclude prefixes", () => {
  assertEquals(
    childExcludePrefixes("/data", [
      { slug: "globnotes", root: "/data" },
      { slug: "dad", root: "/data/dad" },
      { slug: "work", root: "/srv/work" },
    ]),
    ["dad"],
  );
});

Deno.test("vault_env: FileSystemNotes skips exclude prefixes", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/ideas.md`, "x");
    await Deno.mkdir(`${root}/dad`);
    await Deno.writeTextFile(`${root}/dad/soup.md`, "y");
    const notes = new FileSystemNotes(root, null, ["dad"]);
    assertEquals(notes.getPaths(), ["ideas"]);
    const level = notes.listLevel("");
    assertEquals(level.folders.map((f) => f.name), []);
    assertEquals(level.notes, ["ideas"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
