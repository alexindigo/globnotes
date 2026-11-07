// SPDX-License-Identifier: LGPL-3.0-only

// Exact legacy marker pairs are a text protocol, never arbitrary HTML.
export function highlightSegments(text = "", highlighted = false) {
  if (!highlighted) return [{ text, match: false }];
  const segments = [];
  const pattern = /<b class="match term0">([\s\S]*?)<\/b>/g;
  let start = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > start) segments.push({ text: text.slice(start, found.index), match: false });
    segments.push({ text: found[1], match: true });
    start = found.index + found[0].length;
  }
  if (start < text.length) segments.push({ text: text.slice(start), match: false });
  return segments;
}
