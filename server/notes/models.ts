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
  /** Maximum results; undefined = no maximum (pageWindow). */
  limit?: number;
}

export interface SearchPage {
  /** Every result the query matches, not just this page's. */
  total: number;
  results: SearchResult[];
}

/**
 * The one rule for a page window (search, tags, folder listings): `offset`
 * is a non-negative safe integer (default 0) and `limit` one too, or
 * undefined for no maximum. Every boundary validates its input to it (REST:
 * server/query_params.ts; MCP: the tools' Zod `.int().min(0)`, which also
 * means safe integers); storage enforces it with a RangeError, so no
 * fractional, negative or unsafe number ever reaches SQL.
 */
export function pageWindow(
  offset = 0,
  limit?: number,
): { offset: number; limit: number | undefined } {
  const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!valid(offset)) {
    throw new RangeError(`page offset must be a non-negative safe integer`);
  }
  if (limit !== undefined && !valid(limit)) {
    throw new RangeError(`page limit must be a non-negative safe integer`);
  }
  return { offset, limit };
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
