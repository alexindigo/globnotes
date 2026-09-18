// SPDX-License-Identifier: LGPL-3.0-only

/** In-process server state for unit-level tests (no subprocess boot). */

import { GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import type { PluginManager } from "../../server/plugins/manager.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState } from "../../server/state.ts";

export interface UnitState {
  config: GlobalConfig;
  notes: FileSystemNotes;
  indexer: Fts5Indexer;
  files: FileServing;
}

export function setupState(
  vault: string,
  plugins: PluginManager | null = null,
): UnitState {
  Deno.env.set("GLOBNOTES_PATH", vault);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  const config = new GlobalConfig();
  const notes = new FileSystemNotes(vault);
  const indexer = new Fts5Indexer(vault);
  notes.setIndexer(indexer);
  indexer.bindNotes(notes);
  const files = new FileServing(vault);
  initState(config, null, notes, indexer, files, plugins);
  indexer.bindPlugins(plugins);
  return { config, notes, indexer, files };
}

/** Poll until the indexer's background sync reports complete. */
export async function awaitIndexReady(
  indexer: Fts5Indexer,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = indexer.indexStatus;
    if (!s.syncing && !s.initial) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("index sync did not complete in time");
}
