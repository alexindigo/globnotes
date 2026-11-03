// SPDX-License-Identifier: LGPL-3.0-only

/**
 * One note's failure never aborts an index pass (server/search/fts5.ts).
 * The batched prune/update phase is one transaction; an unreadable changed
 * note used to throw inside it, rolling back the whole phase (deleted notes
 * stayed searchable), skipping the new-file phase and the sync-completed
 * event, and doing so again on every sync. Each note is now its own
 * savepoint: the failure is logged as an error, that note keeps its
 * previous entry, and the rest of the pass completes.
 */

import { assert, assertEquals } from "@std/assert";
import { logger } from "../server/logger.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
import type { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { state } from "../server/state.ts";
import { awaitIndexReady, restoreState, setupState } from "./helpers/state.ts";

Deno.test("index sync: an unreadable changed note doesn't abort the pass", async () => {
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
    await Deno.chmod(`${vault}/a.md`, 0o000);
    const unreadable = await Deno.readTextFile(`${vault}/a.md`)
      .then(() => false, () => true);
    assert(
      unreadable,
      "needs a test process that file modes apply to (not root)",
    );
    await Deno.remove(`${vault}/b.md`);
    await Deno.writeTextFile(`${vault}/d.md`, "# d\n\ndelta\n");

    // A restart: fresh server state on the same vault and index.
    const { indexer: restarted } = setupState(vault);
    const facts: OperationFact[] = [];
    state.lifecycle = {
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
    await Deno.chmod(`${vault}/a.md`, 0o644).catch(() => {});
    await Deno.remove(vault, { recursive: true });
  }
});
