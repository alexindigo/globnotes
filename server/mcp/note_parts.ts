// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Character ranges of a note for globnotes_get_note's parts. A character
 * is a Unicode code point: a range never splits a surrogate pair, so every
 * part is well-formed text and the parts concatenate back to the note.
 * Walking the string keeps a part's cost independent of the note's size
 * beyond reaching its start (no array of the whole note).
 */

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** The UTF-16 index after `count` code points from `index`, clamped to
 * the end of `text`. */
function advance(text: string, index: number, count: number): number {
  let at = index;
  for (let n = 0; n < count && at < text.length; n++) {
    at += isHigh(text.charCodeAt(at)) && isLow(text.charCodeAt(at + 1)) ? 2 : 1;
  }
  return at;
}

/** Code points in `text`. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let at = 0; at < text.length; count++) at = advance(text, at, 1);
  return count;
}

/** Up to `count` code points of `text` starting at code point `start`
 * (Infinity = to the end). */
export function codePointSlice(
  text: string,
  start: number,
  count: number,
): string {
  const from = advance(text, 0, start);
  return text.slice(
    from,
    count === Infinity ? text.length : advance(text, from, count),
  );
}
