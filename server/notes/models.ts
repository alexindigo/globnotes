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
