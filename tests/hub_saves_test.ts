// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { contentVersion, mergeText } from "../server/hub/merge.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import {
  PluginGuardError,
  type PluginRuntime,
} from "../server/plugins/runtime.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";

function fixture() {
  const f = hubOperationsFixture();
  const guards: string[] = [];
  let cancel = false;
  const runtime = {
    limits: { preOperationMs: 5000 },
    guard: (hook: string) => {
      guards.push(hook);
      if (cancel && hook === "pre-create") {
        throw new PluginGuardError("protector", "pre-create", "blocked", true);
      }
      return [];
    },
    assertGuardAuthority() {},
  } as unknown as PluginRuntime;
  const ops = new NoteOperations({
    notes: f.notes,
    files: f.files,
    hub: f.hub,
    indexer: null,
    lifecycle: f.lifecycle,
    runtime: () => runtime,
    now: () => new Date("2026-10-29T12:00:00Z"),
  });
  const save = (baseContent: string, newContent: string, newPath = "note") =>
    ops.updateNote(
      "note",
      { baseContent, newContent, newPath },
      "none",
      f.api(),
    );
  return {
    ...f,
    ops,
    save,
    guards,
    cancel: () => {
      cancel = true;
    },
  };
}

Deno.test("hub saves: equal base writes and returns the recorded content version", async () => {
  const f = fixture();
  try {
    await f.ops.createNote({ path: "note", content: "base\n" }, f.api());
    const result = await f.save("base\n", "mine\n");
    assertEquals(result.saveResult, { status: "saved" });
    assertEquals(result.content, "mine\n");
    assertEquals(result.version, f.hub.fileState("note.md")!.hash);
    assertEquals(result.version, contentVersion("mine\n"));
  } finally {
    f.close();
  }
});

Deno.test("hub saves: independent edits merge, including rename, without persisting base bytes", async () => {
  const f = fixture();
  try {
    const base = "private-request-base-token\nmiddle\nend\n";
    await f.ops.createNote({ path: "note", content: base }, f.api());
    Deno.writeTextFileSync(`${f.vault}/note.md`, "theirs\nmiddle\nend\n");
    const result = await f.save(
      base,
      "private-request-base-token\nmiddle\nmine\n",
      "folder/moved",
    );
    assertEquals(result.saveResult, { status: "merged" });
    assertEquals(result.path, "folder/moved");
    assertEquals(result.content, "theirs\nmiddle\nmine\n");
    assertEquals(f.notes.get("folder/moved").content, result.content);
    f.hub.store.checkpoint();
    for (const suffix of ["", "-wal"]) {
      const text = new TextDecoder().decode(
        Deno.readFileSync(`${f.config.statePath}/hub.sqlite${suffix}`),
      );
      assert(!text.includes("private-request-base-token"));
    }
    assert(!JSON.stringify(f.batches).includes("private-request-base-token"));
  } finally {
    f.close();
  }
});

Deno.test("hub saves: overlap keeps original, ignores requested rename, exclusively creates numbered copies", async () => {
  const f = fixture();
  try {
    await f.ops.createNote({ path: "note", content: "base" }, f.api());
    Deno.writeTextFileSync(`${f.vault}/note.md`, "theirs");
    const first = await f.save("base", "mine", "unwanted-rename");
    const copy = "note.conflict-20261029-120000-globnotes";
    assertEquals(first.path, copy);
    assertEquals(first.saveResult, {
      status: "conflict",
      conflictCopyPath: copy,
    });
    assertEquals(f.notes.get("note").content, "theirs");
    assertEquals(f.notes.get(copy).content, "mine");
    const second = await f.save("base", "second mine");
    assertEquals(second.path, copy + "-2");
    assertEquals(f.notes.get(copy).content, "mine");
    assertEquals(f.notes.get(copy + "-2").content, "second mine");
    const conflicts = f.hub.conflicts();
    assertEquals(conflicts.length, 2);
    assertEquals(conflicts[0].path, "note.md");
    assertEquals(
      new Set(conflicts.map((c) => c.copyPath)),
      new Set([copy + ".md", copy + "-2.md"]),
    );
    assert(
      conflicts.every((c) => c.state === "open" && c.peer === "globnotes"),
    );
    assert(f.guards.includes("pre-create"));
    f.hub.scanNow();
    assert(
      f.batches.flat().filter((e) => e.path?.includes("conflict")).every((e) =>
        e.peer === "globnotes"
      ),
    );
  } finally {
    f.close();
  }
});

Deno.test("hub saves: deleted original is recreated through guarded creation", async () => {
  const f = fixture();
  try {
    await f.ops.createNote({ path: "note", content: "base" }, f.api());
    Deno.removeSync(`${f.vault}/note.md`);
    const result = await f.save("base", "kept text");
    assertEquals(result.saveResult, { status: "saved", recreated: true });
    assertEquals(f.notes.get("note").content, "kept text");
    assertEquals(f.hub.fileState("note.md")!.vector, {
      globnotes: 2,
      local: 1,
    });
  } finally {
    f.close();
  }
});

Deno.test("hub saves: cancelled conflict-copy guard writes nothing and records no conflict", async () => {
  const f = fixture();
  try {
    await f.ops.createNote({ path: "note", content: "base" }, f.api());
    Deno.writeTextFileSync(`${f.vault}/note.md`, "theirs");
    f.cancel();
    const error = await assertRejects(() => f.save("base", "mine"));
    assertEquals((error as { code: string }).code, "plugin_cancelled");
    assertEquals(f.notes.get("note").content, "theirs");
    assertEquals([...Deno.readDirSync(f.vault)].map((e) => e.name), [
      "note.md",
    ]);
    assertEquals(f.hub.conflicts(), []);
  } finally {
    f.close();
  }
});

Deno.test("hub saves: no writer replaces, renames or deletes without a base", async () => {
  const f = fixture();
  try {
    await f.ops.createNote({ path: "note", content: "theirs" }, f.api());
    for (
      const attempt of [
        () => f.ops.updateNote("note", { newContent: "x" }, "none", f.api()),
        () => f.ops.updateNote("note", { newPath: "moved" }, "none", f.api()),
        () => f.ops.deleteNote("note", f.api()),
      ]
    ) {
      const error = await attempt().catch((e) => e);
      assertEquals([error.status, error.code], [428, "base_required"]);
    }
    assertEquals(f.notes.get("note").content, "theirs");
    assertEquals(f.notes.getPaths(), ["note"]);
  } finally {
    f.close();
  }
});

Deno.test("hub saves: a stale version base keeps both or refuses; a stale rename or delete is refused", async () => {
  const f = fixture();
  try {
    const created = await f.ops.createNote(
      { path: "note", content: "one" },
      f.api(),
    );
    const stale = { kind: "version" as const, version: created.version! };
    Deno.writeTextFileSync(`${f.vault}/note.md`, "outside");
    const copy = await f.ops.updateNote(
      "note",
      { newContent: "mine", base: stale },
      "none",
      f.api(),
    );
    assertEquals(copy.saveResult?.status, "conflict");
    assertEquals(copy.content, "mine");
    const refused = await f.ops.updateNote(
      "note",
      { newContent: "mine", base: stale, onStale: "refuse" },
      "none",
      f.api(),
    ).catch((e) => e);
    assertEquals([refused.status, refused.code], [409, "base_stale"]);
    const renamed = await f.ops.updateNote(
      "note",
      { newPath: "moved", base: stale },
      "none",
      f.api(),
    ).catch((e) => e);
    assertEquals(renamed.code, "base_stale");
    const removed = await f.ops.deleteNote(
      "note",
      f.api(),
      undefined,
      undefined,
      undefined,
      stale,
    ).catch((e) => e);
    assertEquals(removed.code, "base_stale");
    assertEquals(f.notes.get("note").content, "outside");
  } finally {
    f.close();
  }
});

Deno.test("hub saves: merge preserves current CRLF and final newline intent, identical edits are clean", () => {
  assertEquals(
    mergeText("a\nb\nc\n", "mine\nb\nc\n", "a\r\nb\r\ntheirs\r\n"),
    "mine\r\nb\r\ntheirs\r\n",
  );
  assertEquals(
    mergeText("a\nb\nc", "mine\nb\nc", "a\nb\ntheirs"),
    "mine\nb\ntheirs",
  );
  assertEquals(mergeText("base", "same", "same"), "same");
  assertEquals(mergeText("base", "mine", "theirs"), null);
});
