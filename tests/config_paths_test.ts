// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeVaultName,
  escapeVaultName,
  instanceMetadataPath,
  isVaultName,
  vaultConfigPath,
  vaultMetadataPath,
} from "../server/config/paths.ts";

Deno.test("config paths: default and relocated instance and vault metadata", () => {
  assertEquals(instanceMetadataPath("/data", ""), "/data/.globnotes");
  assertEquals(
    instanceMetadataPath("/data", "/etc/globnotes"),
    "/etc/globnotes/_",
  );
  assertEquals(
    vaultMetadataPath("/srv/family", "", "family"),
    "/srv/family/.globnotes",
  );
  assertEquals(
    vaultMetadataPath("/srv/family", "/etc/globnotes", "family"),
    "/etc/globnotes/family",
  );
  assertEquals(
    vaultConfigPath("/srv/family", "/etc/globnotes", "family"),
    "/etc/globnotes/family/config.toml",
  );
  assertEquals(
    vaultMetadataPath("/srv/family", "/etc/globnotes/", "family"),
    "/etc/globnotes/family",
  );
  assertThrows(() => vaultMetadataPath("/srv/family", "/metadata", "_"));
});

Deno.test("config paths: escaped underscores round trip; no section-name reservations", () => {
  for (
    const name of [
      "family",
      "my_notes",
      "weird__vault",
      "notes_",
      "brand",
      "server",
      "constructor",
    ]
  ) {
    assertEquals(isVaultName(name), true);
    assertEquals(decodeVaultName(escapeVaultName(name)), name);
  }
  assertEquals(escapeVaultName("my_notes"), "MY__NOTES");
  assertEquals(escapeVaultName("weird__vault"), "WEIRD____VAULT");
  for (const name of ["_", "", "Bad", "../other", "a-b", "1name"]) {
    assertEquals(isVaultName(name), false);
  }
  for (const encoded of ["MY_NOTES", "MY___NOTES", "my__notes", "_", ""]) {
    assertEquals(decodeVaultName(encoded), null);
  }
});
