import { isCurrentTokenStored } from "./tokenStorage.js";

const DRAFT_PREFIX = "globnotes:draft:";
// Bare legacy keys are ambiguous: these values belong to app modules, not drafts.
const APP_KEYS = new Set([
  "token", "defaultEditorMode", "expandedFolders", "sidebarRecent",
  "sidebarVisible", "sidebarPinned", "includeNested", "autoEnablePlugins",
  "pluginSwitches", "viewLineNumbers", "debug", "globnotes-theme",
  "globnotes-keybindings", "globnotes-keybindings-custom",
]);

function readDraft(storage, path, key) {
  const current = storage.getItem(key);
  if (current !== null || APP_KEYS.has(path) || path.startsWith(DRAFT_PREFIX)) {
    return current;
  }
  const legacy = storage.getItem(path);
  if (legacy === null) return null;
  // Migrate on first load, once per legacy record. Never overwrite a destination,
  // remove before copying, or claim ownership of conflicting/ambiguous bytes.
  storage.setItem(key, legacy);
  if (storage.getItem(key) === legacy && storage.getItem(path) === legacy) {
    storage.removeItem(path);
  }
  return storage.getItem(key);
}

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
    const key = DRAFT_PREFIX + path;
    storage.setItem(key, content);
    owned.set(`${persisted ? "local" : "session"}:${key}`, {
      storage, key, value: content, revision,
    });
  }

  function load(path, revision) {
    if (!path) return null;
    const key = DRAFT_PREFIX + path;
    const localDraft = readDraft(local, path, key);
    const sessionDraft = readDraft(session, path, key);
    if (localDraft !== null) owned.set(`local:${key}`, {
      storage: local, key, value: localDraft, revision,
    });
    if (sessionDraft !== null) owned.set(`session:${key}`, {
      storage: session, key, value: sessionDraft, revision,
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
