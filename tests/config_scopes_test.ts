// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  ConfigError,
  loadInstanceConfig,
  loadVaultConfig,
  vaultDefaultsPath,
} from "../server/config/loader.ts";
import { vaultConfigPath } from "../server/config/paths.ts";

function fixture(run: (root: string) => void): void {
  const root = Deno.makeTempDirSync({ prefix: "config-scopes-" });
  try {
    run(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

Deno.test("config scopes: TOML and env declarations merge by name and leaf without touching paths", () =>
  fixture((root) => {
    const file = `${root}/instance.toml`;
    Deno.writeTextFileSync(
      file,
      `[vaults.entries.my_notes]\npath="${root}/notes"\nadmin="alex"\n[vaults.entries.brand]\npath="${root}/brand"\n`,
    );
    const before = [...Deno.readDirSync(root)].map((e) => e.name);
    const result = loadInstanceConfig({
      overlayPath: file,
      env: {
        GLOBNOTES_MY__NOTES_ADMIN: "other",
        GLOBNOTES_MY__NOTES_BRAND_NAME: "Family",
        GLOBNOTES_WEIRD____VAULT_PATH: `${root}/elsewhere`,
        GLOBNOTES_WEIRD____VAULT_PLUGINS_AUTOENABLE: "false",
      },
    });
    assertEquals(result.config.vaults.entries.my_notes, {
      path: `${root}/notes`,
      admin: "other",
    });
    assertEquals(result.config.vaults.entries.brand.admin, "");
    assertEquals(result.config.vaults.entries.weird__vault.admin, "");
    assertEquals(result.vaults.my_notes.config.brand.name, "Family");
    assertEquals(result.vaults.weird__vault.config.plugins.autoenable, false);
    assertEquals(
      result.provenance["vaults.entries.my_notes.admin"].source,
      "GLOBNOTES_MY__NOTES_ADMIN",
    );
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), before);
    assert(Object.isFrozen(result.config.vaults.entries));
  }));

Deno.test("config scopes: saved registry bindings coexist with declarations without becoming declarations", () =>
  fixture((root) => {
    const result = loadInstanceConfig({
      overlayPath: null,
      env: {
        GLOBNOTES_FAMILY_PATH: `${root}/external`,
        GLOBNOTES_SAVED_BRAND_NAME: "Saved",
      },
      vaults: { saved: { path: `${root}/saved` } },
    });
    assertEquals(Object.keys(result.config.vaults.entries), ["family"]);
    assertEquals(Object.keys(result.vaults).sort(), ["family", "saved"]);
    assertEquals(result.vaults.saved.config.brand.name, "Saved");
    assertEquals(result.config.vaults.entries.family.admin, "");
  }));

Deno.test("config scopes: default vault settings then saved TOML then env including empty clears", () =>
  fixture((root) => {
    const file = `${root}/vault.toml`;
    Deno.writeTextFileSync(
      file,
      '[brand]\nname="Saved"\naccent="#123456"\n[quickaccess]\nlimit=9\n',
    );
    const result = loadVaultConfig("my_notes", file, {
      GLOBNOTES_MY__NOTES_BRAND_NAME: "",
      GLOBNOTES_MY__NOTES_QUICKACCESS_HIDE: "true",
    });
    assertEquals(result.config.brand, { name: "", accent: "#123456" });
    assertEquals(result.config.quickaccess.limit, 9);
    assertEquals(result.config.quickaccess.hide, true);
    assertEquals(result.config.plugins.settings, "{}");
    assertEquals(result.provenance["brand.name"].layer, "env");
    assertEquals(result.provenance["brand.accent"].layer, "toml");
    assertEquals(result.provenance["plugins.autoenable"].pinned, false);
  }));

Deno.test("config scopes: validate every declared overlay including inactive scopes and aggregate errors", () =>
  fixture((root) => {
    for (const name of ["first", "inactive"]) {
      const file = vaultConfigPath(`${root}/${name}`, `${root}/metadata`, name);
      Deno.mkdirSync(`${root}/metadata/${name}`, { recursive: true });
      Deno.writeTextFileSync(
        file,
        name === "first"
          ? '[quickaccess]\nlimit="SECRET_VALUE"'
          : '[unknown]\nkey="SECRET_VALUE"',
      );
    }
    const error = assertThrows(
      () =>
        loadInstanceConfig({
          overlayPath: null,
          env: {
            GLOBNOTES_METADATA_PATH: `${root}/metadata`,
            GLOBNOTES_FIRST_PATH: `${root}/first`,
            GLOBNOTES_INACTIVE_PATH: `${root}/inactive`,
          },
        }),
      ConfigError,
    );
    for (
      const text of [
        "first/config.toml",
        "inactive/config.toml",
        "quickaccess.limit",
        "GLOBNOTES_INACTIVE_UNKNOWN",
      ]
    ) assertStringIncludes(error.message, text);
    assertFalse(error.message.includes("SECRET_VALUE"));
  }));

Deno.test("config scopes: supplied names do not discover adjacent folders or grant an admin", () =>
  fixture((root) => {
    Deno.mkdirSync(`${root}/arbitrary`);
    const result = loadInstanceConfig({
      overlayPath: null,
      env: { GLOBNOTES__VAULTS_BASEPATH: root },
    });
    assertEquals(result.config.vaults.entries, {});
    assertEquals(result.vaults, {});
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), ["arbitrary"]);
  }));

Deno.test("config scopes: invalid names declarations fields and obsolete aliases fail", () =>
  fixture((root) => {
    for (
      const env of [
        { GLOBNOTES_FAMILY_ADMIN: "alex" },
        { GLOBNOTES_FAMILY_PATH: "" },
        { GLOBNOTES_MY_NOTES_PATH: `${root}/notes` },
        { GLOBNOTES_FAMILY_INDEX: `${root}/state` },
        { GLOBNOTES__VAULTS_ENTRYDEFAULTS_ADMIN: "alex" },
        { GLOBNOTES_ORPHAN_BRAND_NAME: "not declared" },
        {
          GLOBNOTES_FAMILY_PATH: `${root}/notes`,
          GLOBNOTES_FAMILY_AUTH_TYPE: "none",
        },
      ] as Record<string, string>[]
    ) {
      assertThrows(
        () => loadInstanceConfig({ overlayPath: null, env }),
        ConfigError,
      );
    }
    const file = `${root}/instance.toml`;
    for (
      const text of [
        '[vaults.entries._]\npath="/notes"',
        '[vaults.entries.Bad]\npath="/notes"',
        '[vaults.entries.family]\npath="/notes"\nindex="/state"',
        '[vaults.entrydefaults]\nadmin="alex"',
        "[vaults]\nentries=3",
      ]
    ) {
      Deno.writeTextFileSync(file, text);
      assertThrows(
        () => loadInstanceConfig({ overlayPath: file, env: {} }),
        ConfigError,
      );
    }
  }));

Deno.test("config scopes: unreadable vault overlay is not absence and original bytes survive", () =>
  fixture((root) => {
    const file = `${root}/vault.toml`, text = '[brand]\nname="Private"';
    Deno.writeTextFileSync(file, text);
    Deno.chmodSync(file, 0o000);
    try {
      assertThrows(() => loadVaultConfig("family", file, {}), ConfigError);
    } finally {
      Deno.chmodSync(file, 0o600);
    }
    assertEquals(Deno.readTextFileSync(file), text);
  }));

Deno.test("config scopes: incomplete vault defaults fail even with an env value", () =>
  fixture((root) => {
    const file = `${root}/defaults.toml`;
    Deno.writeTextFileSync(
      file,
      Deno.readTextFileSync(vaultDefaultsPath).replace('settings = "{}"', ""),
    );
    const error = assertThrows(
      () =>
        loadVaultConfig("family", null, {
          GLOBNOTES_FAMILY_PLUGINS_SETTINGS: "{}",
        }, file),
      ConfigError,
    );
    assertStringIncludes(
      error.message,
      "plugins.settings (GLOBNOTES_FAMILY_PLUGINS_SETTINGS): missing default leaf",
    );
  }));

Deno.test("config scopes: addressed plugin JSON stays opaque to the leaf merge", () => {
  const json = '{"plugin":{"page":{"field":"secret"}}}';
  const result = loadVaultConfig("family", null, {
    GLOBNOTES_FAMILY_PLUGINS_SETTINGS: json,
  });
  assertEquals(result.config.plugins.settings, json);
  assertEquals(
    result.provenance["plugins.settings"].source,
    "GLOBNOTES_FAMILY_PLUGINS_SETTINGS",
  );
});

Deno.test("config scopes: prototype property names remain isolated vault names", () =>
  fixture((root) => {
    const result = loadInstanceConfig({
      overlayPath: null,
      env: {
        GLOBNOTES_CONSTRUCTOR_PATH: `${root}/constructor`,
        GLOBNOTES_CONSTRUCTOR_BRAND_NAME: "Isolated",
      },
    });
    assertEquals(Object.keys(result.config.vaults.entries), ["constructor"]);
    const name: string = "constructor";
    assertEquals(result.vaults[name].config.brand.name, "Isolated");
    assertEquals(
      Object.hasOwn(Object, "GLOBNOTES_CONSTRUCTOR_BRAND_NAME"),
      false,
    );
  }));

Deno.test("config scopes: instance and vault failures are collected in one report", () =>
  fixture((root) => {
    const file = `${root}/vault.toml`;
    Deno.writeTextFileSync(file, "[quickaccess]\nlimit=-1");
    const error = assertThrows(
      () =>
        loadInstanceConfig({
          overlayPath: null,
          env: {
            GLOBNOTES__MCP_ENABLED: "invalid",
            GLOBNOTES_FAMILY_BRAND_ACCENT: "secret",
          },
          vaults: { family: { path: `${root}/family`, overlayPath: file } },
        }),
      ConfigError,
    );
    for (
      const key of [
        "GLOBNOTES__MCP_ENABLED",
        "GLOBNOTES_FAMILY_BRAND_ACCENT",
        "quickaccess.limit",
      ]
    ) assertStringIncludes(error.message, key);
    assertFalse(error.message.includes("secret"));
  }));
