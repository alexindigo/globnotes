// SPDX-License-Identifier: LGPL-3.0-only

/** In-process server state for unit-level tests (no subprocess boot). */

import { GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { testEnvironment } from "./environment.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import type { PluginManager } from "../../server/plugins/manager.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState } from "../../server/state.ts";
import { done, pending, waitUntil } from "./wait.ts";

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
  const env = testEnvironment({
    GLOBNOTES_PATH: vault,
    GLOBNOTES_AUTH_TYPE: "none",
  });
  const config = new GlobalConfig(env);
  const notes = new FileSystemNotes(vault, {}, env);
  const indexer = new Fts5Indexer(vault, env);
  const files = new FileServing(vault);
  initState(config, null, notes, indexer, files, plugins);
  return { config, notes, indexer, files };
}

/** Poll until the indexer's background sync reports complete. */
export function awaitIndexReady(indexer: Fts5Indexer): Promise<void> {
  return waitUntil(() => {
    const s = indexer.indexStatus;
    return !s.syncing && !s.initial ? done() : pending({ ...s });
  }, { label: "index background sync complete", intervalMs: 50 });
}
