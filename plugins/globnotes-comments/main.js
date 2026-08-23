// SPDX-License-Identifier: LGPL-3.0-only

// %%comments%% are hidden (Obsidian flavor). Runs on real text tokens —
// fences and code spans are structurally excluded, unlike the old
// client's regex preprocessing.

export function getSelectors() {
  return [{ node: "text", params: { has: "%%" } }];
}

export function parseNode(node) {
  const content = node.content.replace(/%%[\s\S]*?%%/g, "");
  if (content === node.content) return null;
  return { node: { content } };
}

export function onSync() {}
