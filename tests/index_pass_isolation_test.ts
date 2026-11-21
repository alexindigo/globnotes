import { testMetadata, testServices } from "./helpers/environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only

/**
 * One note's failure never aborts an index pass (server/search/fts5.ts).
 * The batched prune/update phase is one transaction; an unreadable changed
 * note used to throw inside it, rolling back the whole phase (deleted notes
 * stayed searchable), skipping the new-file phase and the sync-completed
 * event, and doing so again on every sync. Each note is now its own
 * savepoint: the failure is logged as an error, that note keeps its
 * previous entry, and the rest of the pass completes.
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
import { bounded } from "./helpers/worker_liveness.ts";

/** A reader that fails for one note, as an unreadable file would. */
const failingFor = (name: string) => ({
  readText(filepath: string): string {
    if (filepath.endsWith(`/${name}`)) {
      throw new Deno.errors.PermissionDenied(
        `Permission denied (injected): '${filepath}'`,
      );
    }
    return fileAdapters.readText(filepath);
  },
});

Deno.test("index sync: initial progress counts committed notes separately from failures", async () => {
  const previous = { ...state };
  const original = { ...logger };
  const vault = await Deno.makeTempDir({ prefix: "globnotes-pass-progress-" });
  const errors: string[] = [], summaries: string[] = [];
  try {
    await Deno.writeTextFile(`${vault}/a.md`, "alpha");
    await Deno.writeTextFile(`${vault}/b.md`, "bravo");
    setupState(vault);
    const indexer = new Fts5Indexer(
      testMetadata(vault),
      testServices(testEnvironment({})).index,
      failingFor("a.md"),
    );
    Object.assign(logger, {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      info: (...args: unknown[]) => summaries.push(args.map(String).join(" ")),
    });
    indexer.startBackgroundSync();
    await awaitIndexReady(indexer);
    assertEquals<Record<string, unknown>>(indexer.indexStatus, {
      syncing: false,
      initial: false,
      done: 1,
      total: 2,
      failed: 1,
    });
    assertEquals(indexer.titlesFor(["a.md", "b.md"]), { "b.md": "b" });
    assertEquals(errors.length, 1);
    assert(errors[0].includes("a.md"));
    assert(
      summaries.some((s) => s.includes("1 indexed") && s.includes("1 failed")),
      summaries.join("\n"),
    );
  } finally {
    Object.assign(logger, original);
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
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

    // Force a distinct mtime without depending on filesystem clock resolution.
    const changedAt = new Date(
      Deno.statSync(`${vault}/a.md`).mtime!.getTime() + 1000,
    );
    await Deno.writeTextFile(`${vault}/a.md`, "# a\n\nalphanew\n");
    await Deno.utime(`${vault}/a.md`, changedAt, changedAt);
    await Deno.remove(`${vault}/b.md`);
    await Deno.writeTextFile(`${vault}/d.md`, "# d\n\ndelta\n");
    await Deno.writeTextFile(`${vault}/e.md`, "# e\n\necho\n");
    await Deno.writeTextFile(`${vault}/f.md`, "# f\n\nfoxtrot\n");

    // A restart: fresh server state on the same vault and index, with an
    // indexer whose reads of a.md fail.
    setupState(vault);
    // Put the failed addition before successful additions in the same batch.
    state.notes.listAllNoteFilenames =
      () => ["e.md", "d.md", "f.md", "a.md", "c.md"];
    const faults = new Set(["a.md", "e.md"]);
    const reads: [string, string][] = [];
    const restarted = new Fts5Indexer(
      testMetadata(vault),
      testServices(testEnvironment({})).index,
      {
        readText(filepath) {
          const name = filepath.slice(vault.length + 1);
          if (faults.has(name)) {
            reads.push([name, "failed"]);
            throw new Deno.errors.PermissionDenied(
              `injected read failure: ${name}`,
            );
          }
          const text = fileAdapters.readText(filepath);
          reads.push([name, "read"]);
          return text;
        },
      },
    );
    const facts: OperationFact[] = [];
    let completed = Promise.withResolvers<void>();
    state.lifecycle = {
      syncCompleted: (fact: OperationFact) => {
        facts.push(fact);
        completed.resolve();
      },
    } as unknown as PluginLifecycle;
    Object.assign(logger, {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    });
    restarted.startBackgroundSync();
    await bounded(
      completed.promise,
      "index pass completion after read failures",
    );

    assertEquals(reads, [["a.md", "failed"], ["e.md", "failed"], [
      "d.md",
      "read",
    ], ["f.md", "read"]]);
    assertEquals(restarted.indexStatus, {
      syncing: false,
      initial: false,
      done: 2,
      total: 3,
      failed: 1,
    });
    assertEquals(restarted.search("*").map((r) => r.path).sort(), [
      "a",
      "c",
      "d",
      "f",
    ]);
    assertEquals(restarted.search("bravo"), [], "the deleted note is pruned");
    assertEquals(restarted.search("delta").map((r) => r.path), ["d"]);
    assertEquals(restarted.search("charlie").map((r) => r.path), ["c"]);
    // The unreadable note keeps its previous entry and is retried next time.
    assertEquals(restarted.search("alpha").map((r) => r.path), ["a"]);
    assertEquals(restarted.search("alphanew"), []);
    assertEquals(restarted.search("echo"), []);
    assertEquals(errors, [
      "Index update of 'a.md' failed; the other notes continue: PermissionDenied: injected read failure: a.md",
      "Index add of 'e.md' failed; the other notes continue: PermissionDenied: injected read failure: e.md",
    ]);
    assertEquals(
      facts.map(({ operationId: _id, timestamp: _time, ...fact }) => fact),
      [{
        action: "sync",
        origin: "external",
        initial: true,
        changedPaths: ["d", "f"],
      }],
    );

    faults.clear();
    reads.length = 0;
    errors.length = 0;
    completed = Promise.withResolvers<void>();
    restarted.startBackgroundSync();
    await bounded(completed.promise, "index retry completion");
    assertEquals(reads, [["a.md", "read"], ["e.md", "read"]]);
    assertEquals(errors, []);
    assertEquals(restarted.indexStatus, {
      syncing: false,
      initial: false,
      done: 1,
      total: 1,
      failed: 0,
    });
    assertEquals(restarted.search("alpha"), []);
    assertEquals(restarted.search("alphanew").map((r) => r.path), ["a"]);
    assertEquals(restarted.search("echo").map((r) => r.path), ["e"]);
    assertEquals(restarted.search("*").map((r) => r.path).sort(), [
      "a",
      "c",
      "d",
      "e",
      "f",
    ]);
    assertEquals(
      facts.map(({ operationId: _id, timestamp: _time, ...fact }) => fact),
      [
        {
          action: "sync",
          origin: "external",
          initial: true,
          changedPaths: ["d", "f"],
        },
        {
          action: "sync",
          origin: "external",
          initial: true,
          changedPaths: ["e"],
        },
      ],
    );
  } finally {
    Object.assign(logger, original);
    restoreState(previous);
    await Deno.remove(vault, { recursive: true });
  }
});
