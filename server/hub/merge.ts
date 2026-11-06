// SPDX-License-Identifier: LGPL-3.0-only
import { diff3Merge, diffIndices } from "node-diff3";
import { createHash } from "node:crypto";

/** The version of a file: SHA-256 of its raw bytes (the hub's `files.hash`). */
export function versionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A note's version: the raw-byte hash storage read with it, else its text's. */
export function noteVersion(
  note: { version?: string; content?: string | null },
): string {
  return note.version ?? contentVersion(note.content ?? "");
}

/** The version of text as UTF-8 bytes (equal to `versionOf` of a valid file). */
export function contentVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Request-local logical-line merge; retain current endings, even in mixed
 * files. New lines use the first current ending. The trailing empty logical
 * line preserves the presence/absence of a final newline. Nothing is stored. */
export function mergeText(
  base: string,
  mine: string,
  theirs: string,
): string | null {
  // The generic diff API accepts tokens. Numeric interning also keeps arbitrary
  // note lines (e.g. '__proto__') out of the dependency's object-key dictionary.
  const tokens = new Map<string, number>(), text: string[] = [];
  const lines = (content: string) =>
    content.split(/\r\n|\n|\r/).map((line) => {
      let token = tokens.get(line);
      if (token === undefined) {
        token = text.length;
        tokens.set(line, token);
        text.push(line);
      }
      return token;
    });
  const current = lines(theirs), endings = theirs.match(/\r\n|\n|\r/g) ?? [];
  const ending = endings[0] ?? "\n";
  const blocks = diff3Merge(lines(mine), lines(base), current);
  if (blocks.some((block) => "conflict" in block)) return null;
  const merged = blocks.flatMap((block) => block.ok ?? []);
  const outputEndings: string[] = [];
  let oldIndex = 0, newIndex = 0;
  // Reconcile logical-line coordinates once, preserving each unchanged or
  // replaced line's own delimiter instead of normalizing the whole document.
  for (const change of diffIndices(current, merged)) {
    const [oldStart, oldLength] = change.buffer1;
    const [newStart, newLength] = change.buffer2;
    while (newIndex < newStart) {
      outputEndings[newIndex++] = endings[oldIndex++] ?? ending;
    }
    for (let i = 0; i < newLength; i++) {
      outputEndings[newStart + i] = i < oldLength
        ? endings[oldStart + i] ?? ending
        : ending;
    }
    oldIndex = oldStart + oldLength;
    newIndex = newStart + newLength;
  }
  while (newIndex < merged.length) {
    outputEndings[newIndex++] = endings[oldIndex++] ?? ending;
  }
  return merged.map((token, i) =>
    text[token] + (i < merged.length - 1 ? outputEndings[i] : "")
  ).join("");
}
