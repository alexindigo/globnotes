// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { VaultHub } from "../server/hub/hub.ts";
import type { ChangeEntry } from "../server/hub/types.ts";
import {
  FileSystemNotes,
  type StorageProbes,
} from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { requesterAuthority } from "../server/plugins/lifecycle.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import type { PluginRuntime } from "../server/plugins/runtime.ts";
import { initState, state } from "../server/state.ts";
import { fixtureApiOrigin } from "./helpers/plugin_fixture.ts";

export function hubOperationsFixture(probes: StorageProbes = {}) {
  const previous = { ...state }, env = { ...Deno.env.toObject() };
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/vault`);
  Deno.env.set("GLOBNOTES_PATH", `${root}/vault`);
  Deno.env.set("GLOBNOTES_INDEX_PATH", `${root}/state`);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  const config = new GlobalConfig(),
    notes = new FileSystemNotes(config.notesPath, probes);
  const files = new FileServing(config.notesPath),
    hub = new VaultHub(config.notesPath, config.statePath);
  initState(config, null, notes, null, files, null, hub);
  const lifecycle = new PluginLifecycle(config);
  state.lifecycle = lifecycle;
  const runtime = {
    limits: { preOperationMs: 5000 },
    guard: () => [],
    assertGuardAuthority: () => {},
  } as unknown as PluginRuntime;
  const operations = new NoteOperations({
    notes,
    files,
    hub,
    indexer: null,
    lifecycle,
    runtime: () => runtime,
  });
  state.operations = operations;
  const batches: ChangeEntry[][] = [];
  hub.subscribe((entries) => batches.push(entries));
  return {
    root,
    vault: config.notesPath,
    config,
    notes,
    files,
    lifecycle,
    operations,
    hub,
    batches,
    api: () => fixtureApiOrigin(lifecycle),
    close() {
      hub.stop();
      Object.assign(state, previous);
      for (
        const key of [
          "GLOBNOTES_PATH",
          "GLOBNOTES_INDEX_PATH",
          "GLOBNOTES_AUTH_TYPE",
        ]
      ) {
        if (env[key] === undefined) Deno.env.delete(key);
        else Deno.env.set(key, env[key]);
      }
      Deno.removeSync(root, { recursive: true });
    },
  };
}

Deno.test("hub operations: create/save/rename/delete and uploads are globnotes with no forced-scan echo", async () => {
  const f = hubOperationsFixture();
  try {
    await f.operations.createNote(
      { path: "note", content: "initial" },
      f.api(),
    );
    await f.operations.updateNote(
      "note",
      { newContent: "modified" },
      "none",
      f.api(),
    );
    await f.operations.updateNote(
      "note",
      { newPath: "folder/moved" },
      "none",
      f.api(),
    );
    await f.operations.uploadFile(
      "",
      "asset.png",
      new Uint8Array([1, 2, 3]),
      f.api(),
    );
    await f.operations.uploadFile(
      "",
      "uploaded.md",
      new TextEncoder().encode("upload"),
      f.api(),
    );
    await f.operations.deleteNote("folder/moved", f.api());
    assertEquals(f.batches.flat().map((e) => e.kind), [
      "created",
      "modified",
      "renamed",
      "created",
      "created",
      "deleted",
    ]);
    assert(
      f.batches.flat().every((e) =>
        e.peer === "globnotes" && e.origin === "api"
      ),
    );
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});
Deno.test("hub operations: partial storage failures record actual effects and release expectation", async () => {
  let fail = false;
  const f = hubOperationsFixture({
    afterWrite: () => {
      if (fail) throw new Error("after write fixture");
    },
  });
  try {
    await f.operations.createNote(
      { path: "partial", content: "before" },
      f.api(),
    );
    fail = true;
    await assertRejects(() =>
      f.operations.updateNote(
        "partial",
        { newContent: "completed partial bytes" },
        "none",
        f.api(),
      )
    );
    assertEquals(f.batches.at(-1)![0].peer, "globnotes");
    assertEquals(f.batches.at(-1)![0].kind, "modified");
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
    Deno.writeTextFileSync(`${f.vault}/partial.md`, "outside after error");
    f.hub.scanNow();
    assertEquals(f.batches.at(-1)![0].peer, "local");
  } finally {
    f.close();
  }
});
Deno.test("hub operations: attachment moves and reference rewrites record all actual file effects", async () => {
  const f = hubOperationsFixture();
  try {
    await f.operations.uploadFile(
      "",
      "image.png",
      new Uint8Array([1]),
      f.api(),
    );
    await f.operations.createNote({
      path: "note",
      content: "![image](image.png)",
    }, f.api());
    await f.operations.updateNote(
      "note",
      { newPath: "folder/note" },
      "move",
      f.api(),
    );
    const batch = f.batches.at(-1)!;
    assertEquals(
      new Set(batch.map((e) => e.path)),
      new Set(["folder/image.png", "folder/note.md"]),
    );
    assert(batch.every((e) => e.kind === "renamed"));
    await f.operations.rewriteRefs(
      "folder/image.png",
      "folder/other.png",
      f.api(),
    );
    assertEquals(f.batches.at(-1)![0].path, "folder/note.md");
    assertEquals(f.batches.at(-1)![0].kind, "modified");
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});

Deno.test("hub operations: requester identity attributes plugin notes and mediated non-note writes", async () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.root}/writer`);
    Deno.writeTextFileSync(`${f.root}/writer/main.js`, "export default {};\n");
    Deno.writeTextFileSync(
      `${f.root}/writer/manifest.json`,
      JSON.stringify({ id: "writer", capabilities: { write: ["vault"] } }),
    );
    const requester = requesterAuthority(
      readManifest(`${f.root}/writer`),
      f.vault,
      f.config.statePath,
      "fixture-generation",
      () => true,
    );
    await f.operations.createNote(
      { path: "plugin-note", content: "plugin content" },
      { origin: "plugin" },
      requester,
    );
    await f.operations.writeExternalFile(
      {
        kind: "file",
        absolutePath: `${f.vault}/plugin.bin`,
        requestedPath: "plugin.bin",
      },
      new Uint8Array([3, 4]),
      { origin: "plugin" },
      requester,
    );
    assert(
      f.batches.flat().every((entry) =>
        entry.peer === "globnotes" && entry.origin === "plugin:writer"
      ),
    );
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});

for (const failure of ["rename", "remove"] as const) {
  Deno.test(`hub operations: post-${failure} failure records completed effects without echo`, async () => {
    let armed = false;
    const f = hubOperationsFixture({
      afterRename() {
        if (armed && failure === "rename") {
          throw new Error("after rename fixture");
        }
      },
      afterRemove() {
        if (armed && failure === "remove") {
          throw new Error("after removal fixture");
        }
      },
    });
    try {
      await f.operations.createNote({
        path: "old/note",
        content: "partial bytes",
      }, f.api());
      armed = true;
      await assertRejects(() =>
        failure === "rename"
          ? f.operations.updateNote(
            "old/note",
            { newPath: "new/note" },
            "none",
            f.api(),
          )
          : f.operations.deleteNote("old/note", f.api())
      );
      assertEquals(
        f.batches.at(-1)![0].kind,
        failure === "rename" ? "renamed" : "deleted",
      );
      assertEquals(f.hub.fileState("old/note.md"), null);
      const count = f.batches.length;
      f.hub.scanNow();
      assertEquals(f.batches.length, count);
    } finally {
      f.close();
    }
  });
}

Deno.test("hub operations: partial ref rewrite includes the completed write whose after-effect probe failed", async () => {
  let armed = false, writes = 0;
  const f = hubOperationsFixture({
    afterWrite() {
      if (armed && ++writes === 2) throw new Error("second rewrite fixture");
    },
  });
  try {
    await f.operations.uploadFile("", "old.png", new Uint8Array([1]), f.api());
    for (const name of ["a", "b", "c"]) {
      await f.operations.createNote({
        path: name,
        content: "![asset](old.png)",
      }, f.api());
    }
    armed = true;
    await assertRejects(() =>
      f.operations.rewriteRefs("old.png", "new.png", f.api())
    );
    assertEquals(f.batches.at(-1)!.length, 2);
    assert(
      f.batches.at(-1)!.every((entry) =>
        entry.peer === "globnotes" && entry.kind === "modified" &&
        Deno.readTextFileSync(`${f.vault}/${entry.path}`).includes("new.png")
      ),
    );
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});

Deno.test("hub operations: deleting an unscanned local file records local create then managed delete and tombstone", async () => {
  const f = hubOperationsFixture();
  try {
    Deno.writeTextFileSync(
      `${f.vault}/unobserved.md`,
      "outside before debounce",
    );
    await f.operations.deleteNote("unobserved", f.api());
    const entries = f.batches.flat();
    assertEquals(entries.map((entry) => [entry.peer, entry.kind]), [
      ["local", "created"],
      ["globnotes", "deleted"],
    ]);
    assertEquals(entries.map((entry) => entry.seq), [1, 2]);
    assertEquals(f.hub.fileState("unobserved.md"), null);
    const tombstones = f.hub.store.db.prepare("SELECT * FROM tombstones").all();
    assertEquals(tombstones.length, 1);
    assertEquals(JSON.parse(tombstones[0].vector as string), {
      local: 1,
      globnotes: 1,
    });
    assert(f.hub.changesSince(0).entries.every((entry) => entry.path === null));
    f.hub.scanNow();
    assertEquals(f.batches.flat().length, entries.length);
  } finally {
    f.close();
  }
});

Deno.test("hub operations: moving an attachment directory first ingests unscanned children and has no local echo", async () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.vault}/assets`);
    Deno.writeTextFileSync(
      `${f.vault}/assets/new.png`,
      "outside child before debounce",
    );
    await f.operations.createNote(
      { path: "note", content: "[assets](assets)" },
      f.api(),
    );
    assertEquals(
      f.hub.fileState("assets/new.png"),
      null,
      "unrelated files are not scanned by note creation",
    );
    await f.operations.updateNote(
      "note",
      { newPath: "folder/note" },
      "move",
      f.api(),
    );
    const childEntries = f.batches.flat().filter((entry) =>
      entry.path?.endsWith("new.png")
    );
    assertEquals(
      childEntries.map((entry) => [entry.peer, entry.kind, entry.path]),
      [
        ["local", "created", "assets/new.png"],
        ["globnotes", "renamed", "folder/assets/new.png"],
      ],
    );
    assert(childEntries[0].seq < childEntries[1].seq);
    assertEquals(f.hub.fileState("folder/assets/new.png")?.vector, {
      local: 1,
      globnotes: 1,
    });
    assertEquals(f.hub.fileState("assets/new.png"), null);
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});

Deno.test("hub operations: a save reconciles an unscanned outside modification before its managed version", async () => {
  const f = hubOperationsFixture();
  try {
    await f.operations.createNote(
      { path: "note", content: "initial" },
      f.api(),
    );
    Deno.writeTextFileSync(
      `${f.vault}/note.md`,
      "outside modification before debounce",
    );
    await f.operations.updateNote(
      "note",
      { newContent: "managed result" },
      "none",
      f.api(),
    );
    const entries = f.batches.flat();
    assertEquals(entries.map((entry) => [entry.peer, entry.kind]), [
      ["globnotes", "created"],
      ["local", "modified"],
      ["globnotes", "modified"],
    ]);
    assertEquals(entries[2].beforeHash, entries[1].afterHash);
    assertEquals(f.hub.fileState("note.md")?.vector, {
      local: 1,
      globnotes: 2,
    });
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});

Deno.test("hub operations: recreation reconciles an unscanned outside deletion before the new version", async () => {
  const f = hubOperationsFixture();
  try {
    await f.operations.createNote(
      { path: "note", content: "initial" },
      f.api(),
    );
    Deno.removeSync(`${f.vault}/note.md`);
    await f.operations.createNote(
      { path: "note", content: "recreated" },
      f.api(),
    );
    assertEquals(f.batches.flat().map((entry) => [entry.peer, entry.kind]), [
      ["globnotes", "created"],
      ["local", "deleted"],
      ["globnotes", "created"],
    ]);
    assertEquals(f.hub.fileState("note.md")?.vector, {
      local: 1,
      globnotes: 2,
    });
    assertEquals(
      f.hub.store.db.prepare("SELECT COUNT(*) AS n FROM tombstones").get()!.n,
      0,
    );
    const count = f.batches.length;
    f.hub.scanNow();
    assertEquals(f.batches.length, count);
  } finally {
    f.close();
  }
});
