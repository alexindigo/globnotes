// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Selector grammar — plugins DECLARE, the host pipeline EVALUATES.
 *
 * A selector targets markdown-it tokens:
 *   { node: "fence", language: "mermaid" }
 *   { node: "blockquote", params: { has: "[!note]" } }
 *   { node: "text", params: { hasAny: ["![", "==", "%%"] } }
 *
 * params match against the node's plain text:
 *   has    — substring present
 *   hasAny — any substring present
 *   eq     — full equality
 */

export interface SelectorSpec {
  /** markdown-it token type ("fence", "blockquote", "inline", "text", …).
   * Omitted = any node. */
  node?: string;
  /** Fence info string, case-insensitive ("mermaid", "js", …). */
  language?: string;
  params?: {
    has?: string;
    hasAny?: string[];
    eq?: string;
  };
}

export interface SelectableNode {
  type: string;
  info: string;
  text: string;
}

export function matches(spec: unknown, node: SelectableNode): boolean {
  if (typeof spec !== "object" || spec === null) return false;
  const s = spec as SelectorSpec;
  if (s.node !== undefined && s.node !== node.type) return false;
  if (
    s.language !== undefined &&
    s.language.toLowerCase() !== node.info.trim().toLowerCase()
  ) {
    return false;
  }
  const p = s.params;
  if (p) {
    if (p.has !== undefined && !node.text.includes(p.has)) {
      return false;
    }
    if (
      p.hasAny !== undefined && !p.hasAny.some((h) => node.text.includes(h))
    ) {
      return false;
    }
    if (p.eq !== undefined && node.text !== p.eq) return false;
  }
  return true;
}
