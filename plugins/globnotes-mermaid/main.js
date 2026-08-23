// SPDX-License-Identifier: LGPL-3.0-only

// Mermaid fences render as <pre class="mermaid">; the client runs
// mermaid.js over them after mount (unchanged client-side behaviour).

export function getSelectors() {
  return [{ node: "fence", language: "mermaid" }];
}

export function parseNode(node) {
  const escaped = node.content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return { parts: [`<pre class="mermaid">${escaped}</pre>\n`] };
}

export function onSync() {}
