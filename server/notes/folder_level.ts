// SPDX-License-Identifier: LGPL-3.0-only

/** One folder level of the vault with display titles: the shape the tree
 * API (GET /_/api/tree) and the MCP folder tool (server/mcp/) share. */

import { state } from "../state.ts";

export interface FolderLevel {
  folders: { name: string; path: string }[];
  /** Notes carry `path` (identity) and `title` (display label). */
  notes: { path: string; title: string }[];
}

/** Throws the storage errors of FileSystemNotes.listLevel
 * (InvalidPathError, NoteNotFoundError). */
export function folderLevel(dirPath = ""): FolderLevel {
  const level = state.notes.listLevel(dirPath);
  const meta = state.indexer?.titlesFor(
    level.notes.map((t) => t + ".md"),
  ) ?? {};
  return {
    folders: level.folders,
    notes: level.notes.map((t) => ({
      path: t,
      title: meta[t + ".md"] ?? t.split("/").pop()!,
    })),
  };
}
