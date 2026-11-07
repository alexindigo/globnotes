// SPDX-License-Identifier: LGPL-3.0-only
import { computed, reactive, readonly, watch } from "vue";
import { getConflict, resolveConflict } from "./api.js";
import { subscribe, TOPICS } from "./bus/index.js";
import { conflictFileHref, conflictsTarget, sameConflictPair } from "./conflictNavigation.js";
import { createConflictDraftStore } from "./conflictDrafts.js";
import { registerSessionParticipant } from "./sessionActions.js";
import { createUnloadConfirmation } from "./unloadGuard.js";
import { classifyNoteSaveFailure, NOTE_SAVE_OBSERVATION_MS } from "./noteSaveQueue.js";
import { requestReauthentication } from "./reauthentication.js";
import { operationError } from "./operationErrors.js";
import { readPathPrefix } from "./pathPrefix.js";
import { createConflictReadRetry } from "./conflictReadRetry.js";

const bases = pair => ({ original: { kind: "version", version: pair.original.version }, copy: { kind: "version", version: pair.copy.version } });
const labels = { original: "Keep original", copy: "Keep conflict copy", both: "Keep both", merge: "Save merge" };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/** One URL-selected comparison owns reads, local draft and exactly one wire.
 * Observation failure is never cancellation of an admitted server operation. */
export function createConflictResolutionController({ read = getConflict, send = resolveConflict,
  subscribe: on = subscribe, inbox, navigate = () => {}, fileHref = conflictFileHref,
  openFile = href => { window.location.href = href; },
  getContext = () => ({ writable: true, scope: `${readPathPrefix()}:globnotes` }),
  drafts = createConflictDraftStore(), registerParticipant = registerSessionParticipant,
  unload = createUnloadConfirmation(), requestAuthentication = requestReauthentication,
  observationMs = NOTE_SAVE_OBSERVATION_MS, lifetime } = {}) {
  const state = reactive({ id: null, status: "idle", pair: null, reviewRequired: false,
    error: "", feedback: "", settledByUs: false, originalHref: "", copyHref: "", merge: false, draft: "",
    recovered: false, confirmation: null, decision: null, busy: false, unknown: false,
    authenticationRequired: false, retainedFailure: false, draftRetained: false,
    resolvedElsewhere: computed(() => state.status === "resolved" && !state.settledByUs),
    // General status belongs to the same flags as authority/capabilities. Only
    // specific operation/storage feedback and acknowledged receipts are stored.
    message: computed(() => state.feedback || (state.authenticationRequired
      ? "Not saved. Sign in to finish this resolution; your choice and merge draft are retained."
      : state.busy ? "Resolving..."
      : state.unknown ? "The resolution outcome is unknown. Your choice and merge draft are retained. Review current versions; do not resend."
      : state.resolvedElsewhere && hasDraft() ? "The conflict is closed. Any unacknowledged merge draft is retained until you discard it." : "")),
    canResolve: computed(() => state.status === "open" && !state.reviewRequired && !state.error &&
      !state.busy && !state.unknown && !state.authenticationRequired && !state.recovered && getContext().writable !== false),
    canKeep: computed(() => state.canResolve && !state.merge),
    canMerge: computed(() => state.canResolve && !state.merge && editable()),
    canSaveMerge: computed(() => state.canResolve && state.merge && editable()),
  });
  let generation = 0, flight = null, dirty = false, pending = null, disposed = false, releases = [];
  let wire = null, choice = null, recovered = null, draftBase = null, draftRevision = 0, seed = "", scope = "";
  let reviewLocked = false;
  let decision = null, departure = null, mounted = false;
  const retry = createConflictReadRetry(refresh, { lifetime });
  const current = own => !disposed && own === generation;
  const editable = () => [state.pair?.original, state.pair?.copy].every(member => member?.preview === "text" && typeof member.content === "string");
  const hasDraft = () => state.recovered || state.draftRetained || (state.merge && state.draft !== seed);
  const hasUnsavedChanges = () => hasDraft() || state.busy || state.unknown || state.authenticationRequired || state.retainedFailure;
  const stopUnload = watch(hasUnsavedChanges, value => unload.set(value), { immediate: true, flush: "sync" });

  function persist() {
    if (!state.merge || !hasDraft()) return;
    try { drafts.save(scope, state.id, { content: state.draft, ...draftBase }, draftRevision); }
    catch { state.feedback = "The browser could not retain this merge draft. Keep this page open until you save or copy it."; }
  }
  function cancelConfirmation() { choice = null; state.confirmation = null; }
  function markChanged(lock = false) { cancelConfirmation(); reviewLocked ||= lock; state.reviewRequired = true; }
  function accept(pair) {
    state.pair = pair; state.status = "open"; state.reviewRequired = false; reviewLocked = false; pending = null;
    state.originalHref = fileHref(pair.original.path); state.copyHref = fileHref(pair.copy.path);
  }
  function closed() {
    state.status = "resolved"; pending = null; state.reviewRequired = false; cancelConfirmation();
    if (!state.settledByUs) state.feedback = "";
    // Closed state prevents all future effects for this record. It does not ACK
    // a draft, even if a lost merge request might have written equal bytes.
    state.unknown = false; state.authenticationRequired = false; state.retainedFailure = false;
    if (wire) {
      wire.closed = true;
      if (!wire.inFlight) { clearTimeout(wire.timer); wire.finish(false); wire = null; state.busy = false; }
    }
    inbox?.refresh?.();
  }
  async function refresh() {
    if (disposed || !state.id) return;
    retry.begin();
    if (flight) { dirty = true; return flight; }
    const own = generation, id = state.id;
    const work = (async () => {
      await Promise.resolve();
      try {
        const fresh = await read(id);
        if (!current(own) || dirty) return;
        retry.reset();
        state.error = "";
        if (fresh.state === "resolved") closed();
        else if (state.status === "resolved") return; // Closure is terminal for this selected id.
        else if (state.pair && !sameConflictPair(state.pair, fresh)) { pending = fresh; markChanged(true); }
        else if (!reviewLocked) accept(fresh);
        else pending = fresh;
      } catch (error) {
        if (!current(own) || dirty) return;
        if (error.response?.status === 404) { state.status = "missing"; state.pair = null; cancelConfirmation(); }
        else {
          state.error = "Could not load comparison."; if (!state.pair) state.status = "error";
          retry.failed(error);
          if (error.response?.status === 401) {
            persist();
            Promise.resolve(requestAuthentication()).then(ok => { if (ok && current(own)) refresh(); }).catch(() => {});
          }
        }
      } finally {
        if (current(own)) { flight = null; if (dirty) { dirty = false; refresh(); } }
      }
    })();
    flight = work; return work;
  }
  function select(id) {
    if (state.id === id || disposed) return;
    // Route guards settle authority before prop changes. A direct consumer must
    // use that same guard; refusing here prevents silently abandoning a draft.
    if (hasUnsavedChanges()) return false;
    retry.reset();
    generation++; flight = null; dirty = false; pending = null; cancelConfirmation(); drafts.release();
    scope = getContext().scope ?? `${readPathPrefix()}:globnotes`;
    draftBase = null; draftRevision = 0; recovered = null; seed = ""; reviewLocked = false;
    Object.assign(state, { id, status: id ? "loading" : "idle", pair: null, reviewRequired: false, error: "", feedback: "", settledByUs: false,
      merge: false, draft: "", recovered: false, draftRetained: false, retainedFailure: false });
    if (id) {
      try { recovered = drafts.load(scope, id); } catch { state.feedback = "Could not read the browser merge draft."; }
      state.recovered = !!recovered;
    }
    return refresh();
  }
  function invalidate(entry) {
    const pair = state.pair;
    if (!entry || !pair || [pair.original.path, pair.copy.path].some(path => path === entry.path || path === entry.oldPath)) {
      if (pair && state.status === "open") markChanged();
      return refresh();
    }
  }
  function mount(id) {
    if (mounted) return; mounted = true;
    releases = [on(TOPICS.VAULT_CHANGE, invalidate), on(TOPICS.VAULT_RESET, () => invalidate()),
      on(TOPICS.VAULT_CONFLICTS, refresh), inbox?.acquire?.(), registerParticipant("conflict-comparison", {
        hasUnsavedChanges, settlePending, requestDecision, save: saveForDeparture, discard, retainForAuthentication: persist,
      })].filter(Boolean);
    return select(id);
  }
  async function reviewCurrent() {
    // Read past a superseded in-flight read, then accept only this explicit
    // review's latest complete pair. Never clear an open unknown-wire barrier.
    const own = generation; cancelConfirmation();
    if (flight) { await flight; if (!current(own)) return; }
    pending = null; await refresh();
    while (current(own) && flight) await flight;
    if (!current(own) || state.error || state.status === "resolved") return;
    if (pending) accept(pending);
    if (state.merge && state.status === "open" && !state.reviewRequired) {
      draftBase = { revision: state.pair.revision, base: bases(state.pair) }; persist();
    }
  }
  function editMerge() {
    if (!state.canMerge) return false;
    seed = state.pair.original.content; state.draft = seed; state.merge = true;
    draftBase = { revision: state.pair.revision, base: bases(state.pair) }; return true;
  }
  function setDraft(text) {
    if (!state.merge || state.busy || state.authenticationRequired || typeof text !== "string" || text === state.draft) return;
    state.draft = text; draftRevision++; state.draftRetained = true; cancelConfirmation(); persist();
  }
  function resumeDraft() {
    if (!recovered) return;
    state.draft = recovered.content; draftBase = { revision: recovered.revision, base: recovered.base };
    seed = state.pair?.original.content ?? ""; state.merge = true; state.recovered = false; state.draftRetained = true;
    recovered = null; markChanged(true);
  }
  function discard() {
    if (state.busy || state.unknown || state.authenticationRequired) return false;
    try { drafts.clear(); } catch { state.feedback = "Could not discard the browser draft. Your text is retained."; return false; }
    state.merge = false; state.draft = ""; state.recovered = false; state.draftRetained = false;
    state.retainedFailure = false; recovered = null; draftBase = null; wire = null; cancelConfirmation(); return true;
  }
  function capture(action, autoReturn) {
    return freeze({ id: state.id, generation, action, draftRevision, autoReturn,
      payload: { action, revision: state.pair.revision, base: bases(state.pair), ...(action === "merge" ? { content: state.draft } : {}) } });
  }
  function choose(action) {
    if (!Object.hasOwn(labels, action)) return false;
    if (action === "merge" ? !state.canSaveMerge : !state.canKeep) return false;
    const captured = capture(action, true);
    if (action === "both") return dispatch(captured);
    const { original, copy } = state.pair;
    const message = action === "original" ? `Keep ${original.path} and delete ${copy.path}?`
      : action === "copy" ? `Replace ${original.path} with ${copy.path}, then delete ${copy.path}?`
      : `Save merge to ${original.path} and delete ${copy.path}?`;
    choice = captured; state.confirmation = { identity: ++confirmationSerial, message, label: labels[action] }; return true;
  }
  let confirmationSerial = 0;
  function confirmResolution(identity) {
    if (!choice || identity !== state.confirmation?.identity || !state.canResolve) return false;
    const captured = choice; cancelConfirmation(); return dispatch(captured);
  }
  function validReceipt(result, captured) {
    if (result?.status !== "settled" || result.id !== captured.id || !Number.isSafeInteger(result.revision)) return false;
    if (result.alreadyResolved === true) return true;
    return result.action === captured.action && Array.isArray(result.remaining) && result.remaining.length > 0 &&
      result.remaining.every(file => typeof file.path === "string" && typeof file.version === "string") &&
      Array.isArray(result.removed) && result.removed.every(path => typeof path === "string");
  }
  function dispatch(captured) {
    if (wire || !state.canResolve || captured.generation !== generation) return Promise.resolve(false);
    const entry = { captured, inFlight: false, timedOut: false, finished: false };
    entry.completion = new Promise(resolve => { entry.finish = result => { if (!entry.finished) { entry.finished = true; resolve(result); } }; });
    wire = entry; state.busy = true; state.retainedFailure = false; state.feedback = "";
    const owns = () => current(captured.generation) && wire === entry;
    function armObservation() { entry.timer = setTimeout(() => {
      if (!owns()) return;
      entry.timedOut = true; state.busy = false; state.unknown = !entry.closed;
      entry.finish(false);
    }, observationMs); }
    async function run() {
      try {
        entry.inFlight = true;
        armObservation();
        const result = await send(captured.id, captured.payload);
        entry.inFlight = false;
        if (!owns()) return;
        if (!validReceipt(result, captured)) throw Error("Unrecognized resolution receipt");
        clearTimeout(entry.timer); wire = null; state.busy = false; state.unknown = false; state.authenticationRequired = false;
        if (result.alreadyResolved) { closed(); entry.finish(false); return; }
        state.status = "resolved"; state.reviewRequired = false; state.settledByUs = true;
        if (captured.action === "merge" && draftRevision === captured.draftRevision && state.draft === captured.payload.content) {
          try { drafts.clearAcknowledged(captured.draftRevision); }
          catch {
            state.feedback = "The merge was saved, but its browser draft could not be cleared. Discard the local draft explicitly.";
            state.draftRetained = true; entry.finish(false); return;
          }
          state.merge = false; state.draft = ""; state.draftRetained = false;
        }
        const message = `Kept ${result.remaining.map(file => file.path).join(" and ")}.${result.removed.length ? ` Removed ${result.removed.join(" and ")}.` : " Both files remain at their existing names."}`;
        state.feedback = message; inbox?.resolved?.(message); entry.finish(true);
        // A failed observation has already aborted its navigation/logout. Late
        // acknowledgement updates truth only; it never revives that transition.
        if (!entry.timedOut && !entry.transitionAborted && captured.autoReturn && !hasDraft()) navigate(conflictsTarget());
      } catch (error) {
        entry.inFlight = false;
        if (!owns()) return;
        const data = error?.response?.data;
        if (!entry.timedOut && error?.response?.status === 401 && data?.detail === "Invalid authentication credentials") {
          clearTimeout(entry.timer);
          state.authenticationRequired = true; state.busy = false; persist();
          let accepted = false;
          try { accepted = await requestAuthentication(); } catch { /* retain the same authenticated-retry choice */ }
          if (!owns() || entry.timedOut) return;
          if (accepted) { state.authenticationRequired = false; state.busy = true; return run(); }
          clearTimeout(entry.timer); state.authenticationRequired = false; state.retainedFailure = true; wire = null;
          markChanged(true); refresh(); entry.finish(false); return;
        }
        clearTimeout(entry.timer); state.busy = false;
        if (!entry.timedOut && (data?.code === "conflict_stale" || classifyNoteSaveFailure(error, "sending") !== "unknown")) {
          wire = null; state.retainedFailure = true; markChanged(true);
          state.feedback = data?.code === "conflict_stale" ? ""
            : operationError(error)?.message ?? "This resolution was not applied. Your choice and draft are retained.";
          refresh();
        } else {
          state.unknown = true;
          state.feedback = "";
        }
        entry.finish(false);
      }
    }
    run(); return entry.completion;
  }
  async function settlePending() {
    if (disposed) return false;
    const own = generation, pendingWire = wire;
    if (state.unknown) return false;
    if (pendingWire?.closed && !state.busy) return true;
    if (pendingWire) {
      let timer;
      const bounded = new Promise(resolve => { timer = setTimeout(() => {
        pendingWire.transitionAborted = true; resolve(false);
      }, observationMs); });
      try { return await Promise.race([pendingWire.completion, bounded]) && current(own) && !state.unknown; }
      finally { clearTimeout(timer); }
    }
    return !state.authenticationRequired;
  }
  function requestDecision(reason, allowSave = true) {
    if (decision) return decision.promise;
    const entry = { generation };
    entry.promise = new Promise(resolve => { entry.resolve = resolve; }); decision = entry;
    state.decision = { reason, canSave: allowSave && state.canSaveMerge,
      message: state.canSaveMerge && allowSave
        ? `Save merge to ${state.pair.original.path} and delete ${state.pair.copy.path}, discard only the local draft, or cancel?`
        : "Discard only the local merge draft and retained choice, or cancel? Vault files will not be changed." };
    return entry.promise;
  }
  function onDecision(value) {
    if (!decision) return;
    if (value === "save" && !state.decision.canSave) return;
    const entry = decision; decision = null; state.decision = null;
    entry.resolve(current(entry.generation) ? value : "cancel");
  }
  async function saveForDeparture() {
    if (!state.canSaveMerge) return false;
    // The Save/Discard/Cancel dialog already named both destructive effects.
    const ok = await dispatch(capture("merge", false));
    return ok && !hasUnsavedChanges();
  }
  function gateNavigation() {
    if (departure) return departure;
    const own = generation;
    departure = (async () => {
      if (!await settlePending() || !current(own)) return false;
      if (!hasUnsavedChanges()) return true;
      const answer = await requestDecision("navigation");
      if (!current(own)) return false;
      return answer === "save" ? saveForDeparture() : answer === "discard" ? discard() : false;
    })().finally(() => { departure = null; });
    return departure;
  }
  async function cancelMerge() {
    if (!await settlePending()) return false;
    if (hasDraft()) {
      if (await requestDecision("cancel merge", false) !== "discard") return false;
    }
    return discard();
  }
  return { state: readonly(state), select, mount, refresh, reviewCurrent, choose, confirmResolution, cancelConfirmation,
    editMerge, setDraft, resumeDraft, discard, cancelMerge, hasUnsavedChanges, settlePending, requestDecision, onDecision,
    gateNavigation, saveForDeparture,
    contextChanged() {
      // Credential recovery keeps the participant/draft alive. Real departures
      // are guarded before context retirement and clear private visible data.
      if (hasUnsavedChanges()) { markChanged(true); return; }
      const id = state.id; state.id = null; return select(inbox?.state.available ? id : null);
    },
    back: () => navigate(conflictsTarget()),
    async followFile(event, href) { event.preventDefault(); if (await gateNavigation()) openFile(href); },
    dispose() {
      if (disposed) return;
      persist(); onDecision("cancel"); disposed = true; generation++; retry.dispose();
      if (wire) { clearTimeout(wire.timer); wire.finish(false); }
      releases.splice(0).forEach(release => release()); stopUnload(); unload.dispose(); drafts.release();
    },
  };
}
