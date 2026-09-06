// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Core frontmatter node for the WYSIWYG (Milkdown) editor — the
 * file-format integrity half of the dual-mode plugin contract. This node
 * lives in core because file-format integrity cannot depend on a plugin
 * toggle: with every plugin disabled the editor still parses, displays
 * (framed read-only fallback), and re-serializes the frontmatter block
 * without corruption.
 *
 * The interactive Properties panel is the globnotes-properties plugin's
 * client half; its $view on this node overrides the fallback view below.
 */

import { $nodeSchema, $remark, $view } from "@milkdown/utils";

/** Extract a position-0 `---` fenced YAML block from markdown source.
 * Returns { yaml, end } (raw YAML text; end offset of the closing fence)
 * or null when the document does not start with a frontmatter block. */
export function extractFrontmatter(src) {
  if (typeof src !== "string") return null;
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  return { yaml: m[1], end: m[0].length };
}

/** Position-0 remark slice: lift the `---` fenced block into a structured
 * `frontmatter` node before milkdown's mdast→ProseMirror walk sees the
 * mangled parse (thematic break / setext heading). Runs on the parsed
 * tree; the source string on `file` is the round-trip authority. */
export const frontmatterRemark = $remark(
  "frontmatterRemark",
  () => () => (tree, file) => {
    const fm = extractFrontmatter(
      typeof file?.value === "string" ? file.value : "",
    );
    if (!fm) return tree;
    const kids = [...(tree.children ?? [])];
    // Drop exactly the nodes the fence lines mangled into; anything the
    // remark parse produced beyond the block survives untouched.
    const rest = kids.filter(
      (n) => (n.position?.start?.offset ?? Infinity) >= fm.end,
    );
    if (rest.length === kids.length) return tree;
    // `frontmatter? block+` needs a block after the frontmatter; an
    // otherwise-empty document gets an invisible empty paragraph.
    if (rest.length === 0) {
      rest.push({ type: "paragraph", children: [] });
    }
    tree.children = [{ type: "frontmatter", value: fm.yaml }, ...rest];
    return tree;
  },
);

export const frontmatterSchema = $nodeSchema("frontmatter", () => ({
  group: "block",
  atom: true,
  code: true,
  defining: true,
  selectable: true,
  attrs: { value: { default: "" } },
  parseDOM: [
    {
      tag: "div[data-frontmatter-value]",
      getAttrs: (dom) => ({
        value: dom.getAttribute("data-frontmatter-value") ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-frontmatter-value": node.attrs.value,
      class: "frontmatter-fallback",
    },
  ],
  parseMarkdown: {
    match: ({ type }) => type === "frontmatter",
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value ?? "" });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "frontmatter",
    runner: (state, node) => {
      // Emit the raw block verbatim between the fences (mdast `html`
      // nodes pass through remark-stringify untouched).
      state.addNode("html", undefined, `---\n${node.attrs.value}\n---`);
    },
  },
}));

/** Doc content override — `frontmatter? block+`: at most one frontmatter
 * node, always at position 0. Upserts over commonmark's `block+`. */
export const frontmatterDocSchema = $nodeSchema("doc", () => ({
  content: "frontmatter? block+",
  parseMarkdown: {
    match: ({ type }) => type === "root",
    runner: (state, node, type) => {
      state.injectRoot(node, type);
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "doc",
    runner: (state, node) => {
      state.openNode("root");
      state.next(node.content);
    },
  },
}));

/** Framed read-only fallback view — what WYSIWYG shows when the
 * Properties plugin is disabled. A client module's $view on the same
 * node (registered later) replaces this one. */
export const frontmatterFallbackView = $view(
  frontmatterSchema.node,
  () => {
    return (node) => {
      const dom = document.createElement("div");
      dom.className = "frontmatter-fallback";
      dom.setAttribute("data-frontmatter-value", node.attrs.value);
      const pre = document.createElement("pre");
      pre.textContent = node.attrs.value;
      dom.appendChild(pre);
      return { dom, contentDOM: null };
    };
  },
);
