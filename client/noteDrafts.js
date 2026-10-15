import { isCurrentTokenStored } from "./tokenStorage.js";

/** Draft ownership belongs to one mounted note, across its path changes. */
export function createNoteDraftStore({
  local = localStorage,
  session = sessionStorage,
  isTokenStored = isCurrentTokenStored,
} = {}) {
  const owned = new Map();

  function save(path, content, revision) {
    const persisted = isTokenStored();
    if (typeof content !== "string" || !path) return;
    const storage = persisted ? local : session;
    storage.setItem(path, content);
    owned.set(`${persisted ? "local" : "session"}:${path}`, {
      storage, key: path, value: content, revision,
    });
  }

  function load(path, revision) {
    if (!path) return null;
    const localDraft = local.getItem(path);
    const sessionDraft = session.getItem(path);
    if (localDraft !== null) owned.set(`local:${path}`, {
      storage: local, key: path, value: localDraft, revision,
    });
    if (sessionDraft !== null) owned.set(`session:${path}`, {
      storage: session, key: path, value: sessionDraft, revision,
    });
    return localDraft ?? sessionDraft;
  }

  function clear() {
    for (const [id, record] of owned) {
      if (record.storage.getItem(record.key) === record.value) {
        record.storage.removeItem(record.key);
      }
      owned.delete(id);
    }
  }

  function clearAcknowledged(revision) {
    for (const [id, record] of owned) {
      if (record.revision <= revision && record.storage.getItem(record.key) === record.value) {
        record.storage.removeItem(record.key);
        owned.delete(id);
      }
    }
  }

  // A different logical note releases ownership without erasing its drafts.
  return { save, load, clear, clearAcknowledged, release: () => owned.clear() };
}
