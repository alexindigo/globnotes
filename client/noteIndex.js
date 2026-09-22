import { getNoteIndex } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { useGlobalStore } from "./globalStore.js";

const RETRY_DELAYS = [1000, 3000, 8000];

export function refreshNoteIndex(attempt = 0) {
  const globalStore = useGlobalStore();
  return getNoteIndex()
    .then((entries) => {
      globalStore.notePaths = entries.map((e) => e.path);
      globalStore.noteMeta = entries;
      // Recents must not outlive the note — reconcile against the fresh
      // index here, so in-app deletes AND external deletions (Obsidian,
      // git, another tab — any path the SyncBanner rescans) all get pruned
      // by the same fetch, with no extra requests.
      const paths = new Set(globalStore.notePaths);
      globalStore.recentlyOpened = globalStore.recentlyOpened.filter((p) =>
        paths.has(p)
      );
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
      if (!globalStore.notePaths?.length) {
        globalStore.notePaths = [];
      }
    });
}

export function resolveNotePath(linkText) {
  const globalStore = useGlobalStore();
  const titles = globalStore.notePaths || [];
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

subscribe(TOPICS.NOTE_CREATE, () => refreshNoteIndex());
subscribe(TOPICS.NOTE_RENAME, () => refreshNoteIndex());
subscribe(TOPICS.NOTE_DELETE, () => refreshNoteIndex());

// Track recently opened notes for the quick switcher's empty-query state.
subscribe(TOPICS.NOTE_OPEN, ({ path }) => {
  const store = useGlobalStore();
  store.recentlyOpened = [
    path,
    ...store.recentlyOpened.filter((p) => p !== path),
  ].slice(0, 10);
});

// Recents follow renames by bumping to the front: renaming is fresh
// activity on the note, so it lands at the top (like a NOTE_OPEN),
// bounded and de-duplicated — present entries only.
subscribe(TOPICS.NOTE_RENAME, ({ oldPath, newPath }) => {
  const store = useGlobalStore();
  if (!store.recentlyOpened.includes(oldPath)) return;
  store.recentlyOpened = [
    newPath,
    ...store.recentlyOpened.filter((p) => p !== oldPath && p !== newPath),
  ].slice(0, 10);
});
