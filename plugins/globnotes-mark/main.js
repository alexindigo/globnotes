// SPDX-License-Identifier: LGPL-3.0-only

// ==highlight== -> <mark>highlight</mark> (parity with the old client's
// ToastUI text rule in baseOptions.js). Emits raw HTML; markdown-it is
// configured with html: true so it passes through.

export function getSelectors() {
  return [{ node: "text", params: { has: "==" } }];
}

export function parseNode(node) {
  // Only complete ==x== segments (single line, non-empty) become marks.
  const out = node.content.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  if (out === node.content) return null;
  return { node: { content: out } };
}

export function onSync() {}
