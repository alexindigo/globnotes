// SPDX-License-Identifier: LGPL-3.0-only

/** Note models (ported from server/notes/models.py). API-facing shapes
 * are camelCase; storage internals mirror the Python field names where
 * it keeps the port legible. */

export interface Note {
  path: string;
  content: string | null;
  lastModified: number;
  /** Display title: front-matter title → first H1 → basename. */
  title: string;
  /** Python's Note model serializes this always (default []). */
  movedFiles: { oldPath: string; newPath: string }[];
}

export interface NoteCreate {
  path: string;
  content?: string | null;
}

export interface NoteUpdate {
  newPath?: string | null;
  newContent?: string | null;
}

export interface SearchResult {
  path: string;
  /** Display title: front-matter title → first H1 → basename. */
  title: string;
  lastModified: number;
  score?: number | null;
  pathHighlights?: string | null;
  contentHighlights?: string | null;
  tagMatches?: string[] | null;
}

/** One page of a search, chosen by the index itself (REST and MCP share
 * this contract): the scope (folder, nested) and the window (offset, limit)
 * are applied in the query, so a page costs the same at any offset. */
export interface SearchQuery {
  sort?: "score" | "path" | "last_modified";
  order?: "asc" | "desc";
  /** With folder (or at the root): also search subfolders. Default true. */
  nested?: boolean;
  /** Only notes inside this folder (an existing folder: the read-path rule). */
  folder?: string;
  /** Results to skip. Default 0. */
  offset?: number;
  /** Maximum results; undefined or negative = no maximum. */
  limit?: number;
}

export interface SearchPage {
  /** Every result the query matches, not just this page's. */
  total: number;
  results: SearchResult[];
}

/** One page of the vault's tag list (sorted). */
export interface TagPage {
  /** Every distinct tag in the vault. */
  total: number;
  tags: string[];
}

/** A file reference found in a note (markdown link/image or HTML src). */
export interface FileRef {
  url: string;
  path: string;
  kind: "absolute" | "relative" | "same-folder";
}

/** Storage-layer errors, mapped to HTTP statuses by the endpoints.
 * Mirrors the Python builtins the routes catch (ValueError /
 * FileNotFoundError / FileExistsError). */
export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}
export class NoteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteNotFoundError";
  }
}
export class NoteExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteExistsError";
  }
}
