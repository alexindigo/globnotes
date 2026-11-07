// SPDX-License-Identifier: LGPL-3.0-only
import { isCurrentTokenStored } from "./tokenStorage.js";

const prefix = "globnotes:conflict-draft:";
const keyOf = (scope, id) => `${prefix}${encodeURIComponent(scope)}:${encodeURIComponent(id)}`;

/** Browser-only custody, separate from note drafts and hub metadata. */
export function createConflictDraftStore({ local = localStorage, session = sessionStorage,
  isTokenStored = isCurrentTokenStored } = {}) {
  const owned = new Map();
  function claim(storage, key, value, revision) {
    let records = owned.get(storage);
    if (!records) owned.set(storage, records = new Map());
    records.set(key, { value, revision });
  }
  function save(scope, id, record, revision) {
    if (!scope || !id || typeof record?.content !== "string") return;
    const storage = isTokenStored() ? local : session, key = keyOf(scope, id);
    const value = JSON.stringify(record);
    storage.setItem(key, value); claim(storage, key, value, revision);
  }
  function load(scope, id) {
    if (!scope || !id) return null;
    const key = keyOf(scope, id);
    let accepted = null;
    for (const storage of [local, session]) {
      const value = storage.getItem(key);
      if (value === null) continue;
      try {
        const record = JSON.parse(value);
        if (typeof record?.content !== "string" || !Number.isSafeInteger(record.revision) || !record.base) continue;
        claim(storage, key, value, 0); accepted ??= record;
      } catch { /* Unrecognized bytes are not owned and never removed. */ }
    }
    return accepted;
  }
  function clearAcknowledged(revision) {
    for (const [storage, records] of owned) for (const [key, record] of records) {
      if (record.revision > revision) continue;
      if (storage.getItem(key) === record.value) storage.removeItem(key);
      records.delete(key);
    }
  }
  return { save, load, clearAcknowledged, clear: () => clearAcknowledged(Infinity), release: () => owned.clear() };
}
