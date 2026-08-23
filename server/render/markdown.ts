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
 * and the pipeline's transformed-descriptor fallback. When `lineNumbers`
 * is set, adds a Prism-style line-numbers gutter. */
export function fenceHtml(
  info: string,
  content: string,
  lineNumbers = false,
): string {
  const lang = info.trim().split(/\s+/)[0].toLowerCase();
  const grammar = Prism.languages[lang];
  // markdown-it preserves a trailing newline; drop it for line-numbers so
  // the gutter count matches visible lines (no trailing blank line).
  const codeContent = lineNumbers ? content.replace(/\n$/, "") : content;
  const code = grammar
    ? Prism.highlight(codeContent, grammar, lang)
    : escapeHtml(codeContent);
  const langCls = lang ? `language-${lang}` : "";
  const lineCount = codeContent.split("\n").length;
  if (lineNumbers && lineCount > 1) {
    const rows = Array.from({ length: lineCount }, () => "<span></span>").join(
      "",
    );
    const preCls = `line-numbers${langCls ? " " + langCls : ""}`;
    const codeCls = langCls || "";
    return `<pre class="${preCls}"><code class="${codeCls}">${code}` +
      `<span class="line-numbers-rows" aria-hidden="true">${rows}</span>` +
      `</code></pre>\n`;
  }
  const cls = langCls ? ` class="${langCls}"` : "";
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
  // Line-number gutter is applied by the pipeline's defaultLeafHtml (per
  // render); heading anchor ids come from the pipeline's container walk.
  md.renderer.rules.fence = (tokens, idx) =>
    fenceHtml(tokens[idx].info, tokens[idx].content);

  return md;
}
