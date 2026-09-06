// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin SDK entry — the host-module registry for the dual-mode contract
 * in production builds. Re-exports the host-owned packages a plugin's
 * client.js may import; the build injects an import map that maps their
 * bare specifiers to this chunk. (The browser-native equivalent of
 * Grafana's AMD registry / Obsidian's host-provided `obsidian` module.)
 * The chunk re-exports the same module instances the app bundle uses, so
 * plugin factories share the editor's ctx slices — never a second copy.
 */

export * from "@milkdown/core";
export * from "@milkdown/ctx";
export * from "@milkdown/utils";
export * from "prosemirror-state";
export * from "prosemirror-view";
export * from "@globnotes/frontmatter-node";
export * from "@globnotes/frontmatter";
