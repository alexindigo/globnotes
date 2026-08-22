// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Mutable server singletons, initialised once at boot in main.ts.
 * Mirrors the Python server's module-level globals (global_config,
 * auth_state, note_storage); the setup wizard mutates `auth` and the
 * config at runtime.
 */

import type { LocalAuth } from "./auth/local.ts";
import type { GlobalConfig } from "./config.ts";
import type { FileSystemNotes } from "./notes/file_system.ts";

/** Implemented by the FTS5 commit; unset until then (storage still works,
 * index hooks are simply skipped). */
export interface Indexer {
  reindexNote(title: string): void;
  deleteFromIndex(title: string): void;
}

export interface ServerState {
  config: GlobalConfig;
  /** null when auth is disabled (none/read-only) or setup is incomplete. */
  auth: LocalAuth | null;
  notes: FileSystemNotes;
  indexer: Indexer | null;
}

// Assigned by initState() before the server starts listening; endpoints only
// run after that, so the assertion is safe.
export const state: ServerState = {} as ServerState;

export function initState(
  config: GlobalConfig,
  auth: LocalAuth | null,
  notes: FileSystemNotes,
): void {
  state.config = config;
  state.auth = auth;
  state.notes = notes;
  state.indexer = null; // wired in commit 5
}
