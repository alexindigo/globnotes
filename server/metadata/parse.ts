// SPDX-License-Identifier: LGPL-3.0-only
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type { RuleInline } from "markdown-it/lib/parser_inline.mjs";
import backticks from "markdown-it/lib/rules_inline/backticks.mjs";
import link from "markdown-it/lib/rules_inline/link.mjs";
import image from "markdown-it/lib/rules_inline/image.mjs";
import htmlInline from "markdown-it/lib/rules_inline/html_inline.mjs";
import {
  type FrontmatterEntry,
  parseFrontmatter,
} from "../../shared/frontmatter.ts";

export interface ParsedMetadata {
  properties: FrontmatterEntry[];
  headings: { level: number; text: string; line: number }[];
  links: { target: string; label: string; embed: boolean; line: number }[];
  tasks: { text: string; checked: boolean; line: number }[];
  fields: { key: string; value: string; line: number }[];
}

const md = new MarkdownIt({ html: true });
// Metadata keeps destinations, not renderer URL rewriting/resolution.
md.normalizeLink = (target) => target;
md.validateLink = () => true;
const lineOffsets = new WeakMap<StateInline, number[]>();
function sourceLine(state: StateInline, pos: number): number {
  let offsets = lineOffsets.get(state);
  if (!offsets) {
    offsets = [];
    for (let i = 0; i < state.src.length; i++) {
      if (state.src[i] === "\n") offsets.push(i);
    }
    lineOffsets.set(state, offsets);
  }
  let low = 0, high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < pos) low = mid + 1;
    else high = mid;
  }
  return low;
}
// Code/images normalize newlines and links omit destinations. Preserve coordinates
// at the existing tokenizer boundary, not by counting rendered text's newlines.
function located(rule: RuleInline, types: string[]): RuleInline {
  return (state, silent) => {
    const start = state.pos, index = state.tokens.length;
    const matched = rule(state, silent);
    if (matched && !silent) {
      for (const token of state.tokens.slice(index)) {
        if (types.includes(token.type)) {
          token.meta = {
            ...token.meta,
            sourceLine: sourceLine(
              state,
              token.type === "link_close" ? state.pos : start,
            ),
            endLine: sourceLine(state, state.pos),
            sourceStart: start,
            sourceEnd: state.pos,
          };
        }
      }
    }
    return matched;
  };
}
md.inline.ruler.at("backticks", located(backticks, ["code_inline"]));
md.inline.ruler.at("link", located(link, ["link_open", "link_close"]));
md.inline.ruler.at("image", located(image, ["image"]));
md.inline.ruler.at("html_inline", located(htmlInline, ["html_inline"]));
md.inline.ruler.before("link", "metadata_wiki", (state, silent) => {
  const match = state.src.slice(state.pos, state.posMax).match(
    /^(!?)\[\[([^\]\n]+)\]\]/,
  );
  if (!match) return false;
  if (!silent) {
    const [target, ...label] = match[2].split("|");
    const token = state.push("metadata_wiki", "", 0);
    token.content = label.length ? label.join("|") : target;
    token.meta = {
      target,
      embed: match[1] === "!",
      sourceLine: sourceLine(state, state.pos),
    };
  }
  state.pos += match[0].length;
  return true;
});

function text(tokens: Token[]): string {
  return tokens.map((t) =>
    t.type === "softbreak" || t.type === "hardbreak"
      ? " "
      : t.type === "image"
      ? t.content
      : t.nesting === 0 && t.type !== "html_inline"
      ? t.content
      : ""
  ).join("");
}

/** Pure token parsing: no renderer, plugins, filesystem or resolver. Lines are 1-based. */
export function parseMetadata(source: string): ParsedMetadata {
  const result: ParsedMetadata = {
    properties: [],
    headings: [],
    links: [],
    tasks: [],
    fields: [],
  };
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(
    "\n",
  );
  let first = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    // An unfinished frontmatter block has no Markdown body to invent facts from.
    if (end < 0) return result;
    result.properties = parseFrontmatter(lines.slice(1, end).join("\n"));
    first = end + 1;
  }
  const tokens = md.parse(lines.slice(first).join("\n"), {});
  const lists: boolean[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "list_item_open") lists.push(true);
    if (token.type === "list_item_close") lists.pop();
    if (token.type !== "inline") continue;
    const children = token.children ?? [];
    const start = first + (token.map?.[0] ?? 0) + 1;
    if (tokens[i - 1]?.type === "heading_open") {
      result.headings.push({
        level: Number(tokens[i - 1].tag.slice(1)),
        text: text(children),
        line: start,
      });
    }
    if (lists.at(-1)) {
      const task = children[0]?.type === "text"
        ? children[0].content.match(/^\[([ xX])\]\s+(.*)/)
        : null;
      if (task) {
        result.tasks.push({
          text: text(children).replace(/^\[([ xX])\]\s+/, ""),
          checked: task[1] !== " ",
          line: start,
        });
      }
      lists[lists.length - 1] = false;
    }
    let line = start;
    let htmlDepth = 0;
    let htmlStart = 0;
    const excluded: [number, number][] = [];
    for (let j = 0; j < children.length; j++) {
      const child = children[j];
      if (
        child.meta?.sourceLine !== undefined &&
        line !== start + child.meta.sourceLine
      ) {
        line = start + child.meta.sourceLine;
      }
      if (child.type === "softbreak" || child.type === "hardbreak") {
        line++;
        continue;
      }
      if (child.type === "html_inline") {
        if (!htmlDepth) htmlStart = child.meta.sourceStart;
        if (/^<\//.test(child.content)) htmlDepth = Math.max(0, htmlDepth - 1);
        else if (
          /^<[a-z]/i.test(child.content) && !/\/\s*>$/.test(child.content) &&
          !/^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i
            .test(child.content)
        ) htmlDepth++;
        if (!htmlDepth) excluded.push([htmlStart, child.meta.sourceEnd]);
        line += (child.content.match(/\n/g) ?? []).length;
        continue;
      }
      if (htmlDepth) continue;
      if (child.type === "code_inline" || child.type === "image") {
        excluded.push([child.meta.sourceStart, child.meta.sourceEnd]);
      }
      if (child.type === "metadata_wiki") {
        result.links.push({
          target: child.meta.target,
          embed: child.meta.embed,
          label: child.content,
          line,
        });
      } else if (child.type === "image") {
        result.links.push({
          target: child.attrGet("src") ?? "",
          label: child.content,
          embed: true,
          line,
        });
      } else if (child.type === "link_open") {
        const end = children.findIndex((t, index) =>
          index > j && t.type === "link_close"
        );
        result.links.push({
          target: child.attrGet("href") ?? "",
          label: text(children.slice(j + 1, end)),
          embed: false,
          line,
        });
      }
      if (child.type === "code_inline") {
        line = start + child.meta.endLine;
      }
      if (child.type === "image") line = start + child.meta.endLine;
    }
    if (htmlDepth) excluded.push([htmlStart, token.content.length]);
    // Values are source strings. Token ranges exclude code/HTML without flattening
    // Markdown values or changing the standard tokenizer's text/list behaviour.
    excluded.sort(([a], [b]) => a - b);
    let exclusion = 0;
    let offset = 0, fieldLine = start;
    for (const raw of token.content.split("\n")) {
      let run = "", runStart = 0, runEnd = 0;
      // Scan key runs and delimiters once; a long prose line without a field must
      // not repeatedly backtrack over every word while looking for a trailing ::.
      for (const part of raw.matchAll(/[\p{L}\p{M}\p{N}_ -]+|::/gu)) {
        if (part[0] !== "::") {
          run = part[0];
          runStart = part.index;
          runEnd = part.index + run.length;
          continue;
        }
        if (runEnd !== part.index) continue;
        const first = run.match(/(?:^|\s)([\p{L}\p{N}_])/u);
        if (!first) continue;
        const local = runStart + first.index! + first[0].length -
          first[1].length;
        if (local > 0 && !/\s/.test(raw[local - 1])) continue;
        const from = offset + local, end = offset + part.index + 2;
        while (exclusion < excluded.length && excluded[exclusion][1] <= from) {
          exclusion++;
        }
        if (
          exclusion < excluded.length && from < excluded[exclusion][1] &&
          end > excluded[exclusion][0]
        ) continue;
        result.fields.push({
          key: raw.slice(local, part.index).trim(),
          value: raw.slice(part.index + 2).trim(),
          line: fieldLine,
        });
      }
      offset += raw.length + 1;
      fieldLine++;
    }
  }
  return result;
}
