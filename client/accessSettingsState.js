// SPDX-License-Identifier: LGPL-3.0-only
import { reactive } from "vue";

/** Owns configured Access wire/results; controls inject APIs and completion. */
export function createAccessSettingsState({ read, write, readStatus, completed, timeoutMs = 5000 }) {
  const state = reactive({ view: null, loading: false, pending: false, inFlight: false, unknown: false, needsReview: false, reviewing: false, error: "" });
  let disposed = false, owner = 0, attempt = 0, reviewId = 0, submission = null, wire = null, requiresLogin = false;
  async function observe(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Timed out waiting for the Access response.")), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async function load() {
    if (disposed || state.inFlight) return null;
    const ticket = ++owner;
    state.loading = true;
    try {
      const view = await observe(Promise.resolve().then(read));
      if (!disposed && ticket === owner) { state.view = view; state.error = ""; return view; }
    } catch (error) { if (!disposed && ticket === owner) state.error = error.response?.data?.detail ?? error.message; }
    finally { if (ticket === owner) state.loading = false; }
    return null;
  }
  function acknowledge(ticket, admitted, result) {
    if (disposed || ticket !== owner || submission !== admitted) return false;
    state.view = result.view;
    state.unknown = false; state.needsReview = false; state.error = ""; submission = null;
    completed(result);
    return true;
  }
  async function commit(payload, beforeCommit) {
    if (disposed || !state.view || state.loading || state.pending || state.inFlight || state.unknown || state.needsReview || state.reviewing || !state.view.settingsWritable) return false;
    const ticket = owner, before = state.view, proposed = { ...payload }, admission = ++attempt;
    state.pending = true; state.error = "";
    try {
      if (await beforeCommit() !== true) return false;
      if (disposed || ticket !== owner || admission !== attempt || before !== state.view || !before.settingsWritable || state.loading || state.needsReview || state.unknown) return false;
      requiresLogin = proposed.mode === "password" && (before.mode !== "password" || proposed.password !== undefined ||
        (proposed.username !== undefined && proposed.username.trim().toLowerCase() !== before.username) ||
        (proposed.totpEnabled ?? before.totpEnabled) !== before.totpEnabled || proposed.totpKey !== undefined);
      const admitted = { ...proposed, revision: before.revision, signature: before.signature, updateId: crypto.randomUUID() };
      submission = admitted;
      state.inFlight = true;
      const originalWire = Promise.resolve().then(() => write(admitted));
      wire = originalWire;
      let observed = false;
      originalWire.then(result => { if (!observed && state.unknown) acknowledge(ticket, admitted, result); }, () => {})
        .finally(() => { if (wire === originalWire) { wire = null; state.inFlight = false; } }).catch(() => {});
      try { const result = await observe(originalWire); observed = true; return acknowledge(ticket, admitted, result); }
      catch (error) {
        if (disposed || ticket !== owner) return false;
        const status = error.response?.status;
        state.unknown = !status || status >= 500;
        state.needsReview = state.unknown || status === 409;
        const reason = error.response?.data?.detail ?? error.message;
        state.error = state.unknown ? `Access update outcome is unknown. Review current access before retrying. ${reason}` : reason;
        if (!state.unknown) submission = null;
        return false;
      }
    } catch (error) { if (!disposed && ticket === owner) state.error = error.message; return false; }
    finally { state.pending = false; }
  }
  async function review() {
    if (disposed || state.loading || state.inFlight || state.pending || state.reviewing) return false;
    const ticket = owner, admitted = submission, admittedAttempt = attempt, reviewing = ++reviewId;
    const current = () => !disposed && ticket === owner && reviewing === reviewId && admittedAttempt === attempt && admitted === submission;
    state.reviewing = true;
    try {
      const status = await observe(Promise.resolve().then(readStatus));
      if (!current()) return false;
      if (admitted && status.accessUpdateId === admitted.updateId) {
        return acknowledge(ticket, admitted, { requiresLogin, recovered: true, config: status, view: state.view });
      }
      const fresh = await observe(Promise.resolve().then(read));
      if (!current()) return false;
      // Read-back does not discard/replay choices or acknowledge another writer.
      state.view = fresh; state.unknown = false; state.needsReview = false; submission = null;
      state.error = "Current access reviewed. Your choices are retained; submit explicitly to apply them.";
      return true;
    } catch (error) { if (current()) state.error = error.response?.data?.detail ?? error.message; return false; }
    finally { if (reviewing === reviewId) state.reviewing = false; }
  }
  return { state, load, commit, review, canDismiss: () => !state.pending && !state.inFlight && !state.unknown && !state.reviewing,
    dispose() { disposed = true; owner++; } };
}
