import { finalizeNativeCase } from "../e2e/native-case-finalization.mjs";
import { captureSettledWork, catalogPluginReady, catalogWorkSettled } from "../../../tests/helpers/catalog_work.ts";

const slotFailure = kind => `BACKUP_NATIVE_${kind}: exact ordered owned physical slots`;
export const BACKUP_CONTROL_FAILURES = {
  count: slotFailure("count"), order: slotFailure("order"), location: slotFailure("location"),
  preimage: slotFailure("preimage"), pin: slotFailure("pin"), distinct: slotFailure("distinct"),
  recovery: "BACKUP_NATIVE_recovery: ring-committed cleanup completed without duplicate capture",
  cleanup: "BACKUP_NATIVE_cleanup: active journal and every recorded stage physically removed",
  aliases: "BACKUP_NATIVE_aliases: canonical alias lost existing family ownership (backup_alien_slot)",
  retarget: "BACKUP_NATIVE_retarget: publication re-resolved retargeted alias instead of pinned root (backup_owned_slot_conflict)",
};

const id = "globnotes-backup", lanes = ["ordinary", "versioning"];
const captureFailures = {
  recovery: { sequence: 1, code: "native_recorded_interruption" },
  cleanup: { sequence: 1, code: "native_recorded_interruption" },
  failure: { sequence: 1, code: "backup_alien_slot" },
};
const captureMutations = {
  aliases: { sequence: 2, code: "backup_alien_slot", negative: true },
  retarget: { sequence: 2, code: "backup_owned_slot_conflict", negative: true },
};

/** The backup fixture never samples failure counters at readiness or ACK.
 * Declare the only allowed outcome before waiting on a fixed owner fence;
 * advance the baseline only from that settled catalogue and checked status. */
export async function openBackupWork(server, { kind, negative, restarted, readStatus }) {
  const ready = await catalogPluginReady(server, id);
  let baseline = null, privateFailures = 0;
  const check = (condition, message) => {
    if (!condition) throw Error(`BACKUP_NATIVE_${kind}: ${message}`);
  };
  async function settle({ startup = false, capture = false, during } = {}) {
    const before = baseline;
    const expected = before ? structuredClone(before) : {
      generation: ready.work.generation, deliveryFailures: 0,
      lanes: { ordinary: { admitted: 1, failures: 0 }, versioning: { admitted: 0, failures: 0 } },
    };
    const recoveredWithConflict = startup && restarted && negative && kind === "recovery";
    if (recoveredWithConflict) expected.lanes.ordinary.failures++;
    if (capture) expected.lanes.versioning.admitted++;
    const rule = captureFailures[kind] ?? (negative ? captureMutations[kind] : null);
    const captureFailure = capture && rule?.sequence === expected.lanes.versioning.admitted ? rule : null;
    if (captureFailure) {
      expected.lanes.versioning.failures++;
      expected.deliveryFailures++;
    }

    const abort = during ? new AbortController() : null;
    const settling = catalogWorkSettled(server, id, { lanes, baseline: expected, signal: abort?.signal });
    let entry;
    try {
      if (during) await during({ label: "captured backup invocation", exit: settling.then(() => ({ code: 0 }), () => ({ code: 1 })) });
      entry = await settling;
    } finally {
      if (abort) { abort.abort(); await settling.catch(() => undefined); }
    }
    const next = captureSettledWork(entry, lanes);
    check(entry.status === "ready" && next.lanes.versioning.admitted === expected.lanes.versioning.admitted,
      `expected ${expected.lanes.versioning.admitted} admitted captures in a ready owner; actual=${JSON.stringify(next)}`);
    if (startup) {
      const job = recoveredWithConflict
        ? { id: "backup-recovery", state: "failed", code: "plugin_job_failed" }
        : { id: "backup-recovery", state: "succeeded" };
      check(next.lanes.ordinary.admitted === 1 && JSON.stringify(entry.jobs) === JSON.stringify([job]),
        `expected only the named startup recovery job; actual=${JSON.stringify(entry.jobs)}`);
    }
    const failedLane = recoveredWithConflict ? "ordinary" : captureFailure ? "versioning" : null;
    if (failedLane) {
      const failure = entry.work[failedLane].lastFailure;
      check(failure?.sequence === expected.lanes[failedLane].admitted && failure.code === "plugin_work_failed",
        `expected the admitted ${failedLane} callback rejection; actual=${JSON.stringify(failure)}`);
    }

    const status = await readStatus();
    check(status.status === 200 && status.body?.pendingJobs === 0, `expected settled private backup status; actual=${JSON.stringify(status)}`);
    const code = recoveredWithConflict ? "backup_family_conflict" : captureFailure?.code;
    const failed = privateFailures + (code ? 1 : 0);
    check(status.body.failed === failed && (!code || JSON.stringify(status.body.lastError) === JSON.stringify({ code })),
      `expected ${failed} private failures${code ? ` (${code})` : ""}; actual=${JSON.stringify(status.body)}`);
    baseline = next;
    privateFailures = failed;
    if (captureFailure?.negative) {
      // The physical/settings consumer proof is still required by the parent.
      throw Object.assign(Error(BACKUP_CONTROL_FAILURES[kind]), { workBaseline: before });
    }
    return status;
  }
  await settle({ startup: true });
  return { status: () => settle(), afterCapture: during => settle({ capture: true, during }) };
}

/** A named work error alone is not a successful mutation control. Match the
 * intended consumer failure, or independently prove the canonical-root defect. */
export function backupControlReason(kind, error, evidence) {
  const expected = BACKUP_CONTROL_FAILURES[kind];
  if (!expected || typeof error?.message !== "string") return null;
  if (!["aliases", "retarget"].includes(kind)) {
    return error.message === expected || error.message.startsWith(`${expected}; actual=`) ? expected : null;
  }
  const before = error.workBaseline, after = evidence?.catalog?.work;
  const status = evidence?.status?.body;
  if (error.message !== expected ||
      !before || !after || after.generation !== before.generation ||
      before.lanes?.versioning?.failures !== 0 || before.lanes.versioning.admitted !== 1 || after.versioning?.failures !== 1 ||
      after.versioning.admitted !== 2 || after.versioning.settled !== 2 || after.versioning.pending !== 0 ||
      after.versioning.lastFailure?.sequence !== 2 || after.versioning.lastFailure?.code !== "plugin_work_failed" ||
      after.ordinary?.failures !== before.lanes.ordinary?.failures || after.ordinary?.pending !== 0 ||
      evidence.catalog.deliveryFailures !== before.deliveryFailures + 1 || evidence.catalog.status !== "ready" ||
      evidence.status.status !== 200 || status?.failed !== 1 || status.completed !== 1 || status.pendingJobs !== 0 ||
      evidence.live !== "C") return null;
  if (kind === "aliases") {
    if (status.lastError?.code !== "backup_alien_slot" || status.configuration?.basePath !== "." ||
        evidence.settings?.body?.values?.basePath !== "." || evidence.firstSlot !== "A") return null;
  } else {
    if (status.lastError?.code !== "backup_owned_slot_conflict" || status.pendingRecovery !== true ||
        status.configuration?.basePath !== `${evidence.vault}/alias` || evidence.settings?.body?.values?.basePath !== `${evidence.vault}/alias` ||
        evidence.retarget?.aliasTarget !== `${evidence.vault}/second` || evidence.retarget.firstSlot !== "A" ||
        evidence.retarget.secondSlot !== null || evidence.retarget.ready !== true || evidence.retarget.released !== true) return null;
  }
  return expected;
}

/** Diagnostics are observations, not another readiness/settlement attempt.
 * Always record the original failure and every diagnostics/cleanup failure. */
export async function recordBackupNegative({ kind, error, pageErrors = [], diagnostics, cleanup = [], write }) {
  let evidence = null, reason = null;
  const failures = [], closed = [];
  const attempt = (stage, fn) => async () => {
    try { return await fn(); }
    catch (failure) { failures.push({ stage, detail: failure.message }); throw failure; }
  };
  let record;
  try {
    await finalizeNativeCase({ error,
      report: attempt("diagnostics", async () => { evidence = await diagnostics(); reason = backupControlReason(kind, error, evidence); }),
      cleanup: cleanup.map((close, index) => attempt(`cleanup-${index}`, async () => { await close(); closed.push(index); })),
    });
  } catch (failure) {
    if (!failures.length) failures.push({ stage: "finalization", detail: failure.message });
  } finally {
    record = {
      namedConsumer: `BACKUP_NATIVE_${kind}`, observed: reason !== null && failures.length === 0 && pageErrors.length === 0,
      reason, detail: error.message, baseline: error.workBaseline ?? null,
      diagnostics: evidence, failures, pageErrors,
      ownedResourcesClosedAfterCustody: closed.length === cleanup.length,
    };
    try { await write(record); }
    catch (failure) { throw new Error(`BACKUP_NATIVE_${kind}: negative record failed; original failure: ${error.message}`, { cause: failure }); }
  }
  return record;
}

export async function requireBackupNegative(kind, result, load) {
  const stderr = new TextDecoder().decode(result.stderr);
  let record;
  try { record = await load(); }
  catch (error) {
    throw new Error(`BACKUP_NATIVE_${kind}: negative consumer record missing or unreadable after child exit ${result.code}; child cause: ${stderr}`, { cause: error });
  }
  const reason = record && backupControlReason(kind, { message: record.detail, workBaseline: record.baseline }, record.diagnostics);
  if (result.timedOut || result.code === 0 || !stderr.includes(`BACKUP_NATIVE_${kind}`) ||
      record?.namedConsumer !== `BACKUP_NATIVE_${kind}` || !record.observed || !record.ownedResourcesClosedAfterCustody ||
      !reason || record.reason !== reason) {
    throw new Error(`BACKUP_NATIVE_${kind}: mutation control did not prove its intended failure: ${JSON.stringify(record)}`);
  }
  return record;
}
