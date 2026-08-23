// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Render pipeline — markdown-it token walk with plugin dispatch.
 *
 * Forward-only single pass per walk: each node is matched against the
 * ordered plugin list; first match fires. A plugin returns:
 *   null                 → abstain; matching continues downstream
 *   { parts: string[] }  → HTML fragments; node is consumed
 *   { node: Descriptor } → re-enter matching DOWNSTREAM only with the
 *                          new descriptor (normalizers feed renderers)
 * Unmatched nodes fall back to markdown-it's default rendering.
 *
 * Plugins run in sandboxed Workers (PluginHost); node descriptors cross
 * as structured clones. A broken plugin abstains, never kills a render.
 */

import type MarkdownIt from "markdown-it";
import type { PluginHost } from "../plugins/host.ts";
import { logger } from "../logger.ts";
import { state } from "../state.ts";
import {
  createMarkdown,
  escapeHtml,
  fenceHtml,
  slugifyHeading,
} from "./markdown.ts";
import { matches, type SelectorSpec } from "./selectors.ts";

type Token = ReturnType<MarkdownIt["parse"]>[number];

/** The structured-clone descriptor plugins receive. */
export interface RenderNode {
  type: string;
  tag: string;
  info: string;
  /** Raw source content (fence body, text content). */
  content: string;
  /** Plain text of the whole subtree (callout detection etc.). */
  text: string;
  /** Default-rendered children (containers, inline). */
  childrenHtml: string;
  attrs: [string, string][];
}

const md = createMarkdown();

interface LoadedPlugin {
  host: PluginHost;
  selectors: SelectorSpec[];
}

/** Fetch selectors once per render; plugins without selectors are inert.
 * Ids in `disabled` are skipped (per-request, from the client's
 * localStorage switches). */
async function loadPlugins(disabled?: Set<string>): Promise<LoadedPlugin[]> {
  const manager = state.plugins;
  if (!manager) return [];
  await manager.ensureStarted();
  const out: LoadedPlugin[] = [];
  for (const host of manager.hosts.values()) {
    if (disabled?.has(host.manifest.id)) continue;
    try {
      const specs = (await host.call("getSelectors", [])) as
        | SelectorSpec[]
        | null;
      if (Array.isArray(specs) && specs.length > 0) {
        out.push({ host, selectors: specs });
      }
    } catch (e) {
      logger.error(
        `plugin '${host.manifest.id}' getSelectors failed: ${e}; skipping`,
      );
    }
  }
  return out;
}

function plainText(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.type === "text" || t.type === "code_inline") out += t.content;
    if (t.children) out += plainText(t.children);
  }
  return out;
}

function attrsToHtml(attrs: [string, string][]): string {
  if (!attrs.length) return "";
  return attrs
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join("");
}

type Dispatch = { html: string | null; node: RenderNode };

/** Match a node against the ordered plugins. Returns the emitted HTML,
 * or null (all abstained) plus the possibly-transformed node. */
async function dispatch(
  node: RenderNode,
  plugins: LoadedPlugin[],
): Promise<Dispatch> {
  let current = node;
  for (const p of plugins) {
    if (!p.selectors.some((s) => matches(s, current))) continue;
    let res: unknown;
    try {
      res = await p.host.call("parseNode", [current]);
    } catch (e) {
      logger.error(`plugin '${p.host.manifest.id}' parseNode failed: ${e}`);
      continue;
    }
    if (res === null || res === undefined) continue;
    const r = res as {
      parts?: unknown;
      node?: Partial<RenderNode>;
    };
    if (Array.isArray(r.parts)) {
      return { html: r.parts.map(String).join(""), node: current };
    }
    if (r.node && typeof r.node === "object") {
      // Re-enter matching downstream only (loop continues at next plugin).
      current = {
        type: r.node.type ?? current.type,
        tag: r.node.tag ?? current.tag,
        info: r.node.info ?? current.info,
        content: r.node.content ?? current.content,
        text: r.node.text ?? current.text,
        childrenHtml: r.node.childrenHtml ?? current.childrenHtml,
        attrs: r.node.attrs ?? current.attrs,
      };
    }
  }
  return { html: null, node: current };
}

/** Default render of a single inline child (markdown-it default rules). */
function defaultInlineChild(child: Token): string {
  const rule = (md.renderer.rules as Record<string, unknown>)[child.type];
  if (typeof rule === "function") {
    return (rule as (...a: unknown[]) => string)(
      [child],
      0,
      md.options,
      {},
      md.renderer,
    );
  }
  return md.renderer.renderToken([child], 0, md.options);
}

async function renderInlineChild(
  child: Token,
  plugins: LoadedPlugin[],
): Promise<string> {
  const node: RenderNode = {
    type: child.type,
    tag: child.tag,
    info: child.info,
    content: child.content,
    text: child.content,
    childrenHtml: "",
    attrs: (child.attrs as [string, string][] | null) ?? [],
  };
  const { html, node: current } = await dispatch(node, plugins);
  if (html !== null) return html;
  if (current !== node) {
    // Transformed descriptor: re-render its content as inline markdown.
    return md.renderInline(current.content);
  }
  return defaultInlineChild(child);
}

async function renderInlineToken(
  t: Token,
  plugins: LoadedPlugin[],
): Promise<string> {
  const children = t.children ?? [];
  const node: RenderNode = {
    type: "inline",
    tag: t.tag,
    info: t.info,
    content: t.content,
    text: plainText(children),
    childrenHtml: "",
    attrs: [],
  };
  const { html, node: current } = await dispatch(node, plugins);
  if (html !== null) return html;
  if (current !== node) return md.renderInline(current.content);
  let out = "";
  for (const child of children) {
    out += await renderInlineChild(child, plugins);
  }
  return out;
}

/** Default render for a block leaf token (fence, hr, html_block, …).
 * Fences honour the per-render lineNumbers flag. */
function defaultLeafHtml(t: Token, lineNumbers = false): string {
  if (t.type === "fence") {
    return fenceHtml(t.info, t.content, lineNumbers);
  }
  const rule = (md.renderer.rules as Record<string, unknown>)[t.type];
  if (typeof rule === "function") {
    return (rule as (...a: unknown[]) => string)(
      [t],
      0,
      md.options,
      {},
      md.renderer,
    );
  }
  return md.renderer.renderToken([t], 0, md.options);
}

async function renderBlock(
  tokens: Token[],
  plugins: LoadedPlugin[],
  lineNumbers = false,
): Promise<string> {
  let html = "";
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.nesting === 1) {
      // Container: find the matching close and render children first
      // (bottom-up, so plugins see pre-rendered childrenHtml).
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length) {
        if (tokens[j].nesting === 1) depth++;
        else if (tokens[j].nesting === -1) {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      const inner = tokens.slice(i + 1, j);
      const childrenHtml = await renderBlock(inner, plugins, lineNumbers);
      const type = t.type.replace(/_open$/, "");
      const node: RenderNode = {
        type,
        tag: t.tag,
        info: t.info,
        content: t.content,
        text: plainText(inner),
        childrenHtml,
        attrs: (t.attrs as [string, string][] | null) ?? [],
      };
      if (type === "heading") {
        node.attrs = [
          ...node.attrs.filter(([k]) => k !== "id"),
          ["id", slugifyHeading(node.text)],
        ];
      }
      const { html: pluginHtml, node: current } = await dispatch(
        node,
        plugins,
      );
      if (pluginHtml !== null) {
        html += pluginHtml;
      } else {
        html += `<${current.tag}${attrsToHtml(current.attrs)}>` +
          current.childrenHtml +
          `</${current.tag}>\n`;
      }
      i = j + 1;
    } else if (t.type === "inline") {
      html += await renderInlineToken(t, plugins);
      i++;
    } else {
      // Leaf: dispatch, then default-render (transformed fences re-render).
      const node: RenderNode = {
        type: t.type,
        tag: t.tag,
        info: t.info,
        content: t.content,
        text: t.content,
        childrenHtml: "",
        attrs: (t.attrs as [string, string][] | null) ?? [],
      };
      const { html: pluginHtml, node: current } = await dispatch(
        node,
        plugins,
      );
      if (pluginHtml !== null) {
        html += pluginHtml;
      } else if (current !== node && current.type === "fence") {
        html += fenceHtml(current.info, current.content, lineNumbers);
      } else if (current !== node) {
        html += escapeHtml(current.content) + "\n";
      } else {
        html += defaultLeafHtml(t, lineNumbers);
      }
      i++;
    }
  }
  return html;
}

/** Render a markdown source string to HTML through the plugin pipeline.
 * `disabled` plugin ids are skipped for this call only; `lineNumbers`
 * adds a gutter to multi-line code fences. */
export async function renderMarkdown(
  source: string,
  opts: { disabled?: string[]; lineNumbers?: boolean } = {},
): Promise<string> {
  const plugins = await loadPlugins(
    opts.disabled?.length ? new Set(opts.disabled) : undefined,
  );
  const tokens = md.parse(source, {});
  return await renderBlock(tokens, plugins, opts.lineNumbers ?? false);
}
