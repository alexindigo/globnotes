import { getNoteIndex } from "./api.js";
import { useGlobalStore } from "./globalStore.js";

const RETRY_DELAYS = [1000, 3000, 8000];

export function refreshNoteIndex(attempt = 0) {
  const globalStore = useGlobalStore();
  return getNoteIndex()
    .then((titles) => {
      globalStore.noteTitles = titles;
    })
    .catch((error) => {
      // A failed fetch must not leave the sidebar empty forever:
      // retry a few times (the server may still be warming up), and
      // leave any previously-loaded titles in place on final failure.
      if (attempt < RETRY_DELAYS.length) {
        return new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS[attempt]),
        ).then(() => refreshNoteIndex(attempt + 1));
      }
      console.error("[noteIndex] refresh failed after retries", error);
      if (!globalStore.noteTitles?.length) {
        globalStore.noteTitles = [];
      }
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
