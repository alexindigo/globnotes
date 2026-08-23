// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Mutable server singletons, initialised once at boot in main.ts.
 * Mirrors the Python server's module-level globals (global_config,
 * auth_state, note_storage); the setup wizard mutates `auth` and the
 * config at runtime.
 */

import type { LocalAuth } from "./auth/local.ts";
import type { GlobalConfig } from "./config.ts";
import type { FileServing } from "./files/file_serving.ts";
import type { FileSystemNotes } from "./notes/file_system.ts";
import type { SearchResult } from "./notes/models.ts";
import type { PluginManager } from "./plugins/manager.ts";

/** Implemented by the FTS5 commit; unset until then (storage still works,
 * index hooks are simply skipped). */
export interface Indexer {
  reindexNote(title: string): void;
  deleteFromIndex(title: string): void;
  search(
    term: string,
    sort?: string,
    order?: string,
    limit?: number,
    nested?: boolean,
    folder?: string,
  ): SearchResult[];
  getTags(): string[];
  /** Display titles for a batch of filenames (title + ".md" keys). */
  displayTitlesFor(filenames: string[]): Record<string, string>;
  readonly indexStatus: {
    syncing: boolean;
    initial: boolean;
    done: number;
    total: number;
  };
  startBackgroundSync(): void;
}

export interface ServerState {
  config: GlobalConfig;
  /** null when auth is disabled (none/read-only) or setup is incomplete. */
  auth: LocalAuth | null;
  notes: FileSystemNotes;
  indexer: Indexer | null;
  files: FileServing;
  /** Plugin manager; null only in unit tests that never start one. */
  plugins: PluginManager | null;
}

// Assigned by initState() before the server starts listening; endpoints only
// run after that, so the assertion is safe.
export const state: ServerState = {} as ServerState;

export function initState(
  config: GlobalConfig,
  auth: LocalAuth | null,
  notes: FileSystemNotes,
  indexer: Indexer | null,
  files: FileServing,
  plugins: PluginManager | null = null,
): void {
  state.config = config;
  state.auth = auth;
  state.notes = notes;
  state.indexer = indexer;
  state.files = files;
  state.plugins = plugins;
}
