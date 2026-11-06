// SPDX-License-Identifier: LGPL-3.0-only

/** Plugin contract 2 (docs/plugin-api.md "Contract version"): every plugin
 * write states its base through the same `base` parameter, renames included;
 * a stale base is merged (note text), kept as a conflict copy or refused per
 * `onStale`; reads return versions; render Workers cannot write files. */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { versionOf } from "../server/hub/merge.ts";
import { PLUGIN_CONTRACT_VERSION } from "../server/plugins/contracts.ts";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import type { ActionReceipt } from "../server/plugins/contracts.ts";

const WRITER = `
export function activate(ctx) {
  const run = (id, fn) => ctx.commands.register({ id, label: id, target: "server" }, fn);
  run("request", (a) => ctx.actions.request(a.action, a.args));
  run("file", (a) => ctx.files.requestWrite(a.path, new TextEncoder().encode(a.content), a.options));
  run("read", (a) => ctx.readNote(a.path));
  run("readFile", async (a) => { const r = await ctx.files.read(a.path); return { version: r.version, size: r.body.length }; });
  run("result", (id) => ctx.actions.result(id));
  run("snapshot", () => ctx.snapshot);
}
`;

async function writer() {
  const b = await pluginOperationsFixture({
    id: "writer",
    manifest: {
      runtime: { server: "service.js" },
      capabilities: {
        network: false,
        imports: false,
        read: ["vault"],
        write: ["vault"],
      },
    },
    files: { "service.js": WRITER },
  });
  const vault = b.fixture.vault;
  const receipt = async (requestId: string): Promise<ActionReceipt> => {
    let latest: ActionReceipt | undefined;
    await waitUntil(async () => {
      latest = await b.command("result", requestId) as ActionReceipt;
      return ["accepted", "running"].includes(latest.status)
        ? pending(latest)
        : done();
    }, { label: `receipt ${requestId}` });
    return latest!;
  };
  const request = async (action: string, args: Record<string, unknown>) =>
    await receipt(
      (await b.command("request", { action, args }) as { requestId: string })
        .requestId,
    );
  const file = async (
    path: string,
    content: string,
    options?: Record<string, unknown>,
  ) =>
    await receipt(
      (await b.command("file", { path, content, options }) as {
        requestId: string;
      }).requestId,
    );
  const version = (relative: string) =>
    versionOf(Deno.readFileSync(`${vault}/${relative}`));
  const read = (relative: string) =>
    Deno.readTextFileSync(`${vault}/${relative}`);
  const outside = (relative: string, text: string) =>
    Deno.writeTextFileSync(`${vault}/${relative}`, text);
  return { ...b, vault, request, file, version, read, outside };
}

Deno.test("plugin bases: every write without a base is refused and named contract 2", async () => {
  const w = await writer();
  try {
    await w.create("Note", "original");
    const v = w.version("Note.md");
    for (
      const [action, args] of [
        ["save", { path: "Note", newContent: "x" }],
        ["rename", { path: "Note", newPath: "Moved" }],
        ["delete", { path: "Note" }],
        ["file-write", { path: "Note.md", bytes: new Uint8Array([1]) }],
      ] as const
    ) {
      const result = await w.request(action, args);
      assertEquals(
        [result.status, result.error?.code],
        ["failed", "base_required"],
        action,
      );
    }
    const missing = await w.file("Note.md", "y");
    assertEquals(missing.error?.code, "base_required");
    assertEquals(w.read("Note.md"), "original");
    assertEquals(w.version("Note.md"), v);
    const diagnostics = w.runtime.status("writer")!.diagnostics;
    assert(diagnostics.some((d) => d.code === "plugin_contract_2"));
    // A create's implicit base is absent; another base kind is invalid.
    await assertRejects(() =>
      w.command("request", {
        action: "create",
        args: { path: "New", base: { kind: "version", version: v } },
      })
    );
    await assertRejects(() =>
      w.command("request", {
        action: "save",
        args: { path: "Note", newContent: "x", base: { kind: "nope" } },
      })
    );
  } finally {
    await w.close();
  }
});

Deno.test("plugin bases: a current base writes; reads and receipts carry versions", async () => {
  const w = await writer();
  try {
    await w.create("Note", "one");
    const read = await w.command("read", { path: "Note" }) as {
      version: string;
    };
    assertEquals(read.version, w.version("Note.md"));
    const saved = await w.request("save", {
      path: "Note",
      newContent: "two",
      base: { kind: "version", version: read.version },
    });
    assertEquals(saved.status, "completed");
    const note = saved.result as { version: string; saveResult: unknown };
    assertEquals(note.version, w.version("Note.md"));
    assertEquals(note.saveResult, { status: "saved" });
    const renamed = await w.request("rename", {
      path: "Note",
      newPath: "Moved",
      base: { kind: "version", version: note.version },
    });
    assertEquals(renamed.status, "completed");
    assertEquals(w.read("Moved.md"), "two");
    const removed = await w.request("delete", {
      path: "Moved",
      base: { kind: "version", version: w.version("Moved.md") },
    });
    assertEquals(removed.status, "completed");
    const created = await w.file("data.bin", "bytes", {
      base: { kind: "absent" },
    });
    assertEquals(created.status, "completed");
    assertEquals(created.result, {
      path: "data.bin",
      version: w.version("data.bin"),
      saveResult: { status: "saved" },
    });
    assertEquals(
      await w.command("readFile", { path: "data.bin" }),
      { version: w.version("data.bin"), size: 5 },
    );
  } finally {
    await w.close();
  }
});

Deno.test("plugin bases: a stale note write merges, keeps both or refuses", async () => {
  const w = await writer();
  try {
    await w.create("Note", "a\nb\nc\n");
    // Text base: a non-overlapping change elsewhere merges.
    w.outside("Note.md", "a\nb\nC\n");
    const merged = await w.request("save", {
      path: "Note",
      newContent: "A\nb\nc\n",
      base: { kind: "text", content: "a\nb\nc\n" },
    });
    assertEquals(
      (merged.result as { saveResult: unknown }).saveResult,
      { status: "merged" },
    );
    assertEquals(w.read("Note.md"), "A\nb\nC\n");
    // Version base: nothing to merge with; the default keeps both.
    const stale = versionOf(new TextEncoder().encode("a\nb\nc\n"));
    const copy = await w.request("save", {
      path: "Note",
      newContent: "mine",
      base: { kind: "version", version: stale },
    });
    const result = copy.result as {
      path: string;
      saveResult: { status: string; conflictCopyPath: string };
    };
    assertEquals(result.saveResult.status, "conflict");
    assert(/^Note\.conflict-\d{8}-\d{6}-globnotes$/.test(result.path));
    assertEquals(w.read(`${result.path}.md`), "mine");
    assertEquals(w.read("Note.md"), "A\nb\nC\n");
    assertEquals(
      w.hub.conflicts().at(-1)!.reason,
      "stale-base",
    );
    // onStale refuse: nothing written, the current version reported.
    const refused = await w.request("save", {
      path: "Note",
      newContent: "mine again",
      base: { kind: "version", version: stale },
      onStale: "refuse",
    });
    assertEquals(refused.error?.code, "base_stale");
    assertEquals(w.read("Note.md"), "A\nb\nC\n");
  } finally {
    await w.close();
  }
});

Deno.test("plugin bases: stale renames and deletes are refused (O4, O9)", async () => {
  const w = await writer();
  try {
    await w.create("Note", "one");
    const v = w.version("Note.md");
    w.outside("Note.md", "changed elsewhere");
    const rename = await w.request("rename", {
      path: "Note",
      newPath: "Moved",
      base: { kind: "version", version: v },
    });
    assertEquals(rename.error?.code, "base_stale");
    const remove = await w.request("delete", {
      path: "Note",
      base: { kind: "version", version: v },
      onStale: "copy",
    });
    assertEquals(remove.error?.code, "base_stale");
    assertEquals(w.read("Note.md"), "changed elsewhere");
    await assertRejects(() => Deno.stat(`${w.vault}/Moved.md`));
  } finally {
    await w.close();
  }
});

Deno.test("plugin bases: binary file writes compare versions, never merge", async () => {
  const w = await writer();
  try {
    await w.file("pic.bin", "first", { base: { kind: "absent" } });
    const v = w.version("pic.bin");
    w.outside("pic.bin", "theirs");
    const copy = await w.file("pic.bin", "mine", {
      base: { kind: "version", version: v },
    });
    const result = copy.result as {
      path: string;
      saveResult: { status: string; conflictCopyPath: string };
    };
    assertEquals(result.saveResult.status, "conflict");
    assert(/^pic\.conflict-\d{8}-\d{6}-globnotes\.bin$/.test(result.path));
    assertEquals(w.read(result.path), "mine");
    assertEquals(w.read("pic.bin"), "theirs");
    const refused = await w.file("pic.bin", "mine", {
      base: { kind: "version", version: v },
      onStale: "refuse",
    });
    assertEquals(refused.error?.code, "base_stale");
    // An absent base on an existing file is stale too.
    const exists = await w.file("pic.bin", "x", {
      base: { kind: "absent" },
      onStale: "refuse",
    });
    assertEquals(exists.error?.code, "base_stale");
    // Notes through requestWrite: absent base on an existing note keeps both.
    await w.create("Doc", "theirs");
    const note = await w.file("Doc.md", "mine", { base: { kind: "absent" } });
    assertEquals(
      (note.result as { saveResult: { status: string } }).saveResult.status,
      "conflict",
    );
    assertEquals(w.read("Doc.md"), "theirs");
  } finally {
    await w.close();
  }
});

Deno.test("plugin contract 2: published everywhere; render Workers cannot write files", async () => {
  assertEquals(PLUGIN_CONTRACT_VERSION, 2);
  const w = await writer();
  try {
    const snapshot = await w.command("snapshot") as { contractVersion: number };
    assertEquals(snapshot.contractVersion, 2);
  } finally {
    await w.close();
  }
  const fixture = await pluginFixture();
  try {
    await fixture.install("raw", {
      capabilities: { network: false, imports: false, write: ["vault"] },
    }, {
      "main.js": `export function getSelectors(){return [];}
export async function parseNode(){
  try { await Deno.writeTextFile(${
        JSON.stringify(`${fixture.vault}/raw.txt`)
      }, "raw"); return { parts: ["written"] }; }
  catch (error) { return { parts: [error.name] }; } // Deno: NotCapable (no write permission)
}`,
    });
    const manager = createPluginManager(
      fixture.vault,
      () => Promise.resolve(null),
      1,
      fixture.statePath,
      { internalRoot: `${fixture.root}/no-internal` },
    );
    try {
      const catalog = await manager.catalog();
      assertEquals(catalog.contractVersion, 2);
      const raw = catalog.plugins.find((p) => p.id === "raw")!;
      assert(
        raw.diagnostics.some((d) => d.code === "plugin_write_grants_unused"),
      );
      await manager.start();
      assertEquals(
        await manager.hosts.get("raw")!.call("parseNode", [{}]),
        { parts: ["NotCapable"] },
      );
      await assertRejects(() => Deno.stat(`${fixture.vault}/raw.txt`));
    } finally {
      manager.stop();
    }
  } finally {
    await fixture.dispose();
  }
});
