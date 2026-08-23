// SPDX-License-Identifier: LGPL-3.0-only

/** Integration tests for FTS5 search — boot server with auth disabled and
 * wait for the initial index sync to complete before searching. */

import { assert, assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";

/** Poll the index-status endpoint until the initial sync completes. */
async function awaitIndexReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/_/api/index-status`);
    const status = await res.json();
    if (!status.initial) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("index sync never completed");
}

function api(
  server: { baseUrl: string },
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${server.baseUrl}${pathname}`, init);
}

Deno.test("search: title and content matches", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "recipes", content: "soup and stew" }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "shopping", content: "pick up soup" }),
    });
    await awaitIndexReady(server.baseUrl);

    const res = await api(server, "/_/api/search?term=soup");
    assertEquals(res.status, 200);
    const hits = await res.json();
    assertEquals(hits.length, 2);
    const titles = hits.map((h: { title: string }) => h.title);
    assert(titles.includes("recipes"));
    assert(titles.includes("shopping"));

    // Score and highlights are populated for MATCH queries (Whoosh
    // markup: <b class="match term0">).
    const first = hits[0];
    assert(typeof first.score === "number");
    assert(typeof first.contentHighlights === "string");
    assert(first.contentHighlights.includes('<b class="match term0">soup</b>'));
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: * matches everything", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "alpha", content: "a" }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "beta", content: "b" }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "gamma", content: "g" }),
    });
    await awaitIndexReady(server.baseUrl);

    const res = await api(server, "/_/api/search?term=*");
    const hits = await res.json();
    assertEquals(hits.length, 3);
    // Every() parity: score 1.0, no highlights on a match-all query.
    for (const hit of hits) {
      assertEquals(hit.score, 1);
      assertEquals(hit.titleHighlights, null);
      assertEquals(hit.contentHighlights, null);
    }
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: tags", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "tagged note",
        content: "stuff #todo #work",
      }),
    });
    await awaitIndexReady(server.baseUrl);

    const tags = await (await api(server, "/_/api/tags")).json();
    assert(tags.includes("todo"));
    assert(tags.includes("work"));
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: nested=false and folder filter", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "root1", content: "a" }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "folder/root2", content: "b" }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "folder/sub/root3", content: "c" }),
    });
    await awaitIndexReady(server.baseUrl);

    // nested=false at root only includes top-level notes.
    const rootOnly = await api(server, "/_/api/search?term=*&nested=false");
    const rootOnlyHits = await rootOnly.json();
    assertEquals(
      rootOnlyHits.map((h: { title: string }) => h.title).sort(),
      ["root1"],
    );

    // folder filter limits to that subtree.
    const inFolder = await api(server, "/_/api/search?term=*&folder=folder");
    const inFolderHits = await inFolder.json();
    assert(
      inFolderHits.every((h: { title: string }) =>
        h.title === "folder" || h.title.startsWith("folder/")
      ),
    );
    assert(
      inFolderHits.map((h: { title: string }) => h.title).includes(
        "folder/root2",
      ),
    );
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: invalid folder path returns 400", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await awaitIndexReady(server.baseUrl);
    const res = await api(server, "/_/api/search?term=*&folder=_");
    assertEquals(res.status, 400);
    assertEquals(
      (await res.json()).detail,
      "The specified folder path is invalid.",
    );
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: explicit sort orders", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "banana", content: "c" }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "apple", content: "a" }),
    });
    await awaitIndexReady(server.baseUrl);

    const byTitle = await api(
      server,
      "/_/api/search?term=*&sort=title&order=asc",
    );
    const titleBody = await byTitle.json();
    const titles = titleBody.map((h: { title: string }) => h.title);
    assertEquals(titles, ["apple", "banana"]);
    // Field-sorted hits carry score null (Whoosh: hit.score is the field
    // value, not a float).
    assert(titleBody.every((h: { score: null }) => h.score === null));

    const byMod = await api(
      server,
      "/_/api/search?term=*&sort=lastModified&order=desc",
    );
    const byModBody = await byMod.json();
    assertEquals(byModBody.length, 2);
    const descending = byModBody.map((h: { lastModified: number }) =>
      h.lastModified
    );
    assert(descending[0] >= descending[1]);

    // Match-all + relevance sort: Whoosh Every() parity — score 1.0 on
    // every hit, natural insertion (docnum/rowid) order.
    const byScore = await api(server, "/_/api/search?term=*&sort=score");
    const scoreBody = await byScore.json();
    assertEquals(scoreBody.length, 2);
    assert(scoreBody.every((h: { score: number }) => h.score === 1));
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: terms with syntax chars (slashes, colons)", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "probe/link-target",
        content: "referenced",
      }),
    });
    await fetch(`${server.baseUrl}/_/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "probe/link-source",
        content: "see [[probe/link-target]]",
      }),
    });

    // Whoosh tokenises punctuation away; the FTS5 port must never pass
    // syntax chars to MATCH.
    const res = await fetch(
      `${server.baseUrl}/_/api/search?term=${
        encodeURIComponent("probe/link-target")
      }`,
    );
    const hits = await res.json();
    const titles = hits.map((h: { title: string }) => h.title);
    assert(titles.includes("probe/link-target"));
    assert(titles.includes("probe/link-source"));

    // No crash on pure punctuation.
    const punct = await fetch(
      `${server.baseUrl}/_/api/search?term=${encodeURIComponent(":://")}`,
    );
    assertEquals(punct.status, 200);
    assertEquals(await punct.json(), []);

    // Explicit prefix query.
    const prefix = await fetch(
      `${server.baseUrl}/_/api/search?term=${encodeURIComponent("probe/lin*")}`,
    );
    const prefixHits = await prefix.json();
    assert(prefixHits.length >= 2);
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});

Deno.test("search: odd-titled files are indexed (Python parity)", async () => {
  const server = await bootServer({ GLOBNOTES_AUTH_TYPE: "none" });
  try {
    // Real vaults contain titles the note API can't address; the index
    // must not die on them (Python's sync reads by filename).
    await Deno.writeTextFile(
      `${server.vault}/*TODO.md`,
      "wildcard title needle",
    );
    await Deno.writeTextFile(
      `${server.vault}/what now?.md`,
      "question title needle",
    );
    await api(server, "/_/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "normal", content: "ordinary" }),
    });
    await awaitIndexReady(server.baseUrl);

    const res = await api(server, "/_/api/search?term=needle");
    assertEquals(res.status, 200);
    const titles = (await res.json()).map((h: { title: string }) => h.title);
    assert(titles.includes("*TODO"));
    assert(titles.includes("what now?"));

    // Reads by filename are always allowed (Obsidian parity; the strict
    // validator only gates create).
    const ok = await api(server, "/_/api/notes/what%20now%3F");
    assertEquals(ok.status, 200);
    assertEquals((await ok.json()).content, "question title needle");

    // …but traversal still 400s.
    const bad = await api(server, "/_/api/notes/..%2F..%2Fetc%2Fpasswd");
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
  } finally {
    await server.close();
    await Deno.remove(server.vault, { recursive: true });
  }
});
