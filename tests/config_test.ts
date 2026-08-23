// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";
import { AuthType } from "../server/config.ts";

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
    }));
  `;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    env: {
      ...env,
      NO_COLOR: "1",
      // Never inherit the parent's GLOBNOTES_* (other tests set them
      // in-process), but keep the basics the child needs to run.
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      ...(Deno.env.get("DENO_DIR")
        ? { DENO_DIR: Deno.env.get("DENO_DIR")! }
        : {}),
    },
    clearEnv: true,
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
  const c = await loadConfig({ GLOBNOTES_PATH: "/tmp/vault" });
  assertEquals(c.notesPath, "/tmp/vault");
  assertEquals(c.authType, null);
  assertEquals(c.setupRequired, true);
  assertEquals(c.pathPrefix, "");
  assertEquals(c.quickAccessHide, false);
  assertEquals(c.quickAccessTitle, "RECENTLY MODIFIED");
  assertEquals(c.quickAccessTerm, "*");
  assertEquals(c.quickAccessSort, "lastModified");
  assertEquals(c.quickAccessLimit, 4);
  assertEquals(c.autoEnablePlugins, true);
});

Deno.test("config: auto-enable plugins env off", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: "/tmp/vault",
    GLOBNOTES_AUTO_ENABLE_PLUGINS: "false",
  });
  assertEquals(c.autoEnablePlugins, false);
});

Deno.test("config: env auth type wins", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: "/tmp/vault",
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
    GLOBNOTES_PATH: "/tmp/vault",
    GLOBNOTES_PATH_PREFIX: "/notes",
  });
  assertEquals(ok.pathPrefix, "/notes");
});

Deno.test("config: invalid path prefix exits", async () => {
  const script = `
    import { GlobalConfig } from "${SERVER_DIR}config.ts";
    new GlobalConfig();
  `;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    env: { GLOBNOTES_PATH: "/tmp/vault", GLOBNOTES_PATH_PREFIX: "bad" },
    stdout: "null",
    stderr: "null",
  });
  const { code } = await cmd.output();
  assert(code !== 0);
});

Deno.test("config: deprecated GLOBNOTES_HIDE_RECENTLY_MODIFIED still works", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: "/tmp/vault",
    GLOBNOTES_HIDE_RECENTLY_MODIFIED: "true",
  });
  assertEquals(c.quickAccessHide, true);
});

Deno.test("config: quick access settings", async () => {
  const c = await loadConfig({
    GLOBNOTES_PATH: "/tmp/vault",
    GLOBNOTES_QUICK_ACCESS_TITLE: "Pinned",
    GLOBNOTES_QUICK_ACCESS_SORT: "title",
    GLOBNOTES_QUICK_ACCESS_LIMIT: "9",
  });
  assertEquals(c.quickAccessTitle, "Pinned");
  assertEquals(c.quickAccessSort, "title");
  assertEquals(c.quickAccessLimit, 9);
});
