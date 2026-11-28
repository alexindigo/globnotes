import { getNoteIndex } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { useGlobalStore } from "./globalStore.js";
import { basenameOf } from "./notePath.js";
import { subscribeVaultNotes } from "./vaultNoteInvalidation.js";
import { createOperationOwner } from "./operationOwner.js";

const RETRY_DELAYS = [1000, 3000, 8000];

/** Prepared app-owned cache; retirement never touches a draft or editor. */
export function createIdentityNoteIndex({ sessionKey, canRead, read = getNoteIndex,
  store = useGlobalStore(), subscribeAction = subscribe, subscribeChanges = subscribeVaultNotes, failed = () => {} } = {}) {
  let ticket = 0, identity = null, disposed = false;
  let owner;
  const guarded = deliver => ({ prepare(value) {
    const prepared = { ...value };
    if (prepared.entries) prepared.entries = prepared.entries.map(entry => ({ ...entry }));
    if (disposed || prepared.key !== identity || prepared.key !== sessionKey() || !canRead() || prepared.ticket !== undefined && prepared.ticket !== ticket) void owner.release(prepared.operation);
    return { value: prepared };
  }, deliver });
  owner = createOperationOwner({ owner: Object.freeze({}),
    dispatch(intent) {
      if (intent.kind === "read") return read();
      if (intent.kind === "opened") return intent.path;
      const callback = intent.topic === TOPICS.NOTE_OPEN
        ? value => opened(value.path)
        : () => refresh();
      return { close: intent.topic === "changes" ? subscribeChanges(callback) : subscribeAction(intent.topic, callback) };
    },
    release: value => value?.close?.(),
    channels: {
      entries: guarded(value => {
        store.notePaths = value.entries.map(entry => entry.path); store.noteMeta = value.entries;
        const paths = new Set(store.notePaths);
        store.recentlyOpened = store.recentlyOpened.filter(path => paths.has(path));
      }),
      opened: guarded(value => { store.recentlyOpened = [value.path, ...store.recentlyOpened.filter(item => item !== value.path)].slice(0, 10); }),
      failed: guarded(value => failed(value.error)),
    },
  });
  for (const topic of [TOPICS.NOTE_CREATE, TOPICS.NOTE_RENAME, TOPICS.NOTE_DELETE, TOPICS.NOTE_OPEN, "changes"]) {
    const operation = owner.operation();
    owner.dispatch(operation, { kind: "subscribe", topic, operation }).catch(failed);
  }
  function setSession(next) {
    ticket++; identity = next;
    store.notePaths = []; store.noteMeta = []; store.recentlyOpened = [];
  }
  async function opened(path) {
    if (disposed || identity === null || !canRead()) return;
    const key = identity, operation = owner.operation();
    try {
      const result = await owner.dispatch(operation, { kind: "opened", path });
      owner.deliver(operation, "opened", { operation, key, path: result.value });
    } finally { await owner.release(operation); }
  }
  async function refresh() {
    const key = sessionKey(), own = ++ticket;
    if (disposed || key === null || !canRead() || key !== identity) return false;
    const operation = owner.operation();
    try {
      const entries = (await owner.dispatch(operation, { kind: "read" })).value;
      return owner.deliver(operation, "entries", { operation, key, ticket: own, entries });
    } catch (error) { owner.deliver(operation, "failed", { operation, key, ticket: own, error }); return false; }
    finally { await owner.release(operation); }
  }
  return Object.freeze({ setSession, refresh, hasWork: owner.hasWork, settle: owner.settle,
    dispose() { disposed = true; setSession(null); return owner.dispose(); } });
}

let activeIndex;
export function bindNoteIndex(index) {
  activeIndex = index;
  return () => { if (activeIndex === index) activeIndex = null; };
}
let refreshTicket = 0;
export function refreshNoteIndex(attempt = 0) {
  if (activeIndex) return activeIndex.refresh();
  return readIndex(attempt, ++refreshTicket);
}
function readIndex(attempt, ticket) {
  const globalStore = useGlobalStore();
  return getNoteIndex()
    .then((entries) => {
      if (ticket !== refreshTicket) return;
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
      if (ticket !== refreshTicket) return;
      // A failed fetch must not leave the sidebar empty forever:
      // retry a few times (the server may still be warming up), and
      // leave any previously-loaded titles in place on final failure.
      if (attempt < RETRY_DELAYS.length) {
        return new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS[attempt]),
        ).then(() => ticket === refreshTicket ? readIndex(attempt + 1, ticket) : undefined);
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
    (title) => basenameOf(title).toLowerCase() === lower,
  );
  if (matches.length > 0) {
    return matches.sort()[0];
  }
  // Unresolved: use as written (the note may be created later)
  return target;
}


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
