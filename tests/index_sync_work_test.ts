import { testMetadata, testServices } from "./helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Startup inventories indexed mtimes once, reads/replaces only changed notes,
 * and batches initial writes. Measure that work, not shared-runner speed.
 * See server/search/fts5.ts #runBackgroundSync and docs/hub.md.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { state } from "../server/state.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { awaitIndexReady, restoreState, setupState } from "./helpers/state.ts";
import { indexWork } from "./helpers/index_work.ts";

const NOTES = 3_000;
const BATCH_SIZE = 200;

Deno.test("index sync: one inventory, batched writes, and only changed notes are read or replaced", async (t) => {
  const previous = { ...state };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-sync-scale-" });
  const work = indexWork();
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
    setupState(vault);
    const settings = {
      ...testServices(testEnvironment({})).index,
      batchSize: BATCH_SIZE,
      batchDelayMs: 0,
    };
    const open = () =>
      new Fts5Indexer(testMetadata(vault), settings, work.adapters);
    const sync = async (indexer: Fts5Indexer) => {
      work.reset(); // Exclude schema setup and checkpoint policy on open.
      indexer.startBackgroundSync();
      await awaitIndexReady(indexer);
      const inventory = work.statements.filter((s) =>
        s.method !== "run" && /\bFROM notes_fts\b/i.test(s.sql)
      );
      assertEquals(
        inventory.length,
        1,
        "one bulk mtime query, not a lookup per note",
      );
      assertEquals(inventory[0].rows, NOTES);
    };
    const inserted = () =>
      work.statements
        .filter((s) =>
          s.method === "run" && /^INSERT INTO notes_fts /i.test(s.sql)
        )
        .reduce((sum, s) => sum + s.rows, 0);
    const indexer = open();
    work.reset();
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    assertEquals(work.reads.length, NOTES);
    assertEquals(new Set(work.reads).size, NOTES, "each new note is read once");
    assertEquals(inserted(), NOTES);
    assertEquals(work.outerTransactions, 1 + Math.ceil(NOTES / BATCH_SIZE));
    assertEquals(indexer.search("marker42", "score", "desc", 5).length, 1);

    const unchanged = async () => {
      const restarted = open();
      await sync(restarted);
      assertEquals(work.reads, [], "an unchanged restart must not parse notes");
      assertEquals(
        work.statements.filter((s) => s.method === "run"),
        [],
        "an unchanged restart must not write index rows",
      );
      assertEquals(restarted.search("*", "path", "asc").length, NOTES);
    };
    await t.step("unchanged restart", unchanged);
    await t.step("three modified notes", async () => {
      const changed = [0, 42, NOTES - 1].map((i) =>
        path.join(vault, `F${i % 30}`, `Note ${i}.md`)
      );
      for (const filename of changed) {
        const mtime = Deno.statSync(filename).mtime!;
        await Deno.writeTextFile(filename, "# Changed\n\nchangedmarker\n");
        // No sleep or filesystem timestamp-resolution dependency.
        Deno.utimeSync(filename, mtime, new Date(mtime.getTime() + 2000));
      }
      const restarted = open();
      await sync(restarted);
      assertEquals([...work.reads].sort(), [...changed].sort());
      assertEquals(inserted(), changed.length);
      assertEquals(restarted.search("changedmarker").length, changed.length);
      assertEquals(restarted.search("marker42"), []);
      assert(restarted.search("marker1").length === 1);
    });
    await t.step("unchanged restart after updates", unchanged);
  } finally {
    work.close();
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
