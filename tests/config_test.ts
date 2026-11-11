// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { command } from "./helpers/process.ts";
import type { StoredConfig } from "../server/config.ts";
const SERVER_DIR = new URL("../server/", import.meta.url).href;
const VAULT = Deno.makeTempDirSync({ prefix: "globnotes-config-vault-" });
globalThis.addEventListener(
  "unload",
  () => Deno.removeSync(VAULT, { recursive: true }),
);

async function loadConfig(
  env: Record<string, string>,
  stored?: StoredConfig,
  toml?: string,
): Promise<Record<string, unknown>> {
  const vault = env.GLOBNOTES_GLOBNOTES_PATH!;
  if (stored || toml !== undefined) {
    Deno.mkdirSync(`${vault}/.globnotes`, { recursive: true });
  }
  if (stored) {
    Deno.writeTextFileSync(
      `${vault}/.globnotes/config.json`,
      JSON.stringify(stored),
    );
  }
  if (toml !== undefined) {
    Deno.writeTextFileSync(`${vault}/.globnotes/config.toml`, toml);
  }
  const script = `
    import { GlobalConfig } from ${JSON.stringify(SERVER_DIR + "config.ts")};
    import { loadInstanceConfig } from ${
    JSON.stringify(SERVER_DIR + "config/loader.ts")
  };
    import { singleVaultSettings, singleVaultBindings } from ${
    JSON.stringify(SERVER_DIR + "config/single_vault.ts")
  };
    const env = ${JSON.stringify(env)};
    const c = new GlobalConfig(singleVaultSettings(loadInstanceConfig({env,overlayPath:null,vaults:singleVaultBindings}),env));
    console.log(JSON.stringify({notesPath:c.notesPath,authType:c.authType,setupRequired:c.setupRequired,pathPrefix:c.pathPrefix,
      quickAccessHide:c.quickAccessHide,quickAccessTitle:c.quickAccessTitle,quickAccessTerm:c.quickAccessTerm,quickAccessSort:c.quickAccessSort,quickAccessLimit:c.quickAccessLimit,
      autoEnablePlugins:c.autoEnablePlugins,brandName:c.brandName,brandAccent:c.brandAccent,settingsWritable:c.settingsWritable}));`;
  const result = await command(Deno.execPath(), {
    args: ["eval", script],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
Deno.test("config: shipped defaults reach the resolved facade", async () => {
  const c = await loadConfig({ GLOBNOTES_GLOBNOTES_PATH: VAULT });
  assertEquals(c, {
    notesPath: VAULT,
    authType: null,
    setupRequired: true,
    pathPrefix: "",
    quickAccessHide: false,
    quickAccessTitle: "RECENTLY MODIFIED",
    quickAccessTerm: "*",
    quickAccessSort: "lastModified",
    quickAccessLimit: 4,
    autoEnablePlugins: true,
    brandName: null,
    brandAccent: null,
    settingsWritable: false,
  });
});
Deno.test("config: explicit auto-enable false is retained", async () =>
  assertEquals(
    (await loadConfig({
      GLOBNOTES_GLOBNOTES_PATH: VAULT,
      GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE: "false",
    })).autoEnablePlugins,
    false,
  ));
Deno.test("config: current private auth record retains password/read-only/public setup state", async () => {
  const root = Deno.makeTempDirSync({ prefix: "config-auth-record-" });
  try {
    for (const mode of ["password", "read_only", "none"]) {
      const c = await loadConfig({ GLOBNOTES_GLOBNOTES_PATH: root }, {
        auth_type: mode,
        read_only_settings: mode === "none",
      });
      assertEquals(c.authType, mode);
      assertEquals(c.setupRequired, false);
      assertEquals(c.settingsWritable, mode === "password");
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
Deno.test("config: prefix validates and quick-access typed values reach the facade", async () => {
  const c = await loadConfig({
    GLOBNOTES_GLOBNOTES_PATH: VAULT,
    GLOBNOTES__SERVER_PATHPREFIX: "/notes",
    GLOBNOTES_GLOBNOTES_QUICKACCESS_HIDE: "true",
    GLOBNOTES_GLOBNOTES_QUICKACCESS_TITLE: "Pinned",
    GLOBNOTES_GLOBNOTES_QUICKACCESS_SORT: "title",
    GLOBNOTES_GLOBNOTES_QUICKACCESS_LIMIT: "9",
  });
  assertEquals([
    c.pathPrefix,
    c.quickAccessHide,
    c.quickAccessTitle,
    c.quickAccessSort,
    c.quickAccessLimit,
  ], ["/notes", true, "Pinned", "title", 9]);
  await assertRejects(() =>
    loadConfig({
      GLOBNOTES_GLOBNOTES_PATH: VAULT,
      GLOBNOTES__SERVER_PATHPREFIX: "bad",
    })
  );
});
for (
  const key of [
    "GLOBNOTES_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_USERNAME",
    "GLOBNOTES_PASSWORD",
    "GLOBNOTES_TOTP_KEY",
    "GLOBNOTES_SECRET_KEY",
    "GLOBNOTES_READ_ONLY_SETTINGS",
    "GLOBNOTES_HIDE_RECENTLY_MODIFIED",
  ]
) {
  Deno.test(`config: retired ${key} rejects instead of overriding saved records`, async () => {
    const error = await assertRejects(() =>
      loadConfig({ GLOBNOTES_GLOBNOTES_PATH: VAULT, [key]: "DO-NOT-LOG" })
    );
    assert(error instanceof Error);
    assert(error.message.includes(key));
    assert(!error.message.includes("DO-NOT-LOG"));
  });
}
Deno.test("config: branding TOML and env precedence preserve empty clears and siblings", async () => {
  const vault = Deno.makeTempDirSync({ prefix: "config-brand-" });
  try {
    const saved = '[brand]\nname="Stored Brand"\naccent="#00aa55"\n';
    const c = await loadConfig({ GLOBNOTES_GLOBNOTES_PATH: vault }, {
      auth_type: "none",
    }, saved);
    assertEquals([c.brandName, c.brandAccent], ["Stored Brand", "#00aa55"]);
    const pinned = await loadConfig({
      GLOBNOTES_GLOBNOTES_PATH: vault,
      GLOBNOTES_GLOBNOTES_BRAND_NAME: "Env Brand",
    });
    assertEquals([pinned.brandName, pinned.brandAccent], [
      "Env Brand",
      "#00aa55",
    ]);
    const cleared = await loadConfig({
      GLOBNOTES_GLOBNOTES_PATH: vault,
      GLOBNOTES_GLOBNOTES_BRAND_NAME: "",
    });
    assertEquals([cleared.brandName, cleared.brandAccent], [null, "#00aa55"]);
    const both = await loadConfig({
      GLOBNOTES_GLOBNOTES_PATH: vault,
      GLOBNOTES_GLOBNOTES_BRAND_NAME: "Acme Notes",
      GLOBNOTES_GLOBNOTES_BRAND_ACCENT: "#ff6600",
    });
    assertEquals([both.brandName, both.brandAccent], ["Acme Notes", "#ff6600"]);
  } finally {
    Deno.removeSync(vault, { recursive: true });
  }
});
