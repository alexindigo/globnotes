// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Paging inside storage (plans/mcp-interop §1 row 5): search, tag and folder
 * pages are cut by the index and storage layer, the contract REST and MCP
 * share. A page is the same window of one logical list at any offset (no
 * overlap, no gap, exact totals), and reading it materializes only that
 * window, however far into the list it starts.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { folderPage } from "../server/notes/folder_level.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import type { SearchQuery } from "../server/notes/models.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { awaitIndexReady, restoreState } from "./helpers/state.ts";

/** Rows each SQL statement returned to JavaScript, by statement text. */
type RowLog = Map<string, number>;

/** A database whose statements count the rows they hand to JavaScript. */
function countingDatabase(file: string, log: RowLog): DatabaseSync {
  const db = new DatabaseSync(file);
  const count = (sql: string, rows: number) =>
    log.set(sql, (log.get(sql) ?? 0) + rows);
  const statement = (sql: string, inner: StatementSync) =>
    new Proxy(inner, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "all") {
          return (...args: never[]) => {
            const rows = (value as (...a: never[]) => unknown[]).apply(
              target,
              args,
            );
            count(sql, rows.length);
            return rows;
          };
        }
        if (prop === "get") {
          return (...args: never[]) => {
            const row = (value as (...a: never[]) => unknown).apply(
              target,
              args,
            );
            count(sql, row === undefined ? 0 : 1);
            return row;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "prepare") {
        return (sql: string) => statement(sql, target.prepare(sql));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** An indexed vault in this process's state, with a row log. */
async function indexedVault(
  write: (vault: string) => Promise<void>,
): Promise<{ vault: string; indexer: Fts5Indexer; rows: RowLog }> {
  const vault = await Deno.makeTempDir({ prefix: "globnotes-paging-" });
  await write(vault);
  const env = testEnvironment({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_INDEX_BATCH_DELAY: "0",
    GLOBNOTES_INDEX_BATCH_SIZE: "2000",
  });
  const rows: RowLog = new Map();
  const indexer = new Fts5Indexer(path.join(vault, ".globnotes"), env, {
    openDatabase: (file) => countingDatabase(file, rows),
  });
  initState(
    new GlobalConfig(env),
    null,
    new FileSystemNotes(vault, {}, env),
    indexer,
    new FileServing(vault),
    null,
  );
  indexer.startBackgroundSync();
  await awaitIndexReady(indexer);
  return { vault, indexer, rows };
}

/** The sync before every search reads every indexed file's mtime; it is
 * not part of the page (plans/mcp-v3 S1 row 5 owns its cost). */
const SYNC_SQL = "SELECT filename, last_modified FROM notes_fts";

/** Rows the statements of one call returned, the sync excluded. */
function rowsOf(log: RowLog, run: () => void): number {
  log.clear();
  run();
  let total = 0;
  for (const [sql, rows] of log) if (sql !== SYNC_SQL) total += rows;
  return total;
}

async function writeNote(vault: string, name: string, content: string) {
  const file = path.join(vault, `${name}.md`);
  await Deno.mkdir(path.dirname(file), { recursive: true });
  await Deno.writeTextFile(file, content);
}

Deno.test("search paging: pages are windows of one list, with exact totals", async (t) => {
  const previous = { ...state };
  const { vault, indexer } = await indexedVault(async (vault) => {
    for (let i = 0; i < 23; i++) {
      const where = ["Work", "Work/Deep", "Home", ""][i % 4];
      await writeNote(
        vault,
        path.join(where, `Note ${String(i).padStart(2, "0")}`),
        `# Note ${i}\n\nshared ${i % 3 === 0 ? "garden garden" : "garden"} #t${
          i % 5
        }\n`,
      );
    }
    // Same-named note and folder: the folder's own note is in its scope.
    await writeNote(vault, "Work", "# Work\n\nshared garden\n");
    // An alias hit whose note doesn't match the words of the query.
    await writeNote(
      vault,
      "Home/Elsewhere",
      "---\naliases: [shared garden]\n---\n# Elsewhere\n\nnothing\n",
    );
  });
  try {
    const queries: [string, SearchQuery][] = [];
    for (const term of ["*", "garden", "shared garden", "#t2"]) {
      for (const sort of ["score", "path", "last_modified"] as const) {
        for (const order of ["asc", "desc"] as const) {
          queries.push([term, { sort, order }]);
        }
      }
      queries.push([term, { folder: "Work" }]);
      queries.push([term, { folder: "Work", nested: false }]);
      queries.push([term, { nested: false, sort: "path" }]);
    }
    for (const [term, query] of queries) {
      await t.step(`${term} ${JSON.stringify(query)}`, () => {
        const all = indexer.search(
          term,
          query.sort,
          query.order,
          undefined,
          query.nested,
          query.folder,
        ).map((r) => r.path);
        assertEquals(indexer.searchPage(term, query).total, all.length);
        for (const size of [1, 4, 7]) {
          const paged: string[] = [];
          for (let offset = 0; offset <= all.length + size; offset += size) {
            const page = indexer.searchPage(term, {
              ...query,
              offset,
              limit: size,
            });
            assertEquals(page.total, all.length);
            assert(page.results.length <= size);
            paged.push(...page.results.map((r) => r.path));
          }
          assertEquals(paged, all, `page size ${size}`);
        }
      });
    }
    await t.step("the alias hit follows the matches, on any page", () => {
      // The alias note is outside the folder, so it is not a match there;
      // the alias hit is merged unscoped.
      const work = { folder: "Work" };
      const all = indexer.search(
        "shared garden",
        "score",
        "desc",
        undefined,
        true,
        "Work",
      ).map((r) => r.path);
      assertEquals(all.at(-1), "Home/Elsewhere");
      assertEquals(all.filter((p) => p === "Home/Elsewhere").length, 1);
      for (const limit of [1, 5]) {
        const last = indexer.searchPage("shared garden", {
          ...work,
          offset: all.length - 1,
          limit,
        });
        assertEquals(last.total, all.length);
        assertEquals(last.results.map((r) => r.path), ["Home/Elsewhere"]);
        assertEquals(last.results[0].score, null);
      }
      assertEquals(
        indexer.searchPage("shared garden", {
          ...work,
          offset: all.length,
          limit: 5,
        }).results,
        [],
      );
    });
    await t.step("scopes: same-named note, direct children only", () => {
      const scoped = indexer.search(
        "*",
        "path",
        "asc",
        undefined,
        false,
        "Work",
      )
        .map((r) => r.path);
      assert(scoped.includes("Work"));
      assert(scoped.every((p) => p === "Work" || /^Work\/[^/]+$/.test(p)));
      assert(!scoped.some((p) => p.startsWith("Work/Deep/")));
      const root = indexer.search("*", "path", "asc", undefined, false)
        .map((r) => r.path);
      assert(root.length > 0 && root.every((p) => !p.includes("/")));
    });
    await t.step("tags: windows of the sorted list", () => {
      const all = indexer.getTags();
      assertEquals(all, ["t0", "t1", "t2", "t3", "t4"]);
      assertEquals(indexer.tagsPage(1, 2), { total: 5, tags: ["t1", "t2"] });
      assertEquals(indexer.tagsPage(4, 10), { total: 5, tags: ["t4"] });
      assertEquals(indexer.tagsPage(9, 10), { total: 5, tags: [] });
    });
  } finally {
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});

const SCALE = 10_000;

Deno.test("search paging: a deep page over 10,000 notes reads only its window", async (t) => {
  const previous = { ...state };
  const { vault, indexer, rows } = await indexedVault(async (vault) => {
    const flat = path.join(vault, "Flat");
    await Deno.mkdir(flat, { recursive: true });
    for (let i = 0; i < SCALE; i++) {
      const n = String(i).padStart(5, "0");
      await Deno.writeTextFile(
        path.join(flat, `Note ${n}.md`),
        `# Note ${n}\n\nmarker word${i % 50} #tag${n}\n`,
      );
    }
  });
  try {
    const LIMIT = 20;
    for (
      const [term, query] of [
        ["*", { sort: "path" }],
        ["*", { sort: "score" }],
        ["marker", { sort: "score" }],
        ["marker", { sort: "last_modified", order: "asc" }],
        ["marker", { folder: "Flat", nested: false }],
      ] as [string, SearchQuery][]
    ) {
      await t.step(`${term} ${JSON.stringify(query)}`, () => {
        const read = (offset: number) =>
          rowsOf(rows, () => {
            const page = indexer.searchPage(term, {
              ...query,
              offset,
              limit: LIMIT,
            });
            assertEquals(page.total, SCALE);
            assertEquals(page.results.length, LIMIT);
          });
        const first = read(0);
        const deep = read(SCALE - LIMIT);
        // The page rows, their snippets and one count: never the list.
        assert(first <= 2 * LIMIT + 2, `first page read ${first} rows`);
        assertEquals(deep, first, "a deep page reads what the first does");
      });
    }
    await t.step("tags", () => {
      const first = rowsOf(rows, () => indexer.tagsPage(0, 500));
      const deep = rowsOf(rows, () => {
        assertEquals(indexer.tagsPage(SCALE - 500, 500).tags.length, 500);
      });
      assert(first <= 501, `first tag page read ${first} rows`);
      assertEquals(deep, first);
    });
    await t.step("folder: titles for the page's notes only", () => {
      const first = rowsOf(rows, () => folderPage("Flat", 0, 100));
      const deep = rowsOf(rows, () => {
        const page = folderPage("Flat", SCALE - 100, 100);
        assertEquals(page.total, SCALE);
        assertEquals(page.notes.length, 100);
        assertEquals(
          page.notes[0].title,
          `Note ${String(SCALE - 100).padStart(5, "0")}`,
        );
      });
      assertEquals(first, 100);
      assertEquals(deep, first);
    });
  } finally {
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
