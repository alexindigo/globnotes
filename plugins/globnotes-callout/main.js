// SPDX-License-Identifier: LGPL-3.0-only

// Obsidian-style callouts: > [!note] ... -> blockquote.callout.callout-note
// with the [!type] marker stripped from the first paragraph (parity with
// the old client's blockQuote/text renderer pair in baseOptions.js).

export function getSelectors() {
  return [{ node: "blockquote", params: { has: "[!" } }];
}

export function parseNode(node) {
  const match = node.text.trimStart().match(/^\[!(\w+)\]/);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const inner = node.childrenHtml.replace(/^(<p[^>]*>)\s*\[!\w+\]\s*/, "$1");
  return {
    parts: [
      `<blockquote class="callout callout-${type}">`,
      inner,
      "</blockquote>\n",
    ],
  };
}

export function onSync() {}
