// SPDX-License-Identifier: LGPL-3.0-only

/**
 * External metadata selects <base>/globnotes; unset retains in-tree metadata.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { bootServer } from "./helpers/boot.ts";

Deno.test("state dir: GLOBNOTES_METADATA_PATH selects per-vault metadata", async (t) => {
  const vault = await Deno.makeTempDir({ prefix: "gn-vault-" });
  const metadataBase = await Deno.makeTempDir({ prefix: "gn-state-" });
  const stateDir = path.join(metadataBase, "globnotes");
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    GLOBNOTES_METADATA_PATH: metadataBase,
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
    Deno.removeSync(metadataBase, { recursive: true });
  }
});

Deno.test("state dir: external metadata neither converts nor warns about in-tree records", async () => {
  const vault = await Deno.makeTempDir({ prefix: "gn-legacy-vault-" });
  const stateDir = await Deno.makeTempDir({ prefix: "gn-legacy-state-" });
  // Existing in-tree records remain untouched when an operator selects another base.
  const legacyDir = path.join(vault, ".globnotes");
  Deno.mkdirSync(legacyDir, { recursive: true });
  Deno.writeTextFileSync(
    path.join(legacyDir, "config.json"),
    JSON.stringify({ auth_type: "none" }),
  );

  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    GLOBNOTES_METADATA_PATH: stateDir,
  });
  try {
    const seen = server.logs().stderr;
    assertEquals(seen.includes("GLOBNOTES_INDEX_PATH"), false);
    assertEquals(seen.includes("mv "), false);
    assertEquals(
      Deno.readTextFileSync(path.join(legacyDir, "config.json")),
      JSON.stringify({ auth_type: "none" }),
    );
    assertEquals([...Deno.readDirSync(legacyDir)].map((e) => e.name), [
      "config.json",
    ]);
    assertEquals(
      (await fetch(`${server.baseUrl}/_/api/config`).then((r) => r.json()))
        .setupRequired,
      true,
    );
    assertEquals(
      [...Deno.readDirSync(path.join(stateDir, "globnotes"))].some((e) =>
        e.name === "config.toml" || e.name === "config.json"
      ),
      false,
    );
  } finally {
    await server.close();
    Deno.removeSync(vault, { recursive: true });
    Deno.removeSync(stateDir, { recursive: true });
  }
});

Deno.test("state dir: unset var keeps the legacy vault layout", async () => {
  const vault = await Deno.makeTempDir({ prefix: "gn-legacy-default-" });
  const server = await bootServer({ GLOBNOTES_GLOBNOTES_PATH: vault });
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
