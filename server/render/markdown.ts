// SPDX-License-Identifier: LGPL-3.0-only

/**
 * markdown-it instance + the default renderer rules that reproduce the
 * ToastUI viewer's output: heading id slugs, Prism-highlighted fences,
 * front-matter box, linkify, raw HTML passthrough.
 */

import MarkdownIt from "markdown-it";
import Prism from "prismjs";
// Loads every language grammar into the Prism singleton (mirrors the
// ToastUI code-syntax-highlight "-all" bundle the client used).
import loadLanguages from "prismjs/components/index.js";

loadLanguages();

/** Client's slugifyHeading (baseOptions.js) — heading anchor ids must
 * stay identical so existing in-document links keep working. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-\s]*/g, "")
    .trim()
    .replace(/\s/g, "-");
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Prism-highlighted (or escaped) fence HTML — shared by the fence rule
 * and the pipeline's transformed-descriptor fallback. */
export function fenceHtml(info: string, content: string): string {
  const lang = info.trim().split(/\s+/)[0].toLowerCase();
  const grammar = Prism.languages[lang];
  const code = grammar
    ? Prism.highlight(content, grammar, lang)
    : escapeHtml(content);
  const cls = lang ? ` class="language-${lang}"` : "";
  return `<pre><code${cls}>${code}</code></pre>\n`;
}

export function createMarkdown(): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
  });

  md.block.ruler.before(
    "hr",
    "front_matter",
    (state, startLine, endLine, silent) => {
      // Front matter only at the very start of the document.
      if (startLine !== 0) return false;
      const firstStart = state.bMarks[0] + state.tShift[0];
      if (state.src.slice(firstStart, state.eMarks[0]).trim() !== "---") {
        return false;
      }
      for (let line = 1; line < endLine; line++) {
        const s = state.bMarks[line] + state.tShift[line];
        if (state.src.slice(s, state.eMarks[line]).trim() !== "---") continue;
        if (silent) return true;
        const content = state.src.slice(
          state.eMarks[0] + 1,
          state.bMarks[line],
        );
        const token = state.push("front_matter", "", 0);
        token.content = content;
        token.markup = "---";
        state.line = line + 1;
        return true;
      }
      return false;
    },
  );
  md.renderer.rules.front_matter = (tokens, idx) =>
    `<div class="front-matter">${escapeHtml(tokens[idx].content)}</div>\n`;

  // Fences: Prism highlight when the language is known, escaped otherwise.
  // (Heading anchor ids are applied by the pipeline's container walk.)
  md.renderer.rules.fence = (tokens, idx) =>
    fenceHtml(tokens[idx].info, tokens[idx].content);

  return md;
}
