import { getNoteIndex } from "./api.js";
import { useGlobalStore } from "./globalStore.js";

export function refreshNoteIndex() {
  const globalStore = useGlobalStore();
  return getNoteIndex()
    .then((titles) => {
      globalStore.noteTitles = titles;
    })
    .catch(() => {
      // A stale or missing index only affects wiki-link resolution.
      globalStore.noteTitles = [];
    });
}

export function resolveNoteTitle(linkText) {
  const globalStore = useGlobalStore();
  const titles = globalStore.noteTitles || [];
  const target = linkText.trim();
  // Exact title (path) match
  if (titles.includes(target)) {
    return target;
  }
  // Basename match, Obsidian-style (resolved vault-wide)
  const lower = target.toLowerCase();
  const matches = titles.filter(
    (title) => title.split("/").pop().toLowerCase() === lower,
  );
  if (matches.length > 0) {
    return matches.sort()[0];
  }
  // Unresolved: use as written (the note may be created later)
  return target;
}
