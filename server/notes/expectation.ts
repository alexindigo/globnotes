// SPDX-License-Identifier: LGPL-3.0-only

/**
 * A writer's stale-write guard: what it read of a note. NoteOperations
 * checks it inside the note lock, before any hook or effect, so no
 * globnotes write can land between the check and the write (every
 * globnotes writer takes that lock). The commit point then re-checks that
 * the content is still what was read. A mismatch writes nothing.
 */

import { contentVersion } from "../hub/merge.ts";
import type { Note } from "./models.ts";

export interface NoteExpectation {
  /** The note's lastModified as read, in whole milliseconds (what
   * `new Date(lastModified * 1000)` keeps). */
  lastModifiedMs?: number;
  /** The note's content hash as read (`contentVersion`, SHA-256 hex). */
  hash?: string;
}

/** The note as it is now, in the expectation's terms. */
export interface NoteState {
  lastModifiedMs: number;
  hash: string;
}

export function noteState(note: Note): NoteState {
  return {
    lastModifiedMs: new Date(note.lastModified * 1000).getTime(),
    hash: contentVersion(note.content ?? ""),
  };
}

/** The note changed since the writer read it; nothing was written. */
export class NoteChangedError extends Error {
  constructor(
    readonly path: string,
    readonly expected: NoteExpectation,
    readonly current: NoteState,
    /** The expectation fields that no longer match. */
    readonly mismatched: (keyof NoteExpectation)[],
  ) {
    super(`'${path}' changed since it was read`);
    this.name = "NoteChangedError";
  }
}

/** Throws NoteChangedError when `note` no longer matches `expected`. */
export function assertExpected(
  path: string,
  note: Note,
  expected: NoteExpectation | undefined,
): void {
  if (
    expected === undefined ||
    (expected.lastModifiedMs === undefined && expected.hash === undefined)
  ) return;
  const current = noteState(note);
  const mismatched: (keyof NoteExpectation)[] = [];
  if (
    expected.lastModifiedMs !== undefined &&
    expected.lastModifiedMs !== current.lastModifiedMs
  ) mismatched.push("lastModifiedMs");
  if (
    expected.hash !== undefined &&
    expected.hash.toLowerCase() !== current.hash
  ) mismatched.push("hash");
  if (mismatched.length > 0) {
    throw new NoteChangedError(path, expected, current, mismatched);
  }
}
