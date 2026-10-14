// SPDX-License-Identifier: LGPL-3.0-only
import { reactive } from "vue";

const copy = value => JSON.parse(JSON.stringify(value));
const sameBase = (left, right) => !!left && !!right && left.revision === right.revision && left.signature === right.signature;
const rejectedCodes = new Set(["plugin_policy_conflict", "invalid_plugin_policy", "policy_pinned"]);

/** One retained policy intent and reservation shared by enablement/default writes.
 * Adapters own transport and captured-plugin preparation; no App/editor imports. */
export function createPluginInventoryController({ getCatalog, getSession, writable, captureOwner,
  acknowledge, writeEnabled, writePolicy, refreshCatalog, prepareDisable = async () => true,
  confirm = async () => "cancel", timeout = 5000, clock = globalThis }) {
  const state = reactive({ intent: null, status: "idle", preparing: false, pending: false, inFlight: false,
    reviewing: false, unknown: false, needsReview: false, reviewed: false, committed: false, error: "", version: 0 });
  let task = null, request = null, wire = null, disposed = false, failureVersion = 0, reviewTicket = 0;
  const current = target => !disposed && task === target && target.key === getSession() && target.owner.current();
  const policy = () => getCatalog()?.policy;
  const busy = () => !!request || !!wire || state.preparing || state.reviewing;
  const hasWork = () => !!state.intent || busy();

  async function observe(promise, message) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = clock.setTimeout(() => reject(Error(message)), timeout);
    })]); } finally { clock.clearTimeout(timer); }
  }
  function snapshot() {
    const canRetry = !!task && current(task) && writable() && !busy() && !state.committed &&
      (!state.unknown || state.reviewed) && !state.needsReview && sameBase(task.base, policy());
    return { ...state, intent: state.intent ? copy(state.intent) : null, busy: busy(), hasWork: hasWork(),
      canMutate: writable() && !hasWork(), canReview: !!task && !busy(), canRetry,
      canDiscard: !!task && !busy() && (!state.unknown || state.reviewed),
      label: task?.intent.type === "auto-enable" ? "Auto-enable policy" : `Plugin enablement: ${task?.intent.id ?? ""}` };
  }
  function retainFailure(target, error, unknown) {
    if (task !== target || disposed) return;
    failureVersion++;
    state.status = unknown ? "unknown" : "failed"; state.unknown = unknown; state.needsReview = true; state.reviewed = false;
    state.error = error?.response?.data?.detail ?? error?.message ?? "Inventory write failed; review current policy before deciding what to do.";
  }
  function clearChoice() {
    task = null; state.intent = null; state.status = "idle"; state.unknown = false; state.needsReview = false;
    state.reviewed = false; state.committed = false; state.error = "";
  }
  function recordAcknowledgement(target, result) {
    if (!Number.isSafeInteger(result?.policy?.revision) || typeof result.policy.signature !== "string") throw Error("Inventory acknowledgement is incomplete; read current policy before deciding.");
    target.committed = copy(result.policy); state.committed = true; state.unknown = false; state.reviewed = false;
    state.needsReview = true; state.status = "committed";
    if (current(target)) acknowledge(result.policy, target.owner);
  }
  async function finishCommitted(target) {
    if (!current(target)) return false;
    try {
      const receipt = await refreshCatalog();
      if (!current(target) || receipt?.status !== "accepted") throw Error("Policy saved; catalogue refresh was not accepted. Review current policy.");
      if (receipt.catalog?.policy?.revision < target.committed.revision) throw Error("Policy saved; current catalogue has not observed its revision yet.");
      clearChoice();
      return true;
    } catch (error) {
      if (task === target && !disposed) { state.error = error.message; state.needsReview = true; state.status = "committed"; }
      return false;
    }
  }
  function validPreparation(target) {
    return current(target) && writable() && sameBase(target.base, policy()) &&
      (target.intent.type === "auto-enable" || getCatalog()?.plugins.some(plugin => plugin.id === target.intent.id));
  }
  async function execute(target) {
    state.preparing = true; state.pending = true; state.status = "preparing"; state.error = "";
    try {
      if (!validPreparation(target)) throw Error("Policy or session changed before inventory preparation; no request was sent.");
      if (target.intent.type === "enabled" && !target.intent.value) {
        const prepared = await prepareDisable(target.intent.id, copy(target.base));
        if (!prepared) throw Error("Plugin preparation did not finish; no policy request was sent. Your choice is retained.");
        if (!validPreparation(target)) throw Error("Policy or session changed during preparation; no request was sent.");
      }
      state.preparing = false; state.status = "saving"; state.inFlight = true;
      const operation = Promise.resolve().then(() => {
        if (!validPreparation(target)) throw Object.assign(Error("Inventory admission retired before dispatch; no request was sent."), { inventoryUnsent: true });
        target.sent = true;
        return target.intent.type === "enabled" ? writeEnabled(target.intent.id, target.intent.value, copy(target.base)) : writePolicy(target.intent.value, copy(target.base));
      });
      wire = operation;
      let ended = false, late = false;
      operation.then(result => {
        ended = true; target.wireResult = result;
        if (late && task === target && !disposed) {
          recordAcknowledgement(target, result);
          finishCommitted(target).catch(() => {});
        }
      }, () => { ended = true; target.wireRejected = true; }).finally(() => { if (wire === operation) { wire = null; state.inFlight = false; } }).catch(error => {
        if (late && task === target && !disposed) retainFailure(target, error, true);
      });
      try {
        const result = await observe(operation, "Inventory outcome is unknown. The original policy wire remains pending; review after it settles.");
        if (task !== target || disposed) return false;
        recordAcknowledgement(target, result);
        return await finishCommitted(target);
      } catch (error) {
        const knownUnsent = !target.sent || error.inventoryUnsent || rejectedCodes.has(error.response?.data?.code);
        retainFailure(target, error, !knownUnsent);
        late = !ended;
        if (ended && target.wireResult && !target.wireRejected && task === target && !disposed && !state.committed) {
          try { recordAcknowledgement(target, target.wireResult); finishCommitted(target).catch(() => {}); }
          catch { /* The malformed response remains unknown and requires review. */ }
        }
        return false;
      }
    } catch (error) {
      retainFailure(target, error, false); return false;
    } finally { state.preparing = false; }
  }
  function admit(intent, expected = policy()) {
    if (disposed || !writable() || hasWork() || !Number.isSafeInteger(expected?.revision) || typeof expected.signature !== "string") return Promise.resolve(false);
    if (intent.type === "auto-enable" && policy()?.autoEnableSource === "environment") return Promise.resolve(false);
    if (typeof intent.value !== "boolean") return Promise.resolve(false);
    const captured = { intent: copy(intent), base: copy({ revision: expected.revision, signature: expected.signature }),
      key: getSession(), owner: captureOwner(), version: ++state.version, sent: false, committed: null };
    if (!captured.owner.current()) return Promise.resolve(false);
    task = captured; state.intent = copy(intent); state.unknown = false; state.needsReview = false; state.reviewed = false; state.committed = false;
    const pending = execute(captured).finally(() => { if (request === pending) { request = null; state.pending = false; } });
    request = pending;
    return pending;
  }
  async function review() {
    if (!task || busy() || disposed) return false;
    const target = task, ticket = ++reviewTicket; state.reviewing = true;
    try {
      const receipt = await observe(Promise.resolve().then(() => refreshCatalog()), "Current inventory could not be read; your choice is retained.");
      if (disposed || task !== target || ticket !== reviewTicket || target.key !== getSession() || receipt?.status !== "accepted") return false;
      const fresh = receipt.catalog?.policy;
      if (!fresh) throw Error("Accepted catalogue contains no current policy.");
      state.reviewed = true;
      if (state.committed) {
        if (fresh.revision < target.committed.revision) throw Error("The accepted read has not observed the committed policy yet.");
        clearChoice(); return true;
      }
      state.needsReview = !sameBase(target.base, fresh);
      state.status = state.needsReview ? "base-retired" : "reviewed";
      state.error = state.needsReview ? "The original policy base retired. Equal policy does not identify whose request committed or prove readiness. Explicitly resolve the local choice before a new operation." : "Current policy reviewed. No write was sent; an explicit same-base retry or discard is available.";
      return true;
    } catch (error) { if (task === target && !disposed) state.error = error.message; return false; }
    finally { state.reviewing = false; }
  }
  async function retry() {
    if (!snapshot().canRetry) return false;
    const target = task;
    state.reviewed = false; state.needsReview = false; state.unknown = false;
    const pending = execute(target).finally(() => { if (request === pending) { request = null; state.pending = false; } });
    request = pending; return pending;
  }
  function discard() {
    if (!snapshot().canDiscard) return false;
    clearChoice(); return true;
  }
  async function settle() {
    const failure = failureVersion;
    try {
      if (request) {
        const outcome = await observe(request, "Inventory did not settle before this handoff. Your policy choice remains retained.");
        if (outcome !== true || failure !== failureVersion) return false;
      }
      if (wire) await observe(wire.catch(() => null), "The original inventory wire is unresolved; this handoff was aborted.");
    } catch { return false; }
    return !disposed && failure === failureVersion && !busy() && (!state.unknown || state.reviewed) && !state.needsReview;
  }
  async function resolveDeparture(reason, decision) {
    if (!await settle()) return false;
    if (!hasWork()) return true;
    const choice = decision ?? await confirm({ reason, pages: [{ page: { label: snapshot().label }, canSave: snapshot().canRetry }], canSave: snapshot().canRetry });
    if (choice === "discard") return discard();
    if (choice === "save" || choice === "retry") return await retry() && !hasWork();
    return false;
  }
  return { snapshot, hasWork, settle, review, retry, discard, resolveDeparture,
    setEnabled: (id, value, expected) => admit({ type: "enabled", id, value }, expected),
    setAutoEnable: (value, expected) => admit({ type: "auto-enable", value }, expected),
    dispose() { disposed = true; reviewTicket++; } };
}
