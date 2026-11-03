// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The vault as the MCP tools see it: the adapter between server/mcp/ and the
 * domain. Tools call these methods, never HTTP; `stateVault` binds the
 * running server's singletons (the default adapter), tests inject fakes.
 * Every write goes through NoteOperations, the only application mutation
 * entry point, with the caller's API authority (origin "api" and the lease
 * captured from the HTTP request), so plugin guards, facts, locks and the
 * index apply exactly as for the REST API.
 */

import { type FolderLevel, folderLevel } from "../notes/folder_level.ts";
import type {
  Note,
  NoteCreate,
  NoteUpdate,
  SearchResult,
} from "../notes/models.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { state } from "../state.ts";

export type SearchSort = "score" | "path" | "last_modified";

export interface McpVault {
  getNote(path: string): Note;
  listFolder(path: string): FolderLevel;
  search(
    term: string,
    sort: SearchSort,
    order: "asc" | "desc",
    limit: number,
    nested: boolean,
    folder: string | undefined,
  ): SearchResult[];
  tags(): string[];
  createNote(data: NoteCreate, lease: NoteMutationLease): Promise<Note>;
  updateNote(
    path: string,
    data: NoteUpdate,
    fileRefs: string,
    lease: NoteMutationLease,
  ): Promise<Note>;
  deleteNote(path: string, lease: NoteMutationLease): Promise<void>;
}

/** Raised when the search index is unavailable (never in a running server). */
export class IndexUnavailableError extends Error {
  constructor() {
    super("The search index is unavailable.");
    this.name = "IndexUnavailableError";
  }
}

function operations() {
  if (!state.operations) throw new Error("Note operations are unavailable.");
  return state.operations;
}

export const stateVault: McpVault = {
  getNote: (path) => state.notes.get(path),
  listFolder: (path) => folderLevel(path),
  search: (term, sort, order, limit, nested, folder) => {
    if (!state.indexer) throw new IndexUnavailableError();
    return state.indexer.search(term, sort, order, limit, nested, folder);
  },
  tags: () => state.indexer?.getTags() ?? [],
  createNote: (data, lease) =>
    operations().createNote(data, { origin: "api", lease }),
  updateNote: (path, data, fileRefs, lease) =>
    operations().updateNote(path, data, fileRefs, { origin: "api", lease }),
  deleteNote: (path, lease) =>
    operations().deleteNote(path, { origin: "api", lease }),
};
