// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The vault as the MCP tools see it: the adapter between server/mcp/ and the
 * domain. Tools call these methods, never HTTP; `stateVault` binds the
 * running server's singletons (the default adapter), tests inject fakes.
 * Listings are paged by the storage and index layer (the contract the REST
 * API uses too), so a tool never loads a whole result list to show a page.
 * Every write goes through NoteOperations, the only application mutation
 * entry point, with the caller's API authority (origin "api" and the lease
 * captured from the HTTP request), so plugin guards, facts, locks and the
 * index apply exactly as for the REST API.
 */

import { type FolderPage, folderPage } from "../notes/folder_level.ts";
import type {
  Note,
  NoteCreate,
  NoteUpdate,
  SearchPage,
  SearchQuery,
  TagPage,
} from "../notes/models.ts";
import type { NoteExpectation } from "../notes/expectation.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { state } from "../state.ts";

export type SearchSort = "score" | "path" | "last_modified";

export interface McpVault {
  getNote(path: string): Note;
  /** Entries offset to offset + limit of one folder level. */
  listFolder(path: string, offset: number, limit: number): FolderPage;
  /** One page of a search and the number of all its results. */
  search(term: string, query: SearchQuery): SearchPage;
  /** One page of the sorted tag list and the number of all tags. */
  tags(offset: number, limit: number): TagPage;
  createNote(data: NoteCreate, lease: NoteMutationLease): Promise<Note>;
  /** `expect` is the stale-write guard, checked under the note lock. */
  updateNote(
    path: string,
    data: NoteUpdate,
    fileRefs: string,
    lease: NoteMutationLease,
    expect?: NoteExpectation,
  ): Promise<Note>;
  deleteNote(
    path: string,
    lease: NoteMutationLease,
    expect?: NoteExpectation,
  ): Promise<void>;
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
  listFolder: (path, offset, limit) => folderPage(path, offset, limit),
  search: (term, query) => {
    if (!state.indexer) throw new IndexUnavailableError();
    return state.indexer.searchPage(term, query);
  },
  tags: (offset, limit) =>
    state.indexer?.tagsPage(offset, limit) ?? { total: 0, tags: [] },
  createNote: (data, lease) =>
    operations().createNote(data, { origin: "api", lease }),
  updateNote: (path, data, fileRefs, lease, expect) =>
    operations().updateNote(
      path,
      data,
      fileRefs,
      { origin: "api", lease },
      undefined,
      undefined,
      expect,
    ),
  deleteNote: (path, lease, expect) =>
    operations().deleteNote(
      path,
      { origin: "api", lease },
      undefined,
      undefined,
      expect,
    ),
};
