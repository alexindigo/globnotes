// SPDX-License-Identifier: LGPL-3.0-only

/** One folder level of the vault with display titles: the shape the tree
 * API (GET /_/api/tree) and the MCP folder tool (server/mcp/) share. */

import { state } from "../state.ts";
import { pageWindow } from "./models.ts";

export interface FolderLevel {
  folders: { name: string; path: string }[];
  /** Notes carry `path` (identity) and `title` (display label). */
  notes: { path: string; title: string }[];
}

/** A window of one folder level: subfolders first, then notes. */
export interface FolderPage extends FolderLevel {
  /** Entries (subfolders and notes) in the whole level. */
  total: number;
  /** Subfolders and notes in the whole level. */
  folderCount: number;
  noteCount: number;
}

/** Throws the storage errors of FileSystemNotes.listLevel
 * (InvalidPathError, NoteNotFoundError). */
export function folderLevel(dirPath = ""): FolderLevel {
  const { folders, notes } = folderPage(dirPath);
  return { folders, notes };
}

/**
 * Entries `offset` to `offset + limit` of a folder level (subfolders, then
 * notes; no limit = to the end). The directory's names are read and sorted
 * whole (the file system has no other order); the index is asked for the
 * display titles of the page's notes only.
 */
export function folderPage(
  dirPath = "",
  offset = 0,
  limit?: number,
): FolderPage {
  const window = pageWindow(offset, limit);
  const level = state.notes.listLevel(dirPath);
  const start = window.offset;
  const end = window.limit === undefined ? Infinity : start + window.limit;
  const folderCount = level.folders.length;
  const folders = level.folders.slice(start, end);
  const notes = level.notes.slice(
    Math.max(0, start - folderCount),
    Math.max(0, end - folderCount),
  );
  const meta = state.indexer?.titlesFor(notes.map((t) => t + ".md")) ?? {};
  return {
    total: folderCount + level.notes.length,
    folderCount,
    noteCount: level.notes.length,
    folders,
    notes: notes.map((t) => ({
      path: t,
      title: meta[t + ".md"] ?? t.split("/").pop()!,
    })),
  };
}
