// SPDX-License-Identifier: LGPL-3.0-only

/**
 * One note's failure never aborts an index pass (server/search/fts5.ts).
 * The batched startup prune/update phase is one transaction; an unreadable
 * changed note used to throw inside it, rolling back the whole phase
 * (deleted notes stayed searchable), skipping the new-file phase and the
 * sync-completed event, and doing so again on every sync. The sync before
 * each search had the same gap without a transaction: the search itself
 * failed. Each note is now its own savepoint: the failure is logged as an
 * error (once per note and failure), that note keeps its previous entry,
 * and the rest of the pass completes.
 *
 * The read failure is injected through the indexer's reader adapter, so it
 * doesn't depend on who runs the test (file modes don't bind root).
 */

import { assert, assertEquals } from "@std/assert";
import { logger } from "../server/logger.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
import type { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { fileAdapters, Fts5Indexer } from "../server/search/fts5.ts";
import { state } from "../server/state.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { awaitIndexReady, restoreState, setupState } from "./helpers/state.ts";

/** A reader that fails for one note while `failing()` is true, as an
 * unreadable file would. */
const failingFor = (name: string, failing = () => true) => ({
  readText(filepath: string): string {
    if (failing() && filepath.endsWith(`/${name}`)) {
      throw new Deno.errors.PermissionDenied(
        `Permission denied (injected): '${filepath}'`,
      );
    }
    return fileAdapters.readText(filepath);
  },
});

Deno.test("index sync: a changed note that can't be read doesn't abort the pass", async () => {
  const previous = { ...state };
  const original = { ...logger };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-pass-" });
  const errors: string[] = [];
  try {
    for (
      const [name, text] of [["a", "alpha"], ["b", "bravo"], ["c", "charlie"]]
    ) {
      await Deno.writeTextFile(`${vault}/${name}.md`, `# ${name}\n\n${text}\n`);
    }
    const { indexer } = setupState(vault);
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    assertEquals(indexer.search("bravo").map((r) => r.path), ["b"]);

    // While the server is down: a changed note that can't be read, a
    // deleted note and a new one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Deno.writeTextFile(`${vault}/a.md`, "# a\n\nalphanew\n");
    await Deno.remove(`${vault}/b.md`);
    await Deno.writeTextFile(`${vault}/d.md`, "# d\n\ndelta\n");

    // A restart: fresh server state on the same vault and index.
    setupState(vault);
    const restarted = new Fts5Indexer(
      vault,
      testEnvironment({}),
      failingFor("a.md"),
    );
    const facts: OperationFact[] = [];
    // On v2 every search first syncs the index and reports outside changes.
    state.lifecycle = {
      consumeManaged: () => false,
      observe: () => {},
      syncCompleted: (fact: OperationFact) => facts.push(fact),
    } as unknown as PluginLifecycle;
    Object.assign(logger, {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    });
    restarted.startBackgroundSync();
    await awaitIndexReady(restarted);

    assertEquals(restarted.search("bravo"), [], "the deleted note is pruned");
    assertEquals(restarted.search("delta").map((r) => r.path), ["d"]);
    assertEquals(restarted.search("charlie").map((r) => r.path), ["c"]);
    // The unreadable note keeps its previous entry and is retried next time.
    assertEquals(restarted.search("alpha").map((r) => r.path), ["a"]);
    assertEquals(restarted.search("alphanew"), []);
    assertEquals(errors.length, 1, errors.join("\n"));
    assert(errors[0].includes("'a.md'"), errors[0]);
    assertEquals(
      facts.map((f) => [f.action, f.initial, f.changedPaths]),
      [["sync", true, ["d"]]],
    );
  } finally {
    Object.assign(logger, original);
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("index sync: a changed note that can't be read doesn't break search", async () => {
  const previous = { ...state };
  const original = { ...logger };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-pass-search-" });
  const errors: string[] = [];
  try {
    for (
      const [name, text] of [["a", "alpha"], ["b", "bravo"], ["c", "charlie"]]
    ) {
      await Deno.writeTextFile(`${vault}/${name}.md`, `# ${name}\n\n${text}\n`);
    }
    setupState(vault);
    let failing = false;
    const indexer = new Fts5Indexer(
      vault,
      testEnvironment({}),
      failingFor("a.md", () => failing),
    );
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    const facts: OperationFact[] = [];
    state.lifecycle = {
      consumeManaged: () => false,
      observe: () => {},
      syncCompleted: (fact: OperationFact) => facts.push(fact),
    } as unknown as PluginLifecycle;
    Object.assign(logger, {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    });

    // Outside changes between two searches: a changed note that can't be
    // read, a deleted note and a new one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Deno.writeTextFile(`${vault}/a.md`, "# a\n\nalphanew\n");
    failing = true;
    await Deno.remove(`${vault}/b.md`);
    await Deno.writeTextFile(`${vault}/d.md`, "# d\n\ndelta\n");
    // The note list is cached for GLOBNOTES_SCAN_CACHE_TTL; a fresh notes
    // instance sees the new file now.
    setupState(vault);
    state.lifecycle = {
      consumeManaged: () => false,
      observe: () => {},
      syncCompleted: (fact: OperationFact) => facts.push(fact),
    } as unknown as PluginLifecycle;

    assertEquals(indexer.search("bravo"), [], "the deleted note is pruned");
    assertEquals(indexer.search("delta").map((r) => r.path), ["d"]);
    assertEquals(indexer.search("alpha").map((r) => r.path), ["a"]);
    assertEquals(indexer.search("charlie").map((r) => r.path), ["c"]);
    assertEquals(errors.length, 1, errors.join("\n"));
    assert(errors[0].includes("'a.md'"), errors[0]);
    assertEquals(
      facts.map((f) => [f.action, f.initial, [...f.changedPaths!].sort()]),
      [["sync", false, ["b", "d"]]],
    );
  } finally {
    Object.assign(logger, original);
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
