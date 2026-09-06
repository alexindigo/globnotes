// SPDX-License-Identifier: LGPL-3.0-only

// globnotes-properties — server/render half of the dual-mode Properties
// plugin. Claims the `front_matter` token (the pipeline already dispatches
// it) and emits the structured Properties markup. The client half
// (client.js) renders the same class hooks inside WYSIWYG; one styles.css
// covers both modes (the WYSIWYG wrapper carries .toastui-editor-contents).
// Unknown/complex YAML values pass through verbatim via the shared subset
// parser — never corrupted, never dropped.

import { parseFrontmatter } from "../../shared/frontmatter.ts";

/** Tabler outline icons (stroke paths), rendered inline — the worker has
 * no DOM, and plugins own their markup. */
const ICON_PATHS = {
  title: "M6 4h8a4 4 0 0 1 0 8h-8zM6 12h9a4 4 0 0 1 0 8h-9z",
  tags:
    "M7.5 4.5h6l4 4-6.5 6.5a1.5 1.5 0 0 1-2.1 0l-3.9-3.9a1.5 1.5 0 0 1 0-2.1zM9 8v.01",
  aliases: "M7 7l5 5-5 5M13 7l5 5-5 5",
  unknown: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37c1 .608 2.296.07 2.572-1.065z",
};

function icon(name) {
  return (
    `<svg class="properties-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${ICON_PATHS[name] ?? ICON_PATHS.unknown}"/></svg>`
  );
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function iconFor(key) {
  if (key === "title") return icon("title");
  if (key === "tags") return icon("tags");
  if (key === "aliases") return icon("aliases");
  return icon("unknown");
}

function valueHtml(value) {
  if (value.kind === "list") {
    const chips = value.items
      .map((item) => `<span class="properties-chip">${escapeHtml(item)}</span>`)
      .join("");
    return `<span class="properties-value properties-chips">${chips}</span>`;
  }
  if (value.kind === "raw") {
    return `<span class="properties-value properties-value-raw">${escapeHtml(
      value.text,
    )}</span>`;
  }
  return `<span class="properties-value properties-value-text">${escapeHtml(
    value.text,
  )}</span>`;
}

function rowHtml(entry) {
  return (
    `<div class="properties-row" data-key="${escapeHtml(entry.key)}">` +
    iconFor(entry.key) +
    `<span class="properties-key">${escapeHtml(entry.key)}</span>` +
    valueHtml(entry.value) +
    `</div>`
  );
}

export function getSelectors() {
  return [{ node: "front_matter" }];
}

export function parseNode(node) {
  if (node.type !== "front_matter") return null;
  const rows = parseFrontmatter(node.content).map(rowHtml).join("");
  return { parts: [`<div class="properties-panel">${rows}</div>\n`] };
}

export function onSync() {}
