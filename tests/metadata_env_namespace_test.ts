// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigError,
  envName,
  loadInstanceConfig,
  loadVaultConfig,
} from "../server/config/loader.ts";
import {
  decodeVaultName,
  escapeVaultName,
  instanceMetadataPath,
  vaultMetadataPath,
} from "../server/config/paths.ts";
import { launchProjection } from "../server/config/cli.ts";

function fixture(run: (root: string) => void): void {
  const root = Deno.makeTempDirSync({ prefix: "metadata-env-namespace-" });
  try {
    run(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

Deno.test("metadata namespace: instance path uses the empty-slug prefix", () =>
  fixture((root) => {
    assertEquals(envName("metadata.path"), "GLOBNOTES__METADATA_PATH");
    const loaded = loadInstanceConfig({
      overlayPath: null,
      env: { GLOBNOTES__METADATA_PATH: `${root}/state` },
    });
    assertEquals(loaded.config.metadata.path, `${root}/state`);
    assertEquals(loaded.config.vaults.entries, {});
    assertEquals(
      instanceMetadataPath("/notes", loaded.config.metadata.path),
      `${root}/state/_`,
    );
    assertEquals([...Deno.readDirSync(root)], []);
  }));

Deno.test("metadata namespace: env can declare a metadata vault without relocating instance state", () =>
  fixture((root) => {
    const loaded = loadInstanceConfig({
      overlayPath: null,
      env: {
        GLOBNOTES__VAULTS_BASEPATH: `${root}/base`,
        GLOBNOTES_METADATA_PATH: `${root}/notes`,
        GLOBNOTES_METADATA_ADMIN: "owner",
        GLOBNOTES_METADATA_BRAND_NAME: "Metadata vault",
      },
    });
    assertEquals(loaded.config.metadata.path, "");
    assertEquals(loaded.config.vaults.entries.metadata, {
      path: `${root}/notes`,
      admin: "owner",
    });
    assertEquals(loaded.vaults.metadata.config.brand.name, "Metadata vault");
    assertEquals(
      instanceMetadataPath(
        loaded.config.vaults.basepath,
        loaded.config.metadata.path,
      ),
      `${root}/base/.globnotes`,
    );
    assertEquals([...Deno.readDirSync(root)], []);
  }));

Deno.test("metadata namespace: TOML can declare a metadata vault without relocating instance state", () =>
  fixture((root) => {
    const file = `${root}/instance.toml`;
    Deno.writeTextFileSync(
      file,
      `[vaults.entries.metadata]\npath="${root}/notes"\nadmin="owner"\n`,
    );
    const loaded = loadInstanceConfig({ overlayPath: file, env: {} });
    assertEquals(loaded.config.metadata.path, "");
    assertEquals(loaded.config.vaults.entries.metadata, {
      path: `${root}/notes`,
      admin: "owner",
    });
    assertEquals(Object.keys(loaded.vaults), ["metadata"]);
    assertEquals([...Deno.readDirSync(root)].map((entry) => entry.name), [
      "instance.toml",
    ]);
  }));

Deno.test("metadata namespace: instance path and metadata vault coexist without collisions", () =>
  fixture((root) => {
    const loaded = loadInstanceConfig({
      overlayPath: null,
      env: {
        GLOBNOTES__METADATA_PATH: `${root}/state`,
        GLOBNOTES_METADATA_PATH: `${root}/notes`,
        GLOBNOTES_METADATA_BRAND_NAME: "Separate vault",
      },
    });
    assertEquals(loaded.config.metadata.path, `${root}/state`);
    assertEquals(loaded.config.vaults.entries.metadata.path, `${root}/notes`);
    assertEquals(loaded.vaults.metadata.config.brand.name, "Separate vault");
    assertEquals(
      loaded.provenance["metadata.path"].source,
      "GLOBNOTES__METADATA_PATH",
    );
    assertEquals(
      loaded.provenance["vaults.entries.metadata.path"].source,
      "GLOBNOTES_METADATA_PATH",
    );
    assertEquals(
      instanceMetadataPath("/notes", loaded.config.metadata.path),
      `${root}/state/_`,
    );
    assertEquals(
      vaultMetadataPath(
        `${root}/notes`,
        loaded.config.metadata.path,
        "metadata",
      ),
      `${root}/state/metadata`,
    );
  }));

Deno.test("metadata namespace: metadata remains valid in supplied and standalone vault scopes", () =>
  fixture((root) => {
    assertEquals(escapeVaultName("metadata"), "METADATA");
    assertEquals(decodeVaultName("METADATA"), "metadata");
    const bound = loadInstanceConfig({
      overlayPath: null,
      env: {},
      vaults: { metadata: { path: root, overlayPath: null } },
    });
    assertEquals(bound.config.metadata.path, "");
    assertEquals(Object.keys(bound.vaults), ["metadata"]);
    assertEquals(
      loadVaultConfig("metadata", null, {
        GLOBNOTES_METADATA_BRAND_NAME: "Standalone",
      }).config.brand.name,
      "Standalone",
    );
  }));

Deno.test("metadata namespace: old instance spelling fails loudly at the single-vault launcher instead of acting as an alias", () =>
  fixture((root) => {
    const notes = `${root}/notes`;
    Deno.mkdirSync(notes);
    assertThrows(
      () =>
        launchProjection({
          GLOBNOTES_GLOBNOTES_PATH: notes,
          GLOBNOTES_METADATA_PATH: `${root}/must-not-be-instance-state`,
        }),
      ConfigError,
      "only the sole globnotes vault is supported",
    );
    assertEquals([...Deno.readDirSync(root)].map((entry) => entry.name), [
      "notes",
    ]);
  }));
