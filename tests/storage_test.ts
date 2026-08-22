// SPDX-License-Identifier: LGPL-3.0-only

/** Integration tests for notes storage endpoints — create / get / update
 * (rename + content) / delete / tree / note-index / rename-preview /
 * rewrite-refs. */

import { assert, assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

function api(
  server: { baseUrl: string },
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${server.baseUrl}${pathname}`, init);
}

Deno.test("storage: CRUD lifecycle", async (t) => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await t.step("create and get note", async () => {
      const created = await api(server, "/_/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hello World", content: "greetings" }),
      });
      assertEquals(created.status, 200);
      const note = await created.json();
      assertEquals(note.title, "Hello World");
      assertEquals(note.content, "greetings");
      assert(typeof note.lastModified === "number");

      const fetched = await api(server, "/_/api/notes/Hello%20World");
      assertEquals(fetched.status, 200);
      assertEquals((await fetched.json()).content, "greetings");
    });

    await t.step("create duplicate returns 409", async () => {
      const dup = await api(server, "/_/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hello World", content: "again" }),
      });
      assertEquals(dup.status, 409);
    });

    await t.step("get nonexistent returns 404", async () => {
      const res = await api(server, "/_/api/notes/no-such-note");
      assertEquals(res.status, 404);
    });

    await t.step("create with invalid title returns 422 (pydantic)", async () => {
      const bad = await api(server, "/_/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "", content: "" }),
      });
      // Python: pydantic NoteCreate validation fires before the route.
      assertEquals(bad.status, 422);
      const detail = (await bad.json()).detail;
      assertEquals(detail[0].type, "value_error");
      assertEquals(detail[0].loc, ["body", "title"]);
    });

    await t.step("update content", async () => {
      const upd = await api(server, "/_/api/notes/Hello%20World", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newContent: "updated text" }),
      });
      assertEquals(upd.status, 200);
      const fetched = await api(server, "/_/api/notes/Hello%20World");
      assertEquals((await fetched.json()).content, "updated text");
    });

    await t.step("rename note", async () => {
      await api(server, "/_/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "source",
          content: "[ref](Hello%20World)",
        }),
      });

      const rename = await api(
        server,
        "/_/api/notes/source?file_refs=none",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newTitle: "renamed" }),
        },
      );
      assertEquals(rename.status, 200);
      assertEquals((await rename.json()).title, "renamed");

      const old = await api(server, "/_/api/notes/source");
      assertEquals(old.status, 404);
      const fresh = await api(server, "/_/api/notes/renamed");
      assertEquals(fresh.status, 200);
    });

    await t.step("delete note", async () => {
      const del = await api(server, "/_/api/notes/Hello%20World", {
        method: "DELETE",
      });
      assertEquals(del.status, 200);
      const gone = await api(server, "/_/api/notes/Hello%20World");
      assertEquals(gone.status, 404);
    });
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("storage: note index and tree", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await api(server, "/_/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "alpha", content: "a" }),
    });
    await api(server, "/_/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "folder/beta", content: "b" }),
    });

    const titles = await api(server, "/_/api/note-index");
    const list = await titles.json();
    assert(list.includes("alpha"));
    assert(list.includes("folder/beta"));

    const tree = await api(server, "/_/api/tree?path=");
    const root = await tree.json();
    assertEquals(root.folders.length, 1);
    assertEquals(root.folders[0].name, "folder");
    assertEquals(root.notes.length, 1);
    assertEquals(root.notes[0], "alpha");

    const subtree = await api(server, "/_/api/tree?path=folder");
    const sub = await subtree.json();
    assertEquals(sub.notes[0], "folder/beta");
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("storage: rename preview", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await Deno.writeTextFile(`${server.vault}/pic.png`, "img");
    await Deno.writeTextFile(`${server.vault}/other.png`, "img");
    await api(server, "/_/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "src",
        content: "![](pic.png)\n[link](other.png)",
      }),
    });

    const preview = await api(
      server,
      "/_/api/rename-preview?title=src&new_title=dst",
    );
    assertEquals(preview.status, 200);
    const refs = await preview.json();
    assert(refs.length > 0, "should list refs from the note");
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});
