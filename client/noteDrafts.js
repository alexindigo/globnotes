import { isCurrentTokenStored } from "./tokenStorage.js";
import { identityOwnerKey } from "../shared/identity_session.ts";

export function createIdentityNoteDraftStore({ prefix, identity, tokens, ...adapters }) {
  const owner = identityOwnerKey(identity());
  return createQualifiedDraftStore({ ...adapters, scope: JSON.stringify([prefix, owner]),
    isTokenStored: tokens.isCurrentTokenStored, isCurrent: () => identityOwnerKey(identity()) === owner });
}

const DRAFT_PREFIX = "globnotes:draft:";

function createQualifiedDraftStore({ local = localStorage, session = sessionStorage, scope, isTokenStored, isCurrent }) {
  const owned = new Map();
  const keyFor = path => `${DRAFT_PREFIX}identity:${encodeURIComponent(scope)}:${encodeURIComponent(path)}`;
  // This durable marker contains numbers only. Session-only text and its base
  // stay in session storage. A vanished tab does not itself retire anything.
  const markerKey = key => `${key}:history`;
  const metadataKey = key => `${key}:metadata`;
  const decode = text => { try { return JSON.parse(text); } catch { return null; } };
  const history = key => decode(local.getItem(markerKey(key))) ?? { latest: 0, retired: -1 };
  function read(storage, key) {
    const value = storage.getItem(key);
    if (value === null) return null;
    const meta = decode(storage.getItem(metadataKey(key)));
    return { storage, key, value, order: meta?.order ?? 0, base: meta?.base };
  }
  function remove(record) {
    record.storage.removeItem(record.key);
    record.storage.removeItem(metadataKey(record.key));
  }
  function retire(key, order) {
    const old = history(key), retired = Math.max(old.retired, order);
    local.setItem(markerKey(key), JSON.stringify({ latest: old.latest, retired }));
    for (const storage of [local, session]) {
      const record = read(storage, key);
      if (record && record.order <= retired) remove(record);
    }
    if (owned.get(key)?.order <= retired) owned.delete(key);
  }
  function save(path, value, revision, base) {
    if (!isCurrent() || !path || typeof value !== "string") return;
    const key = keyFor(path), old = history(key);
    const storage = isTokenStored() ? local : session;
    const previous = owned.get(key), stored = read(storage, key);
    if (previous?.revision === revision && previous.storage === storage && previous.order === stored?.order &&
        previous.order > old.retired && stored.value === value && stored.base === base) return;
    const order = Math.max(old.latest, old.retired) + 1;
    local.setItem(markerKey(key), JSON.stringify({ ...old, latest: order }));
    storage.setItem(key, value);
    storage.setItem(metadataKey(key), JSON.stringify({ order, base }));
    owned.set(key, { storage, key, value, revision, order, base });
  }
  function load(path, revision) {
    if (!path || !isCurrent()) return null;
    const key = keyFor(path), { retired } = history(key);
    const candidates = [read(local, key), read(session, key)].filter(record => record && record.order > retired);
    candidates.sort((a, b) => b.order - a.order);
    const selected = candidates[0];
    if (!selected) return null;
    const previous = owned.get(key);
    owned.set(key, { ...selected, revision: previous?.order === selected.order && previous.storage === selected.storage ? Math.min(previous.revision, revision) : revision });
    return selected.value;
  }
  function clear() {
    if (!isCurrent()) return;
    for (const [key, record] of owned) retire(key, record.order);
  }
  function clearClean() {
    if (!isCurrent()) return;
    for (const [key, record] of owned) {
      const stored = read(record.storage, key);
      if (stored?.order === record.order && stored.value === record.value) remove(record);
    }
    owned.clear();
  }
  function captureAcknowledgement(revision, paths) {
    if (!isCurrent()) return;
    const captured = new Map([...owned.values()].filter(record => record.revision <= revision).map(record => [record.key, record.order]));
    // A user can submit before the draft debounce runs. Capture the order at
    // submission, never at response time, so later drafts remain recoverable.
    for (const path of paths.filter(Boolean)) {
      const key = keyFor(path), existing = owned.get(key);
      if (!existing || existing.revision <= revision) captured.set(key, history(key).latest);
    }
    return () => { if (isCurrent()) for (const [key, order] of captured) retire(key, order); };
  }
  return { save, load, base: path => owned.get(keyFor(path))?.base, clear, clearClean, captureAcknowledgement,
    clearAcknowledged(revision) { captureAcknowledgement(revision, [])?.(); }, release: () => owned.clear() };
}
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
  scope = null, isCurrent = () => true,
} = {}) {
  const owned = new Map();
  const keyFor = path => scope === null ? DRAFT_PREFIX + path : `${DRAFT_PREFIX}identity:${encodeURIComponent(scope)}:${encodeURIComponent(path)}`;

  function save(path, content, revision) {
    if (!isCurrent()) return;
    const persisted = isTokenStored();
    if (typeof content !== "string" || !path) return;
    const storage = persisted ? local : session;
    const key = keyFor(path);
    storage.setItem(key, content);
    owned.set(`${persisted ? "local" : "session"}:${key}`, {
      storage, key, value: content, revision,
    });
  }

  function load(path, revision) {
    if (!path || !isCurrent()) return null;
    const key = keyFor(path);
    const localDraft = scope === null ? readDraft(local, path, key) : local.getItem(key);
    const sessionDraft = scope === null ? readDraft(session, path, key) : session.getItem(key);
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
