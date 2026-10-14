// SPDX-License-Identifier: LGPL-3.0-only

import { sanitizeBasename } from "@globnotes/names";

/**
 * Live title resolution for the open note — the client-side read of the
 * server's display-title rule (frontmatter `title:` → first H1 →
 * basename). The server stays authoritative on save; this is the
 * live-preview approximation for the tab and the new-note filename
 * follow.
 */

/** First `# ` heading in the buffer (a leading frontmatter block is
 * skipped). */
export function firstH1Of(source) {
  let text = source ?? "";
  if (/^---\r?\n/.test(text)) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) text = text.slice(end);
  }
  const m = /^#[ \t]+(.+?)\s*$/m.exec(text);
  return m ? m[1] : null;
}

/** Frontmatter `title:` when present (frontmatter opts out of H1 sync). */
export function frontmatterTitleOf(source) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source ?? "");
  if (!fm) return null;
  const m = /^[ \t]*title:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]);
  if (!m) return null;
  // Unquote quoted scalars, like the server's frontmatter subset.
  const raw = m[1];
  const quoted = /^(".*"|'.*')$/.exec(raw);
  return quoted ? raw.slice(1, -1) : raw;
}

/** The display title of a buffer: frontmatter title → first H1 → null. */
export function bufferTitleOf(source) {
  return frontmatterTitleOf(source) || firstH1Of(source);
}

/** The live display title, including the basename and empty-note fallbacks. */
export function displayTitle(buffer, basename) {
  return bufferTitleOf(buffer) || basename || "Untitled";
}

/** Filename candidate for an untouched new note; frontmatter opts out. */
export function followedBasename(buffer) {
  if (frontmatterTitleOf(buffer)) return null;
  const h1 = firstH1Of(buffer);
  return h1 ? sanitizeBasename(h1) : null;
}
