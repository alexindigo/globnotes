// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Timing budget: the index sync that runs before every search and tag
 * listing (server/search/fts5.ts syncIndex) is linear in the vault size.
 * It used to look up each file's indexed mtime by filename, a full scan of
 * the FTS5 table per file, so one search over 10,000 notes took about 17 s
 * and stalled the server (plans/mcp-v3 S1 row 5). At 3,000 notes of about
 * 2 KB that quadratic sync costs over a second; the linear one a few tens
 * of milliseconds.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { state } from "../../server/state.ts";
import { awaitIndexReady, restoreState, setupState } from "../helpers/state.ts";

const NOTES = 3_000;
const BUDGET_MS = 250;

Deno.test("search sync: a search over 3,000 notes stays within its budget", async () => {
  const previous = { ...state };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-sync-scale-" });
  try {
    const filler = Array.from({ length: 300 }, (_, i) => `w${i % 97}`).join(
      " ",
    );
    for (let i = 0; i < NOTES; i++) {
      const folder = path.join(vault, `F${i % 30}`);
      await Deno.mkdir(folder, { recursive: true });
      await Deno.writeTextFile(
        path.join(folder, `Note ${i}.md`),
        `# Note ${i}\n\nmarker${i} ${filler}\n`,
      );
    }
    const { indexer } = setupState(vault);
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const timings: number[] = [];
    for (const term of ["marker42", "*", "w5"]) {
      const started = performance.now();
      const results = indexer.search(term, "score", "desc", 20);
      timings.push(performance.now() - started);
      assert(results.length > 0, term);
    }
    const started = performance.now();
    assertEquals(indexer.getTags(), []);
    timings.push(performance.now() - started);
    const worst = Math.max(...timings);
    assert(
      worst < BUDGET_MS,
      `slowest search/tags call ${
        worst.toFixed(0)
      } ms (budget ${BUDGET_MS} ms): ${
        timings.map((t) => t.toFixed(0)).join(", ")
      }`,
    );
  } finally {
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
