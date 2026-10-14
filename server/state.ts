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
import type { NoteOperations } from "./notes/operations.ts";
import type { PluginActions } from "./plugins/actions.ts";
import type { PluginDataStore } from "./plugins/data.ts";
import type { PluginEndpoints } from "./plugins/endpoints.ts";
import type { PluginLifecycle } from "./plugins/lifecycle.ts";
import type { PluginManager } from "./plugins/manager.ts";
import type { PluginNetworkRequests } from "./plugins/network_requests.ts";

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
  noteMetaFor(
    paths: string[],
  ): Record<string, { title: string; aliases: string[] }>;
  /** Resolve a front-matter alias to a note path, or null. */
  resolveAlias(
    target: string,
    eligible?: (path: string) => boolean,
  ): string | null;
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
  /** Access-policy epochs + commit gate + managed-write signatures. */
  lifecycle: PluginLifecycle | null;
  /** Async guarded mutation facade; null only in storage-level unit tests. */
  operations: NoteOperations | null;
  /** Deferred plugin action queue with correlated receipts. */
  actions: PluginActions | null;
  /** Host-committed plugin settings/data persistence (HTTP control API). */
  pluginData: PluginDataStore | null;
  /** Sandbox endpoint router (compiled from worker-reported descriptors). */
  pluginEndpoints: PluginEndpoints | null;
  /** Host-owned server permission requests and operator approvals. */
  pluginNetwork: PluginNetworkRequests | null;
}

// Assigned by initState() before the server starts listening; endpoints only
// run after that, so the assertion is safe.
export const state: ServerState = {
  lifecycle: null,
  operations: null,
  actions: null,
  pluginData: null,
  pluginEndpoints: null,
  pluginNetwork: null,
} as ServerState;

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
  state.lifecycle = null;
  state.operations = null;
  state.actions = null;
  state.pluginData = null;
  state.pluginEndpoints = null;
  state.pluginNetwork = null;
}
