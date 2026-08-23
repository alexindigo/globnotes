// SPDX-License-Identifier: LGPL-3.0-only

/**
 * In-process storage + index tests — the Deno port of
 * tests/test_file_system_notes.py. The Python class-level matrix is
 * preserved one-for-one (search moves from notes.search to the split
 * Fts5Indexer; glob-counting cache tests become behaviour assertions).
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { NoteExistsError, NoteNotFoundError } from "../server/notes/models.ts";
import {
  awaitIndexReady,
  setupState,
  type UnitState,
} from "./helpers/state.ts";

async function withState(
  fn: (s: UnitState & { vault: string }) => void | Promise<void>,
): Promise<void> {
  const vault = await Deno.makeTempDir();
  try {
    const s = setupState(vault);
    await fn({ ...s, vault });
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
}

Deno.test("create: nested note with directories", () =>
  withState(({ notes, vault }) => {
    const note = notes.create({ title: "a/b/c", content: "hello" });
    assertEquals(note.title, "a/b/c");
    assertEquals(
      Deno.readTextFileSync(path.join(vault, "a", "b", "c.md")),
      "hello",
    );
  }));

Deno.test("create: duplicate raises", () =>
  withState(({ notes }) => {
    notes.create({ title: "a/b", content: "one" });
    let err: Error | null = null;
    try {
      notes.create({ title: "a/b", content: "two" });
    } catch (e) {
      err = e as Error;
    }
    assert(err instanceof NoteExistsError);
  }));

Deno.test("create: file blocking a path segment raises", () =>
  withState(({ notes, vault }) => {
    Deno.writeTextFileSync(path.join(vault, "blocker"), "plain file");
    let err: Error | null = null;
    try {
      notes.create({ title: "blocker/note", content: "x" });
    } catch (e) {
      err = e as Error;
    }
    assert(err instanceof NoteExistsError);
  }));

Deno.test("create: directory named like the note file raises", () =>
  withState(({ notes, vault }) => {
    Deno.mkdirSync(path.join(vault, "a.md"));
    let err: Error | null = null;
    try {
      notes.create({ title: "a", content: "x" });
    } catch (e) {
      err = e as Error;
    }
    assert(err instanceof NoteExistsError);
  }));

Deno.test("get: nested / missing / traversal", () =>
  withState(({ notes }) => {
    notes.create({ title: "dad/recipes/soup", content: "yum" });
    assertEquals(notes.get("dad/recipes/soup").content, "yum");

    let missing: Error | null = null;
    try {
      notes.get("no/such/note");
    } catch (e) {
      missing = e as Error;
    }
    assert(missing instanceof NoteNotFoundError);

    let traversal: Error | null = null;
    try {
      notes.get("../../etc/passwd");
    } catch (e) {
      traversal = e as Error;
    }
    assert(traversal !== null);
  }));

Deno.test("update: rename across directories", () =>
  withState(({ notes, vault }) => {
    notes.create({ title: "a/b", content: "content" });
    const note = notes.update("a/b", { newTitle: "x/y/z" });
    assertEquals(note.title, "x/y/z");
    assertEquals(
      Deno.readTextFileSync(path.join(vault, "x", "y", "z.md")),
      "content",
    );
  }));

Deno.test("update: rename prunes empty old parents", () =>
  withState(({ notes, vault }) => {
    notes.create({ title: "a/b/c", content: "x" });
    notes.update("a/b/c", { newTitle: "d" });
    let exists = true;
    try {
      Deno.statSync(path.join(vault, "a"));
    } catch {
      exists = false;
    }
    assert(!exists);
  }));

Deno.test("update: rename keeps non-empty old parents", () =>
  withState(({ notes, vault }) => {
    notes.create({ title: "a/b/c", content: "x" });
    notes.create({ title: "a/other", content: "y" });
    notes.update("a/b/c", { newTitle: "d" });
    assert(Deno.statSync(path.join(vault, "a")).isDirectory);
    let bExists = true;
    try {
      Deno.statSync(path.join(vault, "a", "b"));
    } catch {
      bExists = false;
    }
    assert(!bExists);
  }));

Deno.test("update: rename to existing raises", () =>
  withState(({ notes }) => {
    notes.create({ title: "a", content: "1" });
    notes.create({ title: "b/c", content: "2" });
    let err: Error | null = null;
    try {
      notes.update("a", { newTitle: "b/c" });
    } catch (e) {
      err = e as Error;
    }
    assert(err instanceof NoteExistsError);
  }));

Deno.test("update: content only", () =>
  withState(({ notes }) => {
    notes.create({ title: "a/b", content: "old" });
    const note = notes.update("a/b", { newContent: "new" });
    assertEquals(note.content, "new");
  }));

Deno.test("delete: prunes empty parents", () =>
  withState(({ notes, vault }) => {
    notes.create({ title: "x/y/z", content: "x" });
    notes.delete("x/y/z");
    let exists = true;
    try {
      Deno.statSync(path.join(vault, "x"));
    } catch {
      exists = false;
    }
    assert(!exists);
    assert(Deno.statSync(vault).isDirectory);
  }));

Deno.test("index: external nested files are indexed", () =>
  withState(async ({ indexer, vault }) => {
    Deno.mkdirSync(path.join(vault, "x", "y"), { recursive: true });
    Deno.writeTextFileSync(path.join(vault, "x", "y", "z.md"), "external");
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const titles = indexer.search("*").map((r) => r.title);
    assert(titles.includes("x/y/z"));
  }));

Deno.test("index: hidden dirs are not indexed", () =>
  withState(async ({ indexer, notes }) => {
    notes.create({ title: "real/note", content: "x" });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const titles = indexer.search("*").map((r) => r.title);
    assert(titles.every((t) => !t.startsWith(".")));
  }));

Deno.test("index: search matches path segment", () =>
  withState(async ({ indexer, notes }) => {
    notes.create({ title: "school/quicknote", content: "nothing special" });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const results = indexer.search("school");
    assert(results.some((r) => r.title === "school/quicknote"));
  }));

Deno.test("index: external delete is removed from the index", () =>
  withState(async ({ indexer, notes, vault }) => {
    notes.create({ title: "gone/soon", content: "x" });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    Deno.removeSync(path.join(vault, "gone", "soon.md"));
    const titles = indexer.search("*").map((r) => r.title);
    assert(!titles.includes("gone/soon"));
  }));

Deno.test("index: tags still work", () =>
  withState(async ({ indexer, notes }) => {
    notes.create({ title: "a/b", content: "has #taggy inside" });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    assert(indexer.getTags().includes("taggy"));
  }));

Deno.test("priority reindex: create searchable without any sync", () =>
  withState(({ indexer, notes }) => {
    // No startBackgroundSync — the create's priority reindex must land.
    notes.create({ title: "fresh/note", content: "needle" });
    const results = indexer.search("needle");
    assert(results.some((r) => r.title === "fresh/note"));
  }));

Deno.test("priority reindex: delete unsearchable without any sync", () =>
  withState(({ indexer, notes }) => {
    notes.create({ title: "gone/note", content: "needle" });
    notes.delete("gone/note");
    const results = indexer.search("needle");
    assert(!results.some((r) => r.title === "gone/note"));
  }));

Deno.test("priority reindex: rename removes old title from index", () =>
  withState(({ indexer, notes }) => {
    notes.create({ title: "old/name", content: "needle" });
    notes.update("old/name", { newTitle: "new/name" });
    const titles = indexer.search("needle").map((r) => r.title);
    assert(titles.includes("new/name"));
    assert(!titles.includes("old/name"));
  }));

Deno.test("background sync: completes and indexes external files", () =>
  withState(async ({ indexer, vault }) => {
    Deno.mkdirSync(path.join(vault, "ext"), { recursive: true });
    Deno.writeTextFileSync(path.join(vault, "ext", "note.md"), "needle");
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    assert(indexer.search("needle").some((r) => r.title === "ext/note"));
  }));

Deno.test("index status shape", () =>
  withState(({ indexer }) => {
    const s = indexer.indexStatus;
    assertEquals(Object.keys(s).sort(), [
      "done",
      "initial",
      "syncing",
      "total",
    ]);
  }));

Deno.test("scan cache: titles stay consistent, writes invalidate", () =>
  withState(({ notes }) => {
    const first = notes.getTitles();
    const second = notes.getTitles();
    assertEquals(first, second);
    notes.create({ title: "new/note", content: "x" });
    assert(notes.getTitles().includes("new/note"));
  }));

function withImageNote(
  fn: (s: UnitState & { vault: string }) => void | Promise<void>,
): Promise<void> {
  return withState(async (s) => {
    const oldDir = path.join(s.vault, "recipes");
    Deno.mkdirSync(oldDir, { recursive: true });
    Deno.writeTextFileSync(path.join(oldDir, "soup.png"), "image1");
    Deno.writeTextFileSync(path.join(oldDir, "shared.png"), "image2");
    s.notes.create({
      title: "recipes/soup",
      content:
        "look at the soup ![soup](soup.png) and also [shared](shared.png)",
    });
    await fn(s);
  });
}

Deno.test("rename strategy: move", () =>
  withImageNote(({ notes, vault }) => {
    const note = notes.update(
      "recipes/soup",
      { newTitle: "cooking/soup" },
      "move",
    );
    assert(note.movedFiles && note.movedFiles.length > 0);
    let oldExists = true;
    try {
      Deno.statSync(path.join(vault, "recipes", "soup.png"));
    } catch {
      oldExists = false;
    }
    assert(!oldExists);
    assert(Deno.statSync(path.join(vault, "cooking", "soup.png")).isFile);
    assert(note.content?.includes("soup.png"));
    assert(note.content?.includes("shared.png"));
  }));

Deno.test("rename strategy: relink", () =>
  withImageNote(({ notes, vault }) => {
    const note = notes.update(
      "recipes/soup",
      { newTitle: "cooking/soup" },
      "relink",
    );
    assert(Deno.statSync(path.join(vault, "recipes", "soup.png")).isFile);
    assert(note.content?.includes("../recipes/soup.png"));
    assert(note.content?.includes("../recipes/shared.png"));
  }));

Deno.test("rename strategy: none", () =>
  withImageNote(({ notes }) => {
    const note = notes.update(
      "recipes/soup",
      { newTitle: "cooking/soup" },
      "none",
    );
    assert(note.content?.includes("soup.png"));
    assert(note.content?.includes("shared.png"));
  }));

Deno.test("rename strategy: move preserves subdirectory structure", () =>
  withState(({ notes, vault }) => {
    Deno.mkdirSync(path.join(vault, "recipes", "assets"), { recursive: true });
    Deno.writeTextFileSync(
      path.join(vault, "recipes", "assets", "pic.png"),
      "image",
    );
    notes.create({
      title: "recipes/soup",
      content: "![pic](assets/pic.png)",
    });
    const note = notes.update(
      "recipes/soup",
      { newTitle: "cooking/soup" },
      "move",
    );
    assert(
      Deno.statSync(path.join(vault, "cooking", "assets", "pic.png")).isFile,
    );
    assert(note.content?.includes("assets/pic.png"));
  }));

Deno.test("rewrite_refs updates referencing notes", () =>
  withImageNote(async ({ notes }) => {
    notes.create({
      title: "other/page",
      content: "links to old ![soup](/recipes/soup.png)",
    });
    notes.update("recipes/soup", { newTitle: "cooking/soup" }, "move");
    await notes.rewriteRefs("recipes/soup.png", "cooking/soup.png");
    const other = notes.get("other/page");
    assert(!other.content?.includes("/recipes/soup.png"));
    assert(other.content?.includes("cooking/soup.png"));
  }));

Deno.test("rename is mechanism only: wikilinks untouched", () =>
  withState(({ notes }) => {
    notes.create({
      title: "probe/source",
      content: "see [[target/note]] and [[target/note|the alias]]",
    });
    notes.create({ title: "target/note", content: "# T" });
    notes.update("target/note", { newTitle: "target/renamed" });
    const source = notes.get("probe/source");
    assert(source.content?.includes("[[target/note]]"));
    assert(source.content?.includes("[[target/note|the alias]]"));
  }));

Deno.test("rename is mechanism only: markdown links untouched", () =>
  withState(({ notes }) => {
    notes.create({
      title: "probe/source",
      content: "see [the target](/target/note.md)",
    });
    notes.create({ title: "target/note", content: "# T" });
    notes.update("target/note", { newTitle: "target/renamed" });
    const source = notes.get("probe/source");
    assert(source.content?.includes("[the target](/target/note.md)"));
  }));

Deno.test("h1 sync: rename updates the first heading", () =>
  withState(({ notes }) => {
    notes.create({ title: "a/b", content: "# Old Heading\n\nbody" });
    const note = notes.update("a/b", { newTitle: "a/c" });
    assertEquals(note.content, "# c\n\nbody");
  }));

Deno.test("h1 sync: rename without an H1 leaves content alone", () =>
  withState(({ notes }) => {
    notes.create({ title: "a/b", content: "just body" });
    const note = notes.update("a/b", { newTitle: "a/c" });
    assertEquals(note.content, "just body");
  }));

Deno.test("h1 sync: front-matter title opts out", () =>
  withState(({ notes }) => {
    notes.create({
      title: "a/b",
      content: "---\ntitle: Fixed Title\n---\n# Old Heading\n",
    });
    const note = notes.update("a/b", { newTitle: "a/c" });
    assert(note.content?.includes("# Old Heading"));
  }));

Deno.test("h1 sync: editing the first H1 renames the basename", () =>
  withState(({ notes }) => {
    notes.create({ title: "folder/old-name", content: "# Old Name\n\nbody" });
    const note = notes.update("folder/old-name", {
      newContent: "# New Name\n\nbody",
    });
    assertEquals(note.title, "folder/New Name");
    let err: Error | null = null;
    try {
      notes.get("folder/old-name");
    } catch (e) {
      err = e as Error;
    }
    assert(err instanceof NoteNotFoundError);
  }));

Deno.test("h1 sync: H1 with invalid chars sanitizes the basename", () =>
  withState(({ notes }) => {
    notes.create({ title: "x", content: "# Old\n" });
    const note = notes.update("x", { newContent: "# what? is: *this*\n" });
    assertEquals(note.title, "what is this");
  }));

Deno.test("h1 sync: collision on rename raises", () =>
  withState(({ notes }) => {
    notes.create({ title: "taken", content: "# y\n" });
    notes.create({ title: "free", content: "# Taken\n" });
    let err: Error | null = null;
    try {
      notes.update("free", { newContent: "# taken\n" });
    } catch (e) {
      err = e as Error;
    }
    assert(err instanceof NoteExistsError);
  }));

Deno.test("h1 sync: no H1 change → no rename", () =>
  withState(({ notes }) => {
    notes.create({ title: "stay", content: "# Stay\nbody" });
    const note = notes.update("stay", { newContent: "# Stay\nmore body" });
    assertEquals(note.title, "stay");
  }));

Deno.test("h1 sync: front-matter title opts out of edit renames", () =>
  withState(({ notes }) => {
    notes.create({
      title: "fixed",
      content: "---\ntitle: My Title\n---\n# Old\n",
    });
    const note = notes.update("fixed", {
      newContent: "---\ntitle: My Title\n---\n# New\n",
    });
    assertEquals(note.title, "fixed");
  }));

Deno.test("aliases: resolveAlias + displayTitle prefers aliases[0]", () =>
  withState(async ({ notes, indexer }) => {
    notes.create({
      title: "deep/real-name",
      content: "---\naliases: [Real Name, RN]\n---\nbody",
    });
    notes.create({ title: "plain", content: "# Heading\n" });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    assertEquals(indexer.resolveAlias("Real Name"), "deep/real-name");
    assertEquals(indexer.resolveAlias("rn"), "deep/real-name");
    assertEquals(indexer.resolveAlias("nope"), null);
    assertEquals(notes.get("deep/real-name").displayTitle, "Real Name");
    assertEquals(notes.get("plain").displayTitle, "Heading");
  }));

Deno.test("aliases: exact-alias search includes the note", () =>
  withState(async ({ notes, indexer }) => {
    notes.create({
      title: "deep/real-name",
      content: "---\naliases:\n  - Totally Different\n---\nbody",
    });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const hits = indexer.search("Totally Different");
    assert(hits.some((h) => h.title === "deep/real-name"));
  }));
