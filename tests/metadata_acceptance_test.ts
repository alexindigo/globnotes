// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { storageServerFixture } from "./helpers/driver_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { catalogPluginReady } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import type {
  MetadataPage,
  MetadataRecord,
} from "../server/metadata/contracts.ts";
import { versionOf } from "../server/hub/merge.ts";

function body(value: string) {
  return `---\norigin: ${value}\n---\n# ${value}\n[[${value}|label]]\n- [x] ${value} task\nfield:: ${value}`;
}
Deno.test("metadata acceptance: real server Worker get/query/watch follows local/API/plugin/M5 driver current bytes, rename/delete and restart rebuild", async () => {
  const remote = memoryRemote();
  const f = await storageServerFixture([remote.authority]);
  const id = "metadata-consumer";
  const command = async (name: string, args: unknown = {}) =>
    (await f.call(`plugin-host/${id}/commands/${name}`, "POST", args)).result;
  const page = () => command("query", {}) as Promise<MetadataPage>;
  const waitRows = (expected: string[]) =>
    waitUntil(async () => {
      const result = await page();
      return !result.catchingUp &&
          JSON.stringify(result.rows.map((r) => r.path).sort()) ===
            JSON.stringify(expected.sort())
        ? done(result)
        : pending(result);
    }, { label: "Worker metadata end consumer", children: [f.server()] });
  const ready = (record: MetadataRecord, value: string) => {
    assertEquals(record.status, "ready");
    if (record.status !== "ready") return;
    assertEquals(record.properties, [{
      key: "origin",
      value: { kind: "scalar", text: value },
    }]);
    assertEquals(record.headings, [{ level: 1, text: value, line: 4 }]);
    assertEquals(record.links, [{
      target: value,
      label: "label",
      embed: false,
      line: 5,
    }]);
    assertEquals(record.tasks, [{
      text: `${value} task field:: ${value}`,
      checked: true,
      line: 6,
    }]);
    assertEquals(record.fields, [{ key: "field", value, line: 7 }]);
    assertEquals(
      record.version,
      versionOf(Deno.readFileSync(`${f.vault}/${record.path}`)),
    );
  };
  try {
    await f.install(id, {
      id,
      runtime: { server: "service.js" },
      capabilities: { read: ["vault"], write: ["vault"] },
    }, {
      "service.js": `export function activate(ctx){
    let latest=null;ctx.metadata.watch({},page=>{latest=page;});
    ctx.commands.register({id:'watch',label:'Watch',target:'server'},()=>latest);
    ctx.commands.register({id:'query',label:'Query',target:'server'},q=>ctx.metadata.query(q));
    ctx.commands.register({id:'get',label:'Get',target:'server'},p=>ctx.metadata.get(p));
    ctx.commands.register({id:'write',label:'Write',target:'server'},a=>ctx.files.requestWrite(a.path,new TextEncoder().encode(a.content),{base:a.base??{kind:'absent'}}));
    ctx.commands.register({id:'action',label:'Action',target:'server'},a=>ctx.actions.request(a.action,a.args));
   }`,
    });
    const catalog = await f.call("plugin-host");
    await f.call(`plugin-host/${id}/enabled`, "PUT", {
      enabled: true,
      revision: catalog.policy.revision,
      signature: catalog.policy.signature,
    });
    await catalogPluginReady(f.server(), id);
    await waitRows([]);
    Deno.writeTextFileSync(`${f.vault}/folder.md`, body("folder"));
    ready((await waitRows(["folder.md"])).rows[0], "folder");
    await f.call("notes", "POST", { path: "editor", content: body("editor") });
    await waitRows(["folder.md", "editor.md"]);
    await command("write", { path: "plugin.md", content: body("plugin") });
    await waitRows(["folder.md", "editor.md", "plugin.md"]);
    remote.put("driver.md", body("driver"));
    const peer = await f.add(remote.baseUrl, remote.token);
    await f.sync(peer);
    let result = await waitRows([
      "driver.md",
      "editor.md",
      "folder.md",
      "plugin.md",
    ]);
    for (const record of result.rows) {
      ready(record, record.path.slice(0, -3));
      assertEquals(await command("get", record.path), record);
    }
    const watched = await waitUntil(async () => {
      const watch = await command("watch") as MetadataPage | null;
      return watch && !watch.catchingUp && watch.rows.length === 4
        ? done(watch)
        : pending(watch);
    }, { label: "live all-origin metadata", children: [f.server()] });
    for (const record of watched.rows) ready(record, record.path.slice(0, -3));
    // Exercise changes of each origin, not just initial inventory parsing.
    Deno.writeTextFileSync(`${f.vault}/folder.md`, body("changed-folder"));
    const editor = await f.call("notes/editor");
    await f.call("notes/editor", "PATCH", {
      newContent: body("changed-editor"),
      baseContent: editor.content,
    });
    remote.put("driver.md", body("changed-driver"));
    await f.sync(peer);
    const pluginNote = await f.call("notes/plugin");
    await command("write", {
      path: "plugin.md",
      content: body("changed-plugin"),
      base: { kind: "version", version: pluginNote.version },
    });
    await waitUntil(async () => {
      result = await page();
      return !result.catchingUp &&
          result.rows.filter((r) =>
              r.status === "ready" && r.headings[0]?.text.startsWith("changed-")
            ).length === 4
        ? done()
        : pending(result);
    }, { label: "changed all-peer metadata" });
    for (const record of result.rows) {
      assert(record.status === "ready");
      ready(record, record.headings[0].text);
      assertEquals(await command("get", record.path), record);
    }
    // Managed H1 edits rename editor/plugin notes through the existing operation.
    assertEquals(await command("get", "editor.md"), null);
    assertEquals(await command("get", "plugin.md"), null);
    Deno.renameSync(`${f.vault}/folder.md`, `${f.vault}/renamed.md`);
    await waitRows([
      "driver.md",
      "changed-editor.md",
      "changed-plugin.md",
      "renamed.md",
    ]);
    assertEquals(await command("get", "folder.md"), null);
    Deno.removeSync(`${f.vault}/renamed.md`);
    await waitRows(["driver.md", "changed-editor.md", "changed-plugin.md"]);
    remote.delete("driver.md");
    remote.put("driver-renamed.md", body("changed-driver"));
    await f.sync(peer);
    await waitRows([
      "driver-renamed.md",
      "changed-editor.md",
      "changed-plugin.md",
    ]);
    remote.delete("driver-renamed.md");
    await f.sync(peer);
    await waitRows(["changed-editor.md", "changed-plugin.md"]);
    const changedEditor = await f.call("notes/changed-editor");
    await f.call("notes/changed-editor", "PATCH", {
      newPath: "editor-renamed",
      baseContent: changedEditor.content,
    });
    await waitRows(["editor-renamed.md", "changed-plugin.md"]);
    const editorRenamed = await f.call("notes/editor-renamed");
    await f.call(
      `notes/editor-renamed?base_version=${editorRenamed.version}`,
      "DELETE",
    );
    await waitRows(["changed-plugin.md"]);
    const changedPlugin = await f.call("notes/changed-plugin");
    await command("action", {
      action: "rename",
      args: {
        path: "changed-plugin",
        newPath: "plugin-renamed",
        base: { kind: "version", version: changedPlugin.version },
      },
    });
    await waitRows(["plugin-renamed.md"]);
    const oldRevision = (await page()).revision;
    await f.restart();
    await catalogPluginReady(f.server(), id);
    result = await waitRows(["plugin-renamed.md"]);
    assert(result.revision !== oldRevision);
    assert(!JSON.stringify(result).includes("changed-folder"));
    const renamedPlugin = await f.call("notes/plugin-renamed");
    await command("action", {
      action: "delete",
      args: {
        path: "plugin-renamed",
        base: { kind: "version", version: renamedPlugin.version },
      },
    });
    await waitRows([]);
    await waitUntil(async () => {
      const watch = await command("watch") as MetadataPage | null;
      return watch && !watch.catchingUp && watch.total === 0
        ? done()
        : pending(watch);
    }, { label: "watch removes all deleted metadata" });
    for (const name of ["hub.sqlite", "hub.sqlite-wal"]) {
      try {
        const raw = new TextDecoder().decode(
          Deno.readFileSync(`${f.statePath}/${name}`),
        );
        assert(!raw.includes("changed-folder"));
        assert(!raw.includes("field::"));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  } finally {
    await f.close();
    await remote.close();
  }
});
