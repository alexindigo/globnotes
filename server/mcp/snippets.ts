// SPDX-License-Identifier: LGPL-3.0-only

/** Search highlights as plain text for agents: the index wraps matches in
 * HTML marks around unescaped note text (server/search/fts5.ts), so only
 * the marks are converted — everything else is the note's own text. */

import { MARK_CLOSE, MARK_OPEN } from "../search/fts5.ts";

export const MATCH_OPEN = "«";
export const MATCH_CLOSE = "»";

/** Replace each highlight mark pair with «»; text outside a mark (including
 * a literal "</b>" in a note) is kept, with whitespace runs (line breaks of
 * the note) collapsed so a snippet reads as one line. */
export function highlightsToText(highlights: string | null | undefined) {
  return marksToText(highlights ?? "").replace(/\s+/g, " ").trim();
}

function marksToText(highlights: string): string {
  if (!highlights) return "";
  let out = "";
  let rest = highlights;
  for (;;) {
    const open = rest.indexOf(MARK_OPEN);
    if (open < 0) return out + rest;
    const start = open + MARK_OPEN.length;
    const close = rest.indexOf(MARK_CLOSE, start);
    if (close < 0) return out + rest.slice(0, open) + rest.slice(start);
    out += rest.slice(0, open) + MATCH_OPEN + rest.slice(start, close) +
      MATCH_CLOSE;
    rest = rest.slice(close + MARK_CLOSE.length);
  }
}
