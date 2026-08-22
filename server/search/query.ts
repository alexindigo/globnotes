// SPDX-License-Identifier: LGPL-3.0-only

/**
 * FTS5 query translation, ported from the Whoosh MultifieldParser +
 * `_pre_process_search_term` behaviour.
 *
 * FTS5 MATCH syntax:
 *   *              →  null (match-all, no MATCH clause)
 *   #tag           →  {tags}: "tag"
 *   "phrase"       →  passed through as an FTS5 phrase
 *   bare terms     →  word fragments quoted + implicitly ANDed
 *                     (Whoosh tokenizes on non-word chars, so a term like
 *                     probe/link-target matches as "probe" "link" "target"
 *                     and FTS5 syntax chars never reach MATCH)
 *   term*          →  prefix query on the final fragment (Whoosh
 *                     PrefixPlugin parity)
 */

const TAGS_WITH_HASH_RE = /(?<=^|(?<=\s))#[a-zA-Z0-9_-]+(?=\s|$)/g;

/** Term sanitised to empty: nothing can match. */
export const NO_MATCH = "___globnotes_no_match___";

export function translateQuery(term: string): string | null {
  const trimmed = term.trim();
  if (trimmed === "*") return null;

  // Python's _fieldnames_for_term: a term containing a quote searches
  // title+content ONLY (tags column excluded).
  const excludeTags = trimmed.includes('"');
  const colFilter = excludeTags ? "{title content}: " : "";

  // Replace #tagname with the FTS5 column filter.
  const withTags = trimmed.replace(
    TAGS_WITH_HASH_RE,
    (tag) => `{tags}: "${tag.slice(1)}"`,
  );

  // Split on whitespace, keeping quoted phrases and {tags} filters whole.
  const tokens: string[] = [];
  let rest = withTags;
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (rest === "") break;
    const phrase = rest.match(/^"[^"]*"/);
    if (phrase) {
      tokens.push(phrase[0]);
      rest = rest.slice(phrase[0].length);
      continue;
    }
    const tagFilter = rest.match(/^\{tags\}:\s*"[^"]*"/);
    if (tagFilter) {
      tokens.push(tagFilter[0]);
      rest = rest.slice(tagFilter[0].length);
      continue;
    }
    const sp = rest.search(/\s/);
    if (sp === -1) {
      tokens.push(rest);
      rest = "";
    } else {
      tokens.push(rest.slice(0, sp));
      rest = rest.slice(sp);
    }
  }

  const out = tokens
    .map((t) => {
      if (t.startsWith('"')) {
        // Phrase tokens get the column filter when the term has quotes.
        return colFilter + t;
      }
      if (t.startsWith("{tags}:")) return t;
      // Explicit prefix query (Whoosh PrefixPlugin parity): foo*
      const prefix = t.endsWith("*");
      if (prefix) t = t.slice(0, -1);
      const words = t.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (words.length === 0) return "";
      return words
        .map((w, i) =>
          `${colFilter}"${w}"${prefix && i === words.length - 1 ? "*" : ""}`
        )
        .join(" ");
    })
    .filter(Boolean)
    .join(" ");

  return out === "" ? `"${NO_MATCH}"` : out;
}
