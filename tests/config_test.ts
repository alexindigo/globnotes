// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";
import { AuthType } from "../server/config.ts";
import { command } from "./helpers/process.ts";

/** An owned, empty vault: GlobalConfig reads <vault>/.globnotes/config.json,
 * so a fixed shared path could carry another run's stored config. */
const VAULT = Deno.makeTempDirSync({ prefix: "globnotes-config-vault-" });
globalThis.addEventListener("unload", () => {
  Deno.removeSync(VAULT, { recursive: true });
});

// GlobalConfig reads process env at construction time, so these tests
// spawn subprocesses with controlled environments.

const SERVER_DIR = new URL("../server/", import.meta.url).pathname;

async function loadConfig(
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const script = `
    import { GlobalConfig } from "${SERVER_DIR}config.ts";
    const c = new GlobalConfig();
    console.log(JSON.stringify({
      notesPath: c.notesPath,
      authType: c.authType,
      setupRequired: c.setupRequired,
      pathPrefix: c.pathPrefix,
      quickAccessHide: c.quickAccessHide,
      quickAccessTitle: c.quickAccessTitle,
      quickAccessTerm: c.quickAccessTerm,
      quickAccessSort: c.quickAccessSort,
      quickAccessLimit: c.quickAccessLimit,
      autoEnablePlugins: c.autoEnablePlugins,
      brandName: c.brandName,
      brandAccent: c.brandAccent,
    }));
  `;
  const cmd = command(Deno.execPath(), {
    args: ["eval", script],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`config load failed: ${new TextDecoder().decode(stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout));
}

Deno.test("config: defaults", async () => {
  const c = await loadConfig({ GLOBNOTES_PATH: VAULT });
  assertEquals(c.notesPath, VAULT);
  assertEquals(c.authType, null);
  assertEquals(c.setupRequired, true);
  assertEquals(c.pathPrefix, "");
  assertEquals(c.quickAccessHide, false);
  assertEquals(c.quickAccessTitle, "RECENTLY MODIFIED");
  assertEquals(c.quickAccessTerm, "*");
  assertEquals(c.quickAccessSort, "lastModified");
  assertEquals(c.quickAccessLimit, 4);
  assertEquals(c.autoEnablePlugins, true);
  assertEquals(c.brandName, null);
  assertEquals(c.brandAccent, null);
});

Deno.test("config: auto-enable plugins env off", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: VAULT,
    GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
  });
  assertEquals(c.autoEnablePlugins, false);
});

Deno.test("config: env auth type wins", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: VAULT,
    GLOBNOTES_AUTH_TYPE: "none",
  });
  assertEquals(c.authType, AuthType.NONE);
  assertEquals(c.setupRequired, false);
});

Deno.test("config: stored config is used when env absent", async () => {
  const vault = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "password" }),
    );
    const c = await loadConfig({ GLOBNOTES_PATH: vault });
    assertEquals(c.authType, AuthType.PASSWORD);
    assertEquals(c.setupRequired, false);
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("config: env overrides stored config", async () => {
  const vault = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "password" }),
    );
    const c = await loadConfig({
      GLOBNOTES_PATH: vault,
      GLOBNOTES_AUTH_TYPE: "read_only",
    });
    assertEquals(c.authType, AuthType.READ_ONLY);
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("config: path prefix validated", async () => {
  const ok = await loadConfig({
    GLOBNOTES_PATH: VAULT,
    GLOBNOTES_PATH_PREFIX: "/notes",
  });
  assertEquals(ok.pathPrefix, "/notes");
});

Deno.test("config: invalid path prefix exits", async () => {
  const script = `
    import { GlobalConfig } from "${SERVER_DIR}config.ts";
    new GlobalConfig();
  `;
  const cmd = command(Deno.execPath(), {
    args: ["eval", script],
    env: { GLOBNOTES_PATH: VAULT, GLOBNOTES_PATH_PREFIX: "bad" },
    stdout: "null",
    stderr: "null",
  });
  const { code } = await cmd.output();
  assert(code !== 0);
});

Deno.test("config: deprecated GLOBNOTES_HIDE_RECENTLY_MODIFIED still works", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: VAULT,
    GLOBNOTES_HIDE_RECENTLY_MODIFIED: "true",
  });
  assertEquals(c.quickAccessHide, true);
});

Deno.test("config: quick access settings", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: VAULT,
    GLOBNOTES_QUICK_ACCESS_TITLE: "Pinned",
    GLOBNOTES_QUICK_ACCESS_SORT: "title",
    GLOBNOTES_QUICK_ACCESS_LIMIT: "9",
  });
  assertEquals(c.quickAccessTitle, "Pinned");
  assertEquals(c.quickAccessSort, "title");
  assertEquals(c.quickAccessLimit, 9);
});

Deno.test("config: brand from env", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: VAULT,
    GLOBNOTES_BRAND_NAME: "Acme Notes",
    GLOBNOTES_BRAND_ACCENT: "#ff6600",
  });
  assertEquals(c.brandName, "Acme Notes");
  assertEquals(c.brandAccent, "#ff6600");
});

Deno.test("config: brand from stored config when env absent", async () => {
  const vault = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({
        auth_type: "none",
        brand_name: "Stored Brand",
        brand_accent: "#00aa55",
      }),
    );
    const c = await loadConfig({ GLOBNOTES_PATH: vault });
    assertEquals(c.brandName, "Stored Brand");
    assertEquals(c.brandAccent, "#00aa55");
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("config: brand env wins over stored config", async () => {
  const vault = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({
        auth_type: "none",
        brand_name: "Stored Brand",
        brand_accent: "#00aa55",
      }),
    );
    const c = await loadConfig({
      GLOBNOTES_PATH: vault,
      GLOBNOTES_BRAND_NAME: "Env Brand",
    });
    assertEquals(c.brandName, "Env Brand");
    assertEquals(c.brandAccent, "#00aa55");
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("config: empty brand env treated as unset", async () => {
  const vault = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${vault}/.globnotes`, { recursive: true });
    await Deno.writeTextFile(
      `${vault}/.globnotes/config.json`,
      JSON.stringify({ auth_type: "none", brand_name: "Stored Brand" }),
    );
    const c = await loadConfig({
      GLOBNOTES_PATH: vault,
      GLOBNOTES_BRAND_NAME: "",
    });
    assertEquals(c.brandName, "Stored Brand");
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
