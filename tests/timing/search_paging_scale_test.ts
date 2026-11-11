import { testMetadata, testServices } from "../helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Timing budget: a search page far into 10,000 results costs about what the
 * first page does (plans/mcp-interop §1 row 5). The index used to fetch
 * offset + limit + 1 rows, with snippets, and drop all but the page: at
 * offset 9,900 that read the whole list (plans/mcp-v3 S1 row 5: 169 ms for
 * a deep page against 4 ms for the first). Now SQLite orders, windows and
 * scopes the list and only the page gets snippets.
 */

import { assert } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "../helpers/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import type { SearchQuery } from "../../server/notes/models.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState, state } from "../../server/state.ts";
import { testEnvironment } from "../helpers/environment.ts";
import { awaitIndexReady, restoreState } from "../helpers/state.ts";

const NOTES = 10_000;
const LIMIT = 20;
/** A deep page may cost twice the first plus this, no more. */
const SLACK_MS = 30;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

Deno.test("search paging: a page at offset 9,980 costs what the first does", async () => {
  const previous = { ...state };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-paging-scale-" });
  try {
    for (let i = 0; i < NOTES; i++) {
      const folder = path.join(vault, `F${i % 10}`);
      await Deno.mkdir(folder, { recursive: true });
      await Deno.writeTextFile(
        path.join(folder, `Note ${i}.md`),
        `# Note ${i}\n\nmarker word${i % 50} ${"filler ".repeat(40)}\n`,
      );
    }
    const env = testEnvironment({
      GLOBNOTES_GLOBNOTES_PATH: vault,
      fixtureAuth: { auth_type: "none" },
      GLOBNOTES__INDEX_BATCHDELAY: "0",
      GLOBNOTES__INDEX_BATCHSIZE: "2000",
    });
    const indexer = new Fts5Indexer(
      testMetadata(path.join(vault, ".globnotes")),
      testServices(env).index,
    );
    initState(
      new GlobalConfig(env),
      null,
      new FileSystemNotes(vault, {}, testServices(env).notes),
      indexer,
      new FileServing(vault),
      null,
    );
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const time = (term: string, query: SearchQuery) => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        indexer.searchPage(term, { ...query, limit: LIMIT });
        runs.push(performance.now() - started);
      }
      return median(runs);
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
      const first = time(term, { ...query, offset: 0 });
      const deepOffset = term === "marker" && query.folder
        ? NOTES / 10 - LIMIT
        : NOTES - LIMIT;
      const deep = time(term, { ...query, offset: deepOffset });
      report.push(
        `${term} ${JSON.stringify(query)}: first ${first.toFixed(1)} ms, ` +
          `offset ${deepOffset} ${deep.toFixed(1)} ms`,
      );
      assert(deep <= 2 * first + SLACK_MS, report.join("\n"));
    }
    console.log(report.join("\n"));
  } finally {
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
