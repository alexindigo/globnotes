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
import { boundVault } from "./vault.ts";

/** Implemented by the FTS5 commit; unset until then (storage still works,
 * index hooks are simply skipped). */
export interface Indexer {
  reindexNote(path: string): void;
  deleteFromIndex(path: string): void;
  search(
    term: string,
    sort?: string,
    order?: string,
    limit?: number,
    nested?: boolean,
    folder?: string,
  ): SearchResult[];
  getTags(): string[];
  /** Display titles for a batch of paths (path + ".md" keys). */
  titlesFor(filenames: string[]): Record<string, string>;
  /** Display metadata (title + aliases) for a batch of bare note paths. */
  noteMetaFor(paths: string[]): Record<string, { title: string; aliases: string[] }>;
  /** Resolve a front-matter alias to a note path, or null. */
  resolveAlias(target: string): string | null;
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
let fallback: ServerState = {} as ServerState;

function source(): ServerState {
  const v = boundVault();
  return v ? v as unknown as ServerState : fallback;
}

export const state: ServerState = new Proxy({} as ServerState, {
  get(_t, prop) {
    return Reflect.get(source(), prop);
  },
  set(_t, prop, value) {
    return Reflect.set(source(), prop, value);
  },
});

export function initState(
  config: GlobalConfig,
  auth: LocalAuth | null,
  notes: FileSystemNotes,
  indexer: Indexer | null,
  files: FileServing,
  plugins: PluginManager | null = null,
): void {
  fallback = { config, auth, notes, indexer, files, plugins };
}
