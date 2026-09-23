// SPDX-License-Identifier: LGPL-3.0-only

/**
 * WS1 (issue #5): GLOBNOTES_INDEX_PATH relocates the state dir (index,
 * config, brand, plugins) away from the vault; unset keeps the legacy
 * <vault>/.globnotes layout byte-identical. Own-spawn for the boot
 * warning step (bootServer drains stderr without exposing it).
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { bootServer } from "./helpers/boot.ts";

// The suite's shared process env carries GLOBNOTES_* leftovers from other
// test files (render_test sets AUTH_TYPE=none at import). Empty string
// neutralizes: getEnv treats "" as unset per the env-wins rule.
const CLEAN_ENV = { GLOBNOTES_AUTH_TYPE: "", GLOBNOTES_PATH_PREFIX: "" };

Deno.test("state dir: GLOBNOTES_INDEX_PATH relocates state", async (t) => {
  const vault = await Deno.makeTempDir({ prefix: "gn-vault-" });
  const stateDir = await Deno.makeTempDir({ prefix: "gn-state-" });
  const server = await bootServer({
    ...CLEAN_ENV,
    GLOBNOTES_PATH: vault,
    GLOBNOTES_INDEX_PATH: stateDir,
  });
  try {
    await t.step("setup config lands in the state dir", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "none" }),
      });
      assertEquals(res.status, 200);
      assert(Deno.statSync(path.join(stateDir, "config.json")).isFile);
      // The vault must NOT grow a .globnotes dir.
      let legacy = false;
      try {
        Deno.statSync(path.join(vault, ".globnotes"));
        legacy = true;
      } catch { /* expected: absent */ }
      assertEquals(legacy, false);
    });

    await t.step("index.sqlite lands in the state dir", () => {
      assert(Deno.statSync(path.join(stateDir, "index.sqlite")).isFile);
    });

    await t.step("notes land in the vault", async () => {
      const res = await fetch(`${server.baseUrl}/_/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello", content: "# Hi\n" }),
      });
      assert(res.ok);
      assert(Deno.statSync(path.join(vault, "hello.md")).isFile);
    });

    await t.step("brand upload round-trips through the state dir", async () => {
      const form = new FormData();
      form.append(
        "icon",
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg"/>'],
          "icon.svg",
          { type: "image/svg+xml" },
        ),
      );
      const up = await fetch(`${server.baseUrl}/_/api/brand`, {
        method: "POST",
        body: form,
      });
      assert(up.ok);
      assert(
        Deno.statSync(path.join(stateDir, "brand", "icon.svg")).isFile,
      );
      const got = await fetch(`${server.baseUrl}/_/brand/icon.svg`);
      assertEquals(got.status, 200);
      await got.body?.cancel();
    });

    await t.step("plugins are discovered from the state dir", async () => {
      const dir = path.join(stateDir, "plugins", "testplug");
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ id: "testplug", name: "Test Plug" }),
      );
      Deno.writeTextFileSync(path.join(dir, "main.js"), "export {};\n");
      const res = await fetch(`${server.baseUrl}/_/api/plugins`);
      assertEquals(res.status, 200);
      const plugins = await res.json();
      assert(
        plugins.some((p: { id: string }) => p.id === "testplug"),
        "testplug discovered from the state dir",
      );
    });
  } finally {
    await server.close();
    Deno.removeSync(vault, { recursive: true });
    Deno.removeSync(stateDir, { recursive: true });
  }
});

Deno.test("state dir: legacy vault config warns loudly at boot", async () => {
  const vault = await Deno.makeTempDir({ prefix: "gn-legacy-vault-" });
  const stateDir = await Deno.makeTempDir({ prefix: "gn-legacy-state-" });
  // Legacy layout: the vault holds .globnotes/config.json; the state dir
  // is empty and GLOBNOTES_INDEX_PATH points at it.
  const legacyDir = path.join(vault, ".globnotes");
  Deno.mkdirSync(legacyDir, { recursive: true });
  Deno.writeTextFileSync(
    path.join(legacyDir, "config.json"),
    JSON.stringify({ auth_type: "none" }),
  );

  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-worker-options",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "server/main.ts",
    ],
    env: {
      ...CLEAN_ENV,
      GLOBNOTES_PATH: vault,
      GLOBNOTES_INDEX_PATH: stateDir,
      GLOBNOTES_PORT: String(port),
      GLOBNOTES_HOST: "127.0.0.1",
      NO_COLOR: "1",
    },
    stdout: "null",
    stderr: "piped",
  }).spawn();

  try {
    let seen = "";
    const deadline = Date.now() + 15_000;
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
      if (seen.includes("GLOBNOTES_INDEX_PATH is set")) break;
    }
    reader.releaseLock();
    assert(
      seen.includes("GLOBNOTES_INDEX_PATH is set"),
      `boot warning missing; stderr was:\n${seen}`,
    );
    assert(seen.includes("mv "), "warning includes the mv command");
  } finally {
    child.kill("SIGKILL");
    await child.status.catch(() => {});
    Deno.removeSync(vault, { recursive: true });
    Deno.removeSync(stateDir, { recursive: true });
  }
});

Deno.test("state dir: unset var keeps the legacy vault layout", async () => {
  const vault = await Deno.makeTempDir({ prefix: "gn-legacy-default-" });
  const server = await bootServer({ ...CLEAN_ENV, GLOBNOTES_PATH: vault });
  try {
    const res = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "none" }),
    });
    assertEquals(res.status, 200);
    assert(
      Deno.statSync(path.join(vault, ".globnotes", "config.json")).isFile,
    );
    assert(
      Deno.statSync(path.join(vault, ".globnotes", "index.sqlite")).isFile,
    );
  } finally {
    await server.close();
    Deno.removeSync(vault, { recursive: true });
  }
});
