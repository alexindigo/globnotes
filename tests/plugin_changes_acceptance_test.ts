// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { storageServerFixture } from "./helpers/driver_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { catalogPluginReady } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { versionOf } from "../server/hub/merge.ts";

interface ExampleState {
  rows: Record<
    string,
    {
      path?: string;
      body?: string;
      version?: string;
      seq: number;
      status: string;
    }
  >;
  facts: { seq: number; peer: string; origin: string | null; kind: string }[];
  cursor: number;
  resets: number;
  caughtUp: boolean;
}

Deno.test("log example acceptance: real server Worker persists all four origins, keyed renames/deletes and restart resume without historical-byte claims", async () => {
  const remote = memoryRemote();
  const f = await storageServerFixture([remote.authority]);
  const id = "globnotes-log-example";
  const root = new URL(`./fixtures/plugins/${id}/`, import.meta.url);
  const load = (): ExampleState | null => {
    try {
      return JSON.parse(
        Deno.readTextFileSync(`${f.statePath}/plugin-data/${id}/data.json`),
      ).values;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
  const waitState = (predicate: (state: ExampleState) => boolean) =>
    waitUntil(() => {
      const state = load();
      return state && predicate(state) ? done(state) : pending(state);
    }, { label: "persisted example end consumer", children: [f.server()] });
  const byPath = (state: ExampleState, path: string) =>
    Object.values(state.rows).find((row) => row.path === path);
  const enabled = async (value: boolean) => {
    const catalog = await f.call("plugin-host");
    await f.call(`plugin-host/${id}/enabled`, "PUT", {
      enabled: value,
      revision: catalog.policy.revision,
      signature: catalog.policy.signature,
    });
    if (value) await catalogPluginReady(f.server(), id);
  };
  try {
    await f.install(
      id,
      JSON.parse(Deno.readTextFileSync(new URL("manifest.json", root))),
      {
        "service.js": Deno.readTextFileSync(new URL("service.js", root)),
      },
    );
    await enabled(true);
    await waitState((state) => state.caughtUp);
    Deno.writeTextFileSync(`${f.vault}/folder.md`, "folder origin bytes");
    let state = await waitState((state) =>
      byPath(state, "folder.md")?.body === "folder origin bytes"
    );
    assert(state.facts.some((fact) => fact.peer === "local"));
    await f.call("notes", "POST", {
      path: "editor",
      content: "editor origin bytes",
    });
    state = await waitState((state) =>
      byPath(state, "editor.md")?.body === "editor origin bytes"
    );
    assert(
      state.facts.some((fact) =>
        fact.peer === "globnotes" && fact.origin === "api"
      ),
    );
    await f.call(`plugin-host/${id}/commands/write`, "POST", {
      path: "plugin.md",
      content: "plugin origin bytes",
      base: { kind: "absent" },
    });
    state = await waitState((state) =>
      byPath(state, "plugin.md")?.body === "plugin origin bytes"
    );
    assert(state.facts.some((fact) => fact.origin === `plugin:${id}`));
    remote.put("driver.md", "driver origin bytes");
    const peer = await f.add(remote.baseUrl, remote.token);
    await f.sync(peer);
    state = await waitState((state) =>
      byPath(state, "driver.md")?.body === "driver origin bytes"
    );
    assert(state.facts.some((fact) => fact.peer === peer));
    for (const row of Object.values(state.rows)) {
      assertEquals(row.status, "current");
      assertEquals(
        row.version,
        versionOf(Deno.readFileSync(`${f.vault}/${row.path}`)),
      );
    }
    Deno.writeTextFileSync(
      `${f.vault}/disk-move.md`,
      "local rename then delete",
    );
    await waitState((state) => !!byPath(state, "disk-move.md"));
    Deno.renameSync(`${f.vault}/disk-move.md`, `${f.vault}/disk-moved.md`);
    state = await waitState((state) =>
      !!byPath(state, "disk-moved.md") && !byPath(state, "disk-move.md")
    );
    assert(
      state.facts.some((fact) =>
        fact.peer === "local" && fact.kind === "renamed"
      ),
    );
    Deno.removeSync(`${f.vault}/disk-moved.md`);
    await waitState((state) => !byPath(state, "disk-moved.md"));
    const pluginNote = await f.call("notes/plugin");
    await f.call(`plugin-host/${id}/commands/action`, "POST", {
      action: "rename",
      args: {
        path: "plugin",
        newPath: "plugin-renamed",
        base: { kind: "version", version: pluginNote.version },
      },
    });
    state = await waitState((state) =>
      !!byPath(state, "plugin-renamed.md") && !byPath(state, "plugin.md")
    );
    assert(
      state.facts.some((fact) =>
        fact.origin === `plugin:${id}` && fact.kind === "renamed"
      ),
    );
    const pluginRenamed = await f.call("notes/plugin-renamed");
    await f.call(`plugin-host/${id}/commands/action`, "POST", {
      action: "delete",
      args: {
        path: "plugin-renamed",
        base: { kind: "version", version: pluginRenamed.version },
      },
    });
    state = await waitState((state) => !byPath(state, "plugin-renamed.md"));
    assert(
      state.facts.some((fact) =>
        fact.origin === `plugin:${id}` && fact.kind === "deleted"
      ),
    );
    remote.delete("driver.md");
    remote.put("driver-renamed.md", "driver origin bytes");
    await f.sync(peer);
    await waitState((state) =>
      byPath(state, "driver-renamed.md")?.body === "driver origin bytes" &&
      !byPath(state, "driver.md")
    );
    remote.delete("driver-renamed.md");
    await f.sync(peer);
    state = await waitState((state) => !byPath(state, "driver-renamed.md"));
    assert(
      state.facts.some((fact) => fact.peer === peer && fact.kind === "deleted"),
    );
    const editor = await f.call("notes/editor");
    await f.call("notes/editor", "PATCH", {
      newPath: "renamed",
      baseContent: editor.content,
    });
    state = await waitState((state) =>
      !!byPath(state, "renamed.md") && !byPath(state, "editor.md")
    );
    assert(state.facts.some((fact) => fact.kind === "renamed"));
    // Anonymous delete removes keyed state, including its content, rather than
    // requiring the host to retain a deleted pathname for this consumer.
    Deno.removeSync(`${f.vault}/folder.md`);
    state = await waitState((state) => !byPath(state, "folder.md"));
    assert(!JSON.stringify(state).includes("folder origin bytes"));
    assert(!JSON.stringify(state).includes("folder.md"));
    for (const name of ["hub.sqlite", "hub.sqlite-wal"]) {
      let bytes: Uint8Array;
      try {
        bytes = Deno.readFileSync(`${f.statePath}/${name}`);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      const raw = new TextDecoder().decode(bytes);
      assert(!raw.includes("folder.md"), `${name} retains a deleted filename`);
      assert(
        !raw.includes("folder origin bytes"),
        `${name} retains note bytes`,
      );
    }
    const renamed = await f.call("notes/renamed");
    await f.call(`notes/renamed?base_version=${renamed.version}`, "DELETE");
    await waitState((state) => !byPath(state, "renamed.md"));
    const resets = load()!.resets;
    await enabled(false);
    await f.call("notes", "POST", {
      path: "while-off",
      content: "off backlog",
    });
    await enabled(true);
    state = await waitState((state) =>
      byPath(state, "while-off.md")?.body === "off backlog"
    );
    assertEquals(state.resets, resets);
    await f.restart();
    await catalogPluginReady(f.server(), id);
    await f.call("notes", "POST", {
      path: "after-restart",
      content: "durable resume",
    });
    state = await waitState((state) =>
      byPath(state, "after-restart.md")?.body === "durable resume"
    );
    assertEquals(state.resets, resets);
    assertEquals(
      new Set(state.facts.map((fact) => fact.seq)).size,
      state.facts.length,
    );
    assertEquals(Object.values(state.rows).map((row) => row.path).sort(), [
      "after-restart.md",
      "while-off.md",
    ]);
  } finally {
    await f.close();
    await remote.close();
  }
});
