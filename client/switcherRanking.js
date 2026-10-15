// SPDX-License-Identifier: LGPL-3.0-only
import { fuzzyFilter, windowAroundMatch } from "./fuzzy.js";
import { basenameOf } from "./notePath.js";

// The pinned full-search row is additional to these note rows.
const MAX_RESULTS = 9;

function matchText(note) {
  // Keep the full path for cross-segment queries and the basename for notes
  // whose display title differs from their filename.
  return [
    { text: note.title, weight: 1.5, kind: "title" },
    ...(note.aliases || []).map(alias => ({ text: alias, weight: 1.4, kind: "alias" })),
    { text: basenameOf(note.path), weight: 1.3, kind: "file" },
    { text: note.path, weight: 1, kind: "path" },
  ];
}

export function rankSwitcherResults(query, noteMeta, recentlyOpened) {
  const term = query.trim();
  const matchQuery = term.startsWith("#") ? term.slice(1) : term;
  let ranked;
  if (term) {
    ranked = fuzzyFilter(matchQuery, noteMeta, matchText);
  } else {
    const metaByPath = new Map(noteMeta.map(note => [note.path, note]));
    ranked = recentlyOpened
      .map(path => metaByPath.get(path) ?? { path, title: basenameOf(path), aliases: [] })
      .map(item => ({ item, score: 0, positions: [], matchedText: null, matchedKind: null }));
  }
  return ranked.slice(0, MAX_RESULTS);
}

export function switcherMatchKind(entry) {
  if (!entry.matchedKind) return null;
  if (entry.matchedKind === "title" && entry.item.title === basenameOf(entry.item.path)) {
    return "file";
  }
  return entry.matchedKind;
}

export function switcherAnnotation(entry) {
  const kind = switcherMatchKind(entry);
  if (kind === "title" || kind === "alias") {
    return windowAroundMatch(entry.matchedText, entry.positions);
  }
  const path = entry.item.path;
  if (kind === "path") return windowAroundMatch(path, entry.positions);
  // File: offset basename positions into the full path before windowing.
  const offset = path.length - entry.matchedText.length;
  return windowAroundMatch(path, entry.positions.map(position => position + offset));
}
