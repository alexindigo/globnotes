// SPDX-License-Identifier: LGPL-3.0-only
// Pure per-edit-session FIFO. Transport and every application effect are injected.
export const NOTE_SAVE_OBSERVATION_MS = 60_000;

export function classifyNoteSaveFailure(error, phase) {
  if (phase === "preparing") return error?.cancelled ? "cancelled-unsent" : "known-unsent";
  const response = error?.response;
  const code = response?.data?.code;
  if (["plugin_cancelled", "plugin_guard_failed", "operation_conflict"].includes(code)) return "known-no-write";
  const detail = response?.data?.detail;
  // These exact producers were inspected: middleware and operation admission,
  // before any storage effect. Bare status codes convey no such certainty.
  if ((response?.status === 401 && detail === "Invalid authentication credentials") ||
      (response?.status === 403 && detail === "read-only mode") ||
      (response?.status === 503 && detail === "setup_required")) return "known-no-write";
  return "unknown";
}

function immutable(value) {
  const clone = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  }
  return freeze(clone);
}

export function createNoteSaveQueue(adapters) {
  const now = adapters.now ?? Date.now;
  const setTimer = adapters.setTimer ?? setTimeout;
  const clearTimer = adapters.clearTimer ?? clearTimeout;
  const sessionId = adapters.sessionId;
  let serial = 0, generation = 0, failureSerial = 0;
  let status = "idle", active = null, failure = null, disposed = false, rebaseConflict = false;
  let acknowledged = adapters.initial ? immutable(adapters.initial) : null;
  let acknowledgedPathRevision = -1;
  const queued = [];
  const jobs = new Set();
  const waiters = new Set();
  let pumping = false;

  function state() {
    const describe = job => job && Object.freeze({ submissionId: job.snapshot.submissionId, snapshot: job.snapshot, phase: job.phase, outcome: job.outcome, inFlight: job.inFlight });
    return Object.freeze({ sessionId, status, disposed, rebaseConflict, active: describe(active), queued: Object.freeze(queued.map(describe)), jobs: Object.freeze([...jobs].map(describe)), acknowledged, acknowledgedPathRevision, failure: failure && Object.freeze({ ...failure }),
      unresolved: !!active || queued.length > 0 || !!failure || rebaseConflict,
      inFlight: !!active?.inFlight,
      canDiscard: !active?.inFlight && (!failure || failure.certainty !== "unknown"),
    });
  }
  function observationResult() {
    if (disposed) return { status: "disposed", safe: false };
    if (status === "paused") return { status: "paused", certainty: failure?.certainty, safe: false, canDiscard: state().canDiscard };
    if (rebaseConflict && !active) return { status: "blocked", safe: false, canDiscard: state().canDiscard };
    if (!active && !queued.length && status === "idle") return { status: "settled", safe: true };
    return null;
  }
  function notify() {
    adapters.changed?.(state());
    const result = observationResult();
    if (result) for (const waiter of [...waiters]) waiter.finish(result);
  }
  function finishReceipt(job, result) {
    if (job.receiptSettled) return;
    job.receiptSettled = true;
    job.resolve(Object.freeze(result));
  }
  function pause(job, error, certainty, phase) {
    status = "paused";
    failureSerial++;
    failure = { submissionId: job.snapshot.submissionId, certainty, phase, message: error?.message ?? String(error), serial: failureSerial };
    job.outcome = Object.freeze({ status: "failed", certainty, phase });
    finishReceipt(job, job.outcome);
    notify();
    adapters.failed?.(error, job.snapshot, failure);
  }
  async function observe(job, phase, operation) {
    let timer;
    timer = setTimer(() => {
      if (disposed || job !== active || job.token !== generation) return;
      job.timedOut = true;
      pause(job, new Error("Save observation deadline exceeded; work is retained."), phase === "sending" ? "unknown" : "known-unsent", phase);
    }, adapters.observationMs ?? NOTE_SAVE_OBSERVATION_MS);
    job.observationTimer = timer;
    try { return await operation(); }
    finally { clearTimer(timer); job.observationTimer = null; }
  }
  function validAck(result) {
    if (!result || typeof result.path !== "string" || !result.path || typeof result.content !== "string") throw new Error("Malformed Save acknowledgement; write outcome is unknown.");
    return immutable(result);
  }
  function blockRebase() {
    if (rebaseConflict) return;
    rebaseConflict = true;
    if (!active) status = "idle";
    notify();
    adapters.failed?.(Object.assign(new Error("Rename changed the saved text while newer edits or queued saves exist. Autosave is stopped; your text and queued saves are retained. Review the attachment references, then press Save explicitly to write your text as-is, or choose Discard to keep the renamed saved text."), { code: "rename_rebase_conflict" }));
  }
  async function pump() {
    if (pumping || disposed || status === "paused" || rebaseConflict) return;
    pumping = true;
    const pumpGeneration = generation;
    let drainedJob = null;
    try {
      while (!disposed && status !== "paused" && !rebaseConflict && queued.length) {
        const job = queued.shift(); active = job; job.token = generation;
        const snapshot = job.snapshot;
        const context = Object.freeze({ acknowledged, sourcePath: acknowledged?.path ?? null,
          targetPath: acknowledged && (snapshot.intent === "save" || snapshot.pathRevision <= acknowledgedPathRevision) ? acknowledged.path : snapshot.requestedPath,
          isPreparationCurrent: () => !disposed && active === job && job.token === generation && !job.timedOut && job.phase === "preparing" && status === "preparing" });
        job.phase = "preparing"; status = "preparing"; notify();
        let prepared;
        try {
          prepared = await observe(job, "preparing", () => adapters.prepare?.(snapshot, context) ?? { fileRefs: "none" });
        } catch (error) {
          if (context.isPreparationCurrent()) pause(job, error, classifyNoteSaveFailure(error, "preparing"), "preparing");
          break;
        }
        if (!context.isPreparationCurrent()) break;
        job.phase = "sending"; job.inFlight = true; status = "sending"; notify();
        let result;
        try {
          result = validAck(await observe(job, "sending", () => adapters.send(snapshot, context, prepared)));
        } catch (error) {
          job.inFlight = false;
          if (!disposed && job.token === generation) pause(job, error, classifyNoteSaveFailure(error, "sending"), "sending");
          break;
        }
        job.inFlight = false;
        if (disposed || job.token !== generation) break;
        // Known server success is recorded before applying fallible UI effects.
        acknowledged = result;
        acknowledgedPathRevision = snapshot.pathRevision;
        const holdQueued = context.sourcePath && context.sourcePath !== result.path && snapshot.content !== result.content && queued.length > 0;
        job.phase = "acknowledging";
        const late = job.timedOut;
        try {
          const integration = await adapters.acknowledge?.(snapshot, result, { ...context, late });
          if (holdQueued || integration?.rebaseConflict) blockRebase();
        }
        catch (error) { pause(job, error, "known-committed", "acknowledging"); break; }
        if (disposed || job.token !== generation) break;
        job.phase = "acknowledged";
        job.outcome = Object.freeze({ status: "acknowledged", result, late });
        finishReceipt(job, job.outcome);
        if (late) {
          // Never resume B or a transition aborted by the observation deadline.
          if (!queued.length && adapters.canResolveLate?.(snapshot, result) === true) {
            active = null; failure = null; status = "idle";
            jobs.delete(job);
          } else {
            failure = { ...failure, certainty: "known-committed" };
            status = "paused";
          }
          notify(); break;
        }
        active = null; drainedJob = job;
        if (rebaseConflict) { status = "idle"; notify(); }
        if (queued.length || rebaseConflict) { jobs.delete(job); drainedJob = null; }
      }
      if (!disposed && status !== "paused" && !active && !queued.length) { status = "idle"; notify(); }
    } finally {
      if (pumpGeneration === generation) pumping = false;
      if (!disposed && pumpGeneration === generation && status === "idle" && drainedJob) {
        const ownerGeneration = generation;
        Promise.resolve().then(async () => {
          if (!disposed && ownerGeneration === generation && status === "idle") return adapters.drained?.(drainedJob.snapshot, state());
        }).then(() => {
          jobs.delete(drainedJob);
          if (!disposed && ownerGeneration === generation) notify();
        })
          .catch(error => { if (!disposed && ownerGeneration === generation) pause(drainedJob, error, "known-committed", "integration"); });
      }
    }
  }
  return {
    submit(values) {
      if (disposed) throw new Error("Save owner disposed");
      const snapshot = immutable({ ...values, sessionId, submissionId: ++serial });
      if (typeof snapshot.content !== "string" || typeof snapshot.requestedPath !== "string" || !Number.isSafeInteger(snapshot.pathRevision)) throw new Error("Invalid Save snapshot");
      let resolve;
      const completion = new Promise(yes => { resolve = yes; });
      const job = { snapshot, resolve, phase: "queued", outcome: null, inFlight: false, token: generation };
      jobs.add(job); queued.push(job);
      const receipt = Object.freeze({ sessionId, submissionId: snapshot.submissionId, completion, held: status === "paused" || rebaseConflict });
      notify(); pump();
      return receipt;
    },
    state,
    // Explicit Save is the user's decision to keep conflicting text as-is. It
    // releases only this reconciliation barrier, never a failed/uncertain write.
    acceptRebaseConflict() {
      if (!rebaseConflict || status === "paused") return;
      rebaseConflict = false;
      notify(); pump();
    },
    awaitSettled({ deadline = now() + NOTE_SAVE_OBSERVATION_MS } = {}) {
      const immediate = observationResult();
      if (immediate) return Promise.resolve(immediate);
      return new Promise(resolve => {
        const waiter = { finish(result) { clearTimer(timer); waiters.delete(waiter); resolve(result); } };
        const timer = setTimer(() => waiter.finish({ status: "timeout", safe: false }), Math.max(0, deadline - now()));
        waiters.add(waiter);
      });
    },
    // Explicit, disclosed Discard is a separate permission, never disposal.
    discard() {
      if (!state().canDiscard) return false;
      generation++;
      for (const job of [active, ...queued].filter(Boolean)) { clearTimer(job.observationTimer); finishReceipt(job, { status: "discarded", safe: true }); }
      pumping = false;
      active = null; queued.length = 0; jobs.clear(); failure = null; rebaseConflict = false; status = "idle"; notify();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++;
      for (const job of jobs) { clearTimer(job.observationTimer); finishReceipt(job, { status: "disposed", safe: false }); }
      for (const waiter of [...waiters]) waiter.finish({ status: "disposed", safe: false });
    },
  };
}
