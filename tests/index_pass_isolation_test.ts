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
import type { DatabaseSync } from "node:sqlite";
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

/** A database whose next commit of a per-note savepoint fails once after
 * `arm()`: the outermost savepoint of the sync before a search is
 * `index_write_0`, and its RELEASE is that note's commit. */
function failingCommit() {
  let armed = false;
  return {
    arm: () => armed = true,
    openDatabase(filepath: string): DatabaseSync {
      const db = fileAdapters.openDatabase(filepath);
      const exec = db.exec.bind(db);
      db.exec = (sql: string) => {
        if (armed && sql === "RELEASE index_write_0") {
          armed = false;
          throw new Error("disk I/O error (injected at commit)");
        }
        return exec(sql);
      };
      return db;
    },
  };
}

Deno.test("index sync: a note whose commit fails publishes nothing until it commits", async () => {
  const previous = { ...state };
  const original = { ...logger };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-pass-commit-" });
  const errors: string[] = [];
  try {
    await Deno.writeTextFile(`${vault}/a.md`, "# a\n\nalpha\n");
    setupState(vault);
    const commit = failingCommit();
    let attempts = 0;
    const indexer = new Fts5Indexer(vault, testEnvironment({}), {
      readText(filepath: string): string {
        // Reading the new note means its savepoint is open: fail its first
        // commit.
        if (filepath.endsWith("/m.md") && attempts++ === 0) commit.arm();
        return fileAdapters.readText(filepath);
      },
      openDatabase: commit.openDatabase,
    });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);

    await Deno.writeTextFile(`${vault}/m.md`, "# m\n\nmanagedneedle\n");
    await Deno.writeTextFile(`${vault}/x.md`, "# x\n\noutsideneedle\n");
    setupState(vault); // a fresh note list (it is cached); resets state

    // m.md is globnotes' own write: its managed signature must survive a
    // failed attempt, so the committed retry is not an outside create.
    const managed = new Set(["m.md"]);
    const consumed: string[] = [];
    const observed: string[] = [];
    const facts: OperationFact[] = [];
    state.lifecycle = {
      consumeManaged: (filename: string) => {
        consumed.push(filename);
        return managed.delete(filename);
      },
      observe: (fact: OperationFact) =>
        observed.push(`${fact.action}:${fact.path}`),
      syncCompleted: (fact: OperationFact) => facts.push(fact),
    } as unknown as PluginLifecycle;
    Object.assign(logger, {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    });

    // One sync (every search runs one first): m's commit fails, x commits.
    // titlesFor reads the index without syncing.
    indexer.syncIndex();
    assertEquals(indexer.titlesFor(["m.md", "x.md"]), { "x.md": "x" });
    assertEquals(errors.length, 1, errors.join("\n"));
    assert(errors[0].includes("'m.md'"), errors[0]);
    assertEquals(consumed, ["x.md"], "m's signature isn't touched");
    assertEquals(observed, ["create:x"]);
    assertEquals(facts.map((f) => f.changedPaths), [["x"]]);

    // The retry commits: m is indexed and stays globnotes' own write.
    assertEquals(indexer.search("managedneedle").map((r) => r.path), ["m"]);
    assertEquals(consumed, ["x.md", "m.md"]);
    assertEquals(observed, ["create:x"], "m isn't reported as external");
    assertEquals(facts.length, 1);
  } finally {
    Object.assign(logger, original);
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
