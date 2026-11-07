// SPDX-License-Identifier: LGPL-3.0-only
import { reactive, readonly } from "vue";
import { getConflict } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { conflictFileHref, conflictsTarget, sameConflictPair } from "./conflictNavigation.js";

/** Owns one URL-selected comparison. Reads always accept a complete pair. */
export function createConflictResolutionController({ read = getConflict, subscribe: on = subscribe,
  inbox, navigate = () => {}, fileHref = conflictFileHref } = {}) {
  const state = reactive({ id: null, status: "idle", pair: null, reviewRequired: false,
    error: "", originalHref: "", copyHref: "" });
  let generation = 0, flight = null, dirty = false, pending = null, disposed = false, releases = [];
  async function refresh() {
    if (disposed || !state.id) return;
    if (flight) { dirty = true; return flight; }
    const own = generation, id = state.id;
    const current = () => !disposed && own === generation;
    const work = (async () => {
      await Promise.resolve();
      try {
        const fresh = await read(id);
        if (!current() || dirty) return;
        state.error = "";
        if (fresh.state === "resolved") { state.status = "resolved"; pending = null; state.reviewRequired = false; }
        else if (state.pair && !sameConflictPair(state.pair, fresh)) {
          pending = fresh; state.reviewRequired = true;
        } else accept(fresh);
      } catch (error) {
        if (!current() || dirty) return;
        if (error.response?.status === 404) { state.status = "missing"; state.pair = null; }
        else { state.error = "Could not load comparison."; if (!state.pair) state.status = "error"; }
      } finally {
        if (current()) { flight = null; if (dirty) { dirty = false; refresh(); } }
      }
    })();
    flight = work; return work;
  }
  function accept(pair) {
    state.pair = pair; state.status = "open"; state.reviewRequired = false; pending = null;
    state.originalHref = fileHref(pair.original.path); state.copyHref = fileHref(pair.copy.path);
  }
  function select(id) {
    if (state.id === id) return;
    generation++; flight = null; dirty = false; pending = null;
    Object.assign(state, { id, status: id ? "loading" : "idle", pair: null, reviewRequired: false, error: "" });
    return refresh();
  }
  function invalidate(entry) {
    const pair = state.pair;
    if (!entry || !pair || [pair.original.path, pair.copy.path].some(path => path === entry.path || path === entry.oldPath)) {
      if (pair) state.reviewRequired = true;
      return refresh();
    }
  }
  function mount(id) {
    releases = [on(TOPICS.VAULT_CHANGE, invalidate), on(TOPICS.VAULT_RESET, () => invalidate()),
      on(TOPICS.VAULT_CONFLICTS, refresh), inbox?.acquire?.()].filter(Boolean);
    return select(id);
  }
  async function reviewCurrent() {
    // An explicit review always reads again; a cached candidate is not authority.
    pending = null;
    await refresh();
    if (pending) accept(pending);
  }
  return { state: readonly(state), select, mount, refresh, reviewCurrent,
    contextChanged() { const id = state.id; state.id = null; return select(inbox?.state.available ? id : null); },
    back: () => navigate(conflictsTarget()),
    dispose() { disposed = true; generation++; releases.splice(0).forEach(release => release()); },
  };
}
