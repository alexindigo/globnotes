// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, toRefs, watch } from "vue";
import { getConflicts } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { acquireVaultChanges } from "./vaultChanges.js";
import { getStoredToken } from "./tokenStorage.js";
import { permissionEligibility, permissionSessionKey } from "./appSessionPolicy.js";
import { conflictTarget } from "./conflictNavigation.js";
import { createConflictReadRetry } from "./conflictReadRetry.js";

export const CONFLICT_INBOX = Symbol("conflict-inbox");

/** One vault-scoped list/count owner; no content or draft state lives here. */
export function createConflictInbox({ read = getConflicts, subscribe: on = subscribe,
  acquireChanges = acquireVaultChanges, token = getStoredToken, lifetime } = {}) {
  const data = reactive({ available: false, generation: 0, rows: [], total: null,
    revision: null, loading: false, stale: false, error: "", result: "" });
  let owners = 0, identity = null, disposed = false, flight = null, dirty = false;
  let releases = [], stopContext = null;
  const retry = createConflictReadRetry(refresh, { lifetime });
  const live = () => !disposed && owners > 0 && data.available;
  function retire() {
    retry.reset();
    data.generation++; flight = null; dirty = false;
    releases.splice(0).forEach(release => release());
    Object.assign(data, { rows: [], total: null, revision: null, loading: false, stale: false, error: "", result: "" });
  }
  async function refresh() {
    if (!live()) return false;
    retry.begin();
    data.stale = data.total !== null;
    if (flight) { dirty = true; return flight; }
    const generation = data.generation;
    data.loading = true; data.error = "";
    const current = () => live() && generation === data.generation;
    const work = (async () => {
      // Defer transport so the flight is installed even for a sync-throw adapter.
      await Promise.resolve();
      try {
        const result = await read();
        if (!current() || dirty) return false;
        data.rows = result.conflicts.map(row => ({ ...row, target: conflictTarget(row.id),
          reasonLabel: row.reason === "unknown-base" ? "Different on both sides" : row.reason === "overlapping-edits" ? "Overlapping edits" : "Changed since the writer read it",
          sourceLabel:row.peerLabel ?? (row.peer !== "local" && row.peer !== "globnotes" ? row.peer : ""),
          createdLabel: new Date(row.createdAt).toLocaleString() }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        data.total = result.total; data.revision = result.revision; data.stale = false;
        retry.reset();
        return true;
      } catch (error) {
        if (current() && !dirty) { data.error = "Could not load conflicts."; retry.failed(error); }
        return false;
      } finally {
        if (current()) {
          flight = null; data.loading = false;
          if (dirty) { dirty = false; refresh(); }
        }
      }
    })();
    flight = work;
    return work;
  }
  function start() {
    if (!live() || releases.length) return;
    // Subscribe before both stream acquisition and snapshot read.
    releases = [on(TOPICS.VAULT_CONFLICTS, refresh), on(TOPICS.VAULT_RESET, refresh),
      on(TOPICS.VAULT_CHANGE, refresh)];
    releases.push(acquireChanges()); refresh();
  }
  function setContext({ active, key }) {
    if (data.available === active && identity === key) return;
    retire(); identity = key; data.available = active; start();
  }
  function acquire() {
    if (disposed) return () => {};
    owners++; start(); let released = false;
    return () => { if (released) return; released = true; if (--owners === 0) retire(); };
  }
  function bindContext({ config, configReady, routeName, vault = () => "globnotes" }) {
    stopContext?.();
    const release = acquire();
    stopContext = watch(() => [!!routeName() && permissionEligibility(configReady(), config(), routeName(), token()),
      `${vault()}:${permissionSessionKey(config(), token())}`], ([active, key]) => setContext({ active, key }), { immediate: true, flush: "sync" });
    return () => { stopContext?.(); stopContext = null; release(); };
  }
  return {
    state: readonly(reactive({ ...toRefs(data),
      label: computed(() => data.total > 0 ? `Conflicts: ${data.total} unresolved` : "Conflicts") })),
    setContext, bindContext, acquire, refresh,
    lookupByMember: (path, member) => data.rows.find(row => member ? row[member] === path : row.path === path || row.copyPath === path),
    resolved(message) { data.result = message; return refresh(); },
    dispose() { stopContext?.(); stopContext = null; retire(); retry.dispose(); disposed = true; data.available = false; },
  };
}
