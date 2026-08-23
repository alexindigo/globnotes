// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin sandbox tests — manifest parsing, capability → permission
 * mapping, PluginHost worker lifecycle (spawn/dispatch/respawn), the
 * ctx RPC back-channel, and permission-narrowing enforcement. Spawns
 * real Workers (no server boot needed).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import { AuthType, GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import {
  discoverPluginDirs,
  readManifest,
  workerPermissions,
} from "../server/plugins/manifest.ts";
import { PluginHost } from "../server/plugins/host.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { pluginRpc } from "../server/plugins/rpc.ts";
import { initState } from "../server/state.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { bootServer } from "./helpers/boot.ts";

function writePlugin(
  vault: string,
  id: string,
  mainJs: string,
  manifest: Record<string, unknown> = {},
): void {
  const dir = path.join(vault, ".globnotes", "plugins", id);
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, ...manifest }),
  );
  Deno.writeTextFileSync(path.join(dir, "main.js"), mainJs);
}

const nullRpc = () => Promise.resolve(null);

Deno.test("plugins: manifest parsing", async (t) => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(vault, "alpha", "export function getSelectors() {}", {
      name: "Alpha",
    });

    await t.step("valid manifest", () => {
      const m = readManifest(
        path.join(vault, ".globnotes", "plugins", "alpha"),
      );
      assertEquals(m.id, "alpha");
      assertEquals(m.name, "Alpha");
      assertEquals(m.entry, "main.js");
      assertEquals(m.capabilities.read, ["vault"]);
      assertEquals(m.capabilities.network, false);
    });

    await t.step("id must match directory name", () => {
      const dir = path.join(vault, ".globnotes", "plugins", "beta");
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ id: "wrong" }),
      );
      Deno.writeTextFileSync(path.join(dir, "main.js"), "");
      let err: Error | null = null;
      try {
        readManifest(dir);
      } catch (e) {
        err = e as Error;
      }
      assert(err !== null && err.message.includes("does not match"));
    });

    await t.step("missing entry → error", () => {
      const dir = path.join(vault, ".globnotes", "plugins", "gamma");
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ id: "gamma" }),
      );
      let err: Error | null = null;
      try {
        readManifest(dir);
      } catch (e) {
        err = e as Error;
      }
      assert(err !== null && err.message.includes("entry"));
    });

    await t.step("discoverPluginDirs finds plugin dirs", () => {
      const dirs = discoverPluginDirs(
        path.join(vault, ".globnotes", "plugins"),
      );
      assert(dirs.some((d) => d.endsWith("alpha")));
    });
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: capability → permission mapping", async () => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(vault, "caps", "", {
      capabilities: {
        network: ["esm.sh"],
        write: ["out"],
        read: ["vault", "data"],
      },
    });
    const m = readManifest(path.join(vault, ".globnotes", "plugins", "caps"));
    const perms = workerPermissions(m, vault) as unknown as {
      net: unknown;
      read: string[];
      write: string[];
      env: unknown;
    };
    assertEquals(perms.net, ["esm.sh"]);
    assertEquals(perms.read, [
      path.join(vault, ".globnotes", "plugins", "caps"),
      vault,
      path.join(vault, "data"),
    ]);
    assertEquals(perms.write, [path.join(vault, "out")]);
    assertEquals(perms.env, false);
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: host dispatch + ctx RPC", async (t) => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(
      vault,
      "echo",
      `export function getSelectors() {
         return [{ node: "fence", language: "echo" }];
       }
       export async function parseNode(node, ctx) {
         if (node.kind === "rpc") {
           const note = await ctx.readNote("hello");
           return { kind: "parts", parts: ["<p>" + note.content + "</p>"] };
         }
         if (node.kind === "fail") {
           await ctx.readNote("missing");
         }
         return null;
       }`,
    );
    const manifest = readManifest(
      path.join(vault, ".globnotes", "plugins", "echo"),
    );
    const rpcCalls: string[] = [];
    const rpc = (method: string, args: unknown[]) => {
      rpcCalls.push(`${method}:${args[0] ?? ""}`);
      if (method === "readNote" && args[0] === "hello") {
        return Promise.resolve({ title: "hello", content: "world" });
      }
      return Promise.reject(new Error("note not found"));
    };
    const host = new PluginHost(manifest, vault, rpc, 2);
    try {
      await host.start();

      await t.step("getSelectors", async () => {
        const selectors = await host.call("getSelectors", []) as {
          node: string;
        }[];
        assertEquals(selectors[0].node, "fence");
      });

      await t.step("parseNode abstain (null)", async () => {
        const result = await host.call("parseNode", [{ kind: "plain" }]);
        assertEquals(result, null);
      });

      await t.step("ctx RPC roundtrip", async () => {
        const result = await host.call("parseNode", [{ kind: "rpc" }]) as {
          kind: string;
          parts: string[];
        };
        assertEquals(result.parts, ["<p>world</p>"]);
        assertEquals(rpcCalls, ["readNote:hello"]);
      });

      await t.step("ctx RPC rejection propagates", async () => {
        await assertRejects(
          () => host.call("parseNode", [{ kind: "fail" }]),
          Error,
          "note not found",
        );
      });

      await t.step("both workers answer (dispatch rotates)", async () => {
        const results = await Promise.all([
          host.call("getSelectors", []),
          host.call("getSelectors", []),
        ]);
        assert(results.every((r) => Array.isArray(r)));
      });
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: permissions are enforced inside the worker", async () => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(
      vault,
      "leak",
      `export function parseNode(node) {
         const results = {};
         try { Deno.env.get("HOME"); results.env = "LEAKED"; }
         catch { results.env = "blocked"; }
         try { Deno.readTextFileSync("/etc/hostname"); results.read = "LEAKED"; }
         catch { results.read = "blocked"; }
         return results;
       }`,
    );
    const manifest = readManifest(
      path.join(vault, ".globnotes", "plugins", "leak"),
    );
    const host = new PluginHost(manifest, vault, nullRpc, 1);
    try {
      await host.start();
      const result = await host.call("parseNode", [{}]) as Record<
        string,
        string
      >;
      assertEquals(result.env, "blocked");
      assertEquals(result.read, "blocked");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: hung worker is killed and respawned", async () => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(
      vault,
      "hanger",
      `export function getSelectors() { return []; }
       export function parseNode(node) {
         if (node.hang) { for (;;) {} }
         return "alive";
       }`,
    );
    const manifest = readManifest(
      path.join(vault, ".globnotes", "plugins", "hanger"),
    );
    const host = new PluginHost(manifest, vault, nullRpc, 1);
    try {
      await host.start();
      assertEquals(await host.call("parseNode", [{}]), "alive");

      // Hang the single worker — heartbeats stop, watchdog fires.
      await assertRejects(
        () => host.call("parseNode", [{ hang: true }]),
        Error,
        "heartbeat timeout",
      );

      // The respawned worker answers again.
      assertEquals(await host.call("parseNode", [{}]), "alive");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: manager discovery skips broken plugins", async () => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(
      vault,
      "good",
      `export function getSelectors() { return ["good"]; }`,
    );
    // Broken: manifest id mismatch.
    const bad = path.join(vault, ".globnotes", "plugins", "bad");
    Deno.mkdirSync(bad, { recursive: true });
    Deno.writeTextFileSync(
      path.join(bad, "manifest.json"),
      JSON.stringify({ id: "wrong" }),
    );
    Deno.writeTextFileSync(path.join(bad, "main.js"), "");

    const manager = new PluginManager(vault, nullRpc, 1);
    try {
      await manager.start();
      assert(manager.hosts.has("good"));
      assert(!manager.hosts.has("bad"));
      const selectors = await manager.hosts.get("good")!.call(
        "getSelectors",
        [],
      );
      assertEquals(selectors, ["good"]);
    } finally {
      await manager.stop();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: server boots with a plugin in the vault", async () => {
  const vault = await Deno.makeTempDir();
  try {
    writePlugin(
      vault,
      "bootplug",
      `export function getSelectors() { return []; }`,
    );
    const server = await bootServer({
      GLOBNOTES_AUTH_TYPE: "none",
      GLOBNOTES_PATH: vault,
    });
    try {
      const res = await fetch(`${server.baseUrl}/_/api/health`);
      assertEquals(res.status, 200);
      await res.body?.cancel();
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("plugins: pluginRpc resolves against real state", async () => {
  const vault = await Deno.makeTempDir();
  const prevPath = Deno.env.get("GLOBNOTES_PATH");
  const prevAuth = Deno.env.get("GLOBNOTES_AUTH_TYPE");
  try {
    Deno.env.set("GLOBNOTES_PATH", vault);
    Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
    Deno.writeTextFileSync(path.join(vault, "hello.md"), "hi there");
    Deno.writeTextFileSync(path.join(vault, "data.bin"), "bytes");

    const config = new GlobalConfig();
    const notes = new FileSystemNotes(vault);
    const indexer = new Fts5Indexer(vault);
    const files = new FileServing(vault);
    initState(config, null, notes, indexer, files);

    const note = await pluginRpc("readNote", ["hello"]) as {
      content: string;
    };
    assertEquals(note.content, "hi there");

    const titles = await pluginRpc("listTitles", []);
    assertEquals(titles, ["hello"]);

    const file = await pluginRpc("readFile", ["data.bin"]) as {
      mediaType: string;
      body: Uint8Array;
    };
    assertEquals(new TextDecoder().decode(file.body), "bytes");

    // Search needs an initial sync; run it synchronously via syncIndex.
    indexer.syncIndex();
    const hits = await pluginRpc("search", ["hi"]) as { title: string }[];
    assertEquals(hits.length, 1);
    assertEquals(hits[0].title, "hello");

    assertEquals(config.authType, AuthType.NONE);
  } finally {
    if (prevPath === undefined) Deno.env.delete("GLOBNOTES_PATH");
    else Deno.env.set("GLOBNOTES_PATH", prevPath);
    if (prevAuth === undefined) Deno.env.delete("GLOBNOTES_AUTH_TYPE");
    else Deno.env.set("GLOBNOTES_AUTH_TYPE", prevAuth);
    await Deno.remove(vault, { recursive: true });
  }
});
