// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Timing budget: the index sync at startup (server/search/fts5.ts
 * startBackgroundSync) is linear in the vault size. Its prune/update phase
 * used to look up each indexed file's mtime by filename, a full scan of the
 * FTS5 table per file, and to test new files against an array of indexed
 * names, so a restart over 10,000 already-indexed notes blocked the server
 * for many seconds (the same lookup made every search take about 17 s on
 * v2, plans/mcp-v3 S1 row 5). At 3,000 notes of about 2 KB the quadratic
 * restart costs over a second; the linear one a few tens of milliseconds.
 * The first build also has to finish within the readiness bound, which it
 * only does with batched index writes (one disk sync per batch, not per
 * statement).
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { state } from "../../server/state.ts";
import { testEnvironment } from "../helpers/environment.ts";
import { awaitIndexReady, restoreState, setupState } from "../helpers/state.ts";

const NOTES = 3_000;
const BUDGET_MS = 250;

Deno.test("index sync: a restart over 3,000 indexed notes stays within its budget", async () => {
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
    assertEquals(indexer.search("marker42", "score", "desc", 5).length, 1);

    // A restart: a new indexer on the same index, nothing changed on disk.
    // With no new notes the sync runs to completion synchronously.
    const restarted = new Fts5Indexer(vault, testEnvironment({}));
    const started = performance.now();
    restarted.startBackgroundSync();
    const elapsed = performance.now() - started;
    assertEquals(restarted.indexStatus.syncing, false);
    assertEquals(restarted.search("*", "path", "asc").length, NOTES);
    assert(
      elapsed < BUDGET_MS,
      `restart sync over ${NOTES} notes took ${
        elapsed.toFixed(0)
      } ms (budget ${BUDGET_MS} ms)`,
    );
  } finally {
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
