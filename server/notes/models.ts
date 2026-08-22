// SPDX-License-Identifier: LGPL-3.0-only

/** Note models (ported from server/notes/models.py). API-facing shapes
 * are camelCase; storage internals mirror the Python field names where
 * it keeps the port legible. */

export interface Note {
  title: string;
  content: string | null;
  lastModified: number;
  /** Python's Note model serializes this always (default []). */
  movedFiles: { oldPath: string; newPath: string }[];
}

export interface NoteCreate {
  title: string;
  content?: string | null;
}

export interface NoteUpdate {
  newTitle?: string | null;
  newContent?: string | null;
}

export interface SearchResult {
  title: string;
  lastModified: number;
  score?: number | null;
  titleHighlights?: string | null;
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
export class InvalidTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTitleError";
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
