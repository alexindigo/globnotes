import { testMetadata, testServices } from "./helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { publicScenario } from "./helpers/fixture_scenarios.ts";

/**
 * A search page far into 10,000 results materializes only its window
 * (plans/mcp-interop §1 row 5). The index used to fetch
 * offset + limit + 1 rows, with snippets, and drop all but the page: at
 * offset 9,900 that read the whole list. Now SQLite orders, windows and
 * scopes the list and only the page gets snippets.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "./helpers/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import type { SearchQuery } from "../server/notes/models.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { awaitIndexReady, restoreState } from "./helpers/state.ts";
import { indexWork } from "./helpers/index_work.ts";

const NOTES = 10_000;
const LIMIT = 20;
Deno.test("search paging: first and deep scoped pages materialize only their rows and snippets", async () => {
  const previous = { ...state };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-paging-scale-" });
  const work = indexWork();
  try {
    const fixture: { path: string; modified: number }[] = [];
    for (let i = 0; i < NOTES; i++) {
      const folder = path.join(vault, `F${i % 10}`);
      await Deno.mkdir(folder, { recursive: true });
      await Deno.writeTextFile(
        path.join(folder, `Note ${i}.md`),
        `# Note ${i}\n\nmarker word${i % 50} ${"filler ".repeat(40)}\n`,
      );
      const modified = 1_700_000_000 + i % 7;
      await Deno.utime(path.join(folder, `Note ${i}.md`), modified, modified);
      fixture.push({ path: `F${i % 10}/Note ${i}`, modified });
    }
    const env = testEnvironment({
      GLOBNOTES_GLOBNOTES_PATH: vault,
      fixtureScenario: publicScenario(),
      GLOBNOTES__INDEX_BATCHDELAY: "0",
      GLOBNOTES__INDEX_BATCHSIZE: "2000",
    });
    const indexer = new Fts5Indexer(
      testMetadata(path.join(vault, ".globnotes")),
      testServices(env).index,
      work.adapters,
    );
    const notes = new FileSystemNotes(vault, {}, testServices(env).notes);
    // All documents have equal token counts and marker frequency, hence tied
    // relevance. Fix inventory order so rowid ties follow fixture order.
    notes.listAllNoteFilenames = () => fixture.map((note) => `${note.path}.md`);
    initState(
      new GlobalConfig(env),
      null,
      notes,
      indexer,
      new FileServing(vault),
      null,
    );
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const read = (term: string, query: SearchQuery) => {
      work.reset();
      const page = indexer.searchPage(term, { ...query, limit: LIMIT });
      assertEquals(page.total, query.folder ? NOTES / 10 : NOTES);
      assertEquals(page.results.length, LIMIT);
      assertEquals(work.reads, [], "search must not rescan note content");
      const pageRows = work.statements.filter((s) =>
        /LEFT JOIN notes_meta/.test(s.sql)
      );
      const snippets = work.statements.filter((s) => /snippet\(/.test(s.sql));
      assertEquals(pageRows.length, 1);
      assertEquals(
        pageRows[0].rows,
        LIMIT,
        "SQL must window before materialization",
      );
      assertEquals(snippets.map((s) => s.rows), term === "*" ? [] : [LIMIT]);
      const rows = work.statements.reduce((sum, s) => sum + s.rows, 0);
      assert(rows <= 2 * LIMIT + 2, `page materialized ${rows} rows`);
      return { rows, paths: page.results.map((r) => r.path) };
    };
    const report: string[] = [];
    for (
      const [term, query] of [
        ["*", { sort: "path" }],
        ["marker", { sort: "score" }],
        ["marker", { sort: "last_modified" }],
        ["marker", { folder: "F3" }],
      ] as [string, SearchQuery][]
    ) {
      const first = read(term, { ...query, offset: 0 });
      const deepOffset = term === "marker" && query.folder
        ? NOTES / 10 - LIMIT
        : NOTES - LIMIT;
      const deep = read(term, { ...query, offset: deepOffset });
      const expected = fixture.filter((note) =>
        query.folder === undefined || note.path.startsWith(`${query.folder}/`)
      ).sort((a, b) => {
        if (query.sort === "path") {
          return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
        }
        if (query.sort === "last_modified") return b.modified - a.modified;
        return 0;
      }).map((note) => note.path);
      assertEquals(first.paths, expected.slice(0, LIMIT));
      assertEquals(deep.paths, expected.slice(deepOffset, deepOffset + LIMIT));
      assertEquals(
        deep.rows,
        first.rows,
        "offset must not grow materialized work",
      );
      report.push(
        `${term} ${JSON.stringify(query)}: first ${first.rows} rows, ` +
          `offset ${deepOffset} ${deep.rows} rows`,
      );
    }
    console.log(report.join("\n"));
  } finally {
    work.close();
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
