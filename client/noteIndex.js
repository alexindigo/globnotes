import { getNoteIndex } from "./api.js";
import { useGlobalStore } from "./globalStore.js";

export function refreshNoteIndex() {
  const globalStore = useGlobalStore();
  console.log("[noteIndex] refresh started");
  return getNoteIndex()
    .then((titles) => {
      console.log(`[noteIndex] loaded ${titles.length} titles`);
      globalStore.noteTitles = titles;
    })
    .catch((error) => {
      console.error("[noteIndex] refresh FAILED", error);
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
