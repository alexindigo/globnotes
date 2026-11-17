import { finalizeNativeCase } from "../e2e/native-case-finalization.mjs";

const slotFailure = kind => `BACKUP_NATIVE_${kind}: exact ordered owned physical slots`;
export const BACKUP_CONTROL_FAILURES = {
  count: slotFailure("count"), order: slotFailure("order"), location: slotFailure("location"),
  preimage: slotFailure("preimage"), pin: slotFailure("pin"), distinct: slotFailure("distinct"),
  recovery: "BACKUP_NATIVE_recovery: ring-committed cleanup completed without duplicate capture",
  cleanup: "BACKUP_NATIVE_cleanup: active journal and every recorded stage physically removed",
  aliases: "BACKUP_NATIVE_aliases: canonical alias lost existing family ownership (backup_alien_slot)",
  retarget: "BACKUP_NATIVE_retarget: publication re-resolved retargeted alias instead of pinned root (backup_owned_slot_conflict)",
};

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
  if (!error.message.startsWith(`BACKUP_NATIVE_${kind}: plugin 'globnotes-backup' work failed:`) ||
      !before || !after || after.generation !== before.generation ||
      before.lanes?.versioning?.failures !== 0 || !(before.lanes.versioning.admitted < 2) || after.versioning?.failures !== 1 ||
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
  if (result.timedOut || result.code === 0 || !stderr.includes(`BACKUP_NATIVE_${kind}`) ||
      record?.namedConsumer !== `BACKUP_NATIVE_${kind}` || !record.observed || !record.ownedResourcesClosedAfterCustody ||
      record.reason !== backupControlReason(kind, { message: record.detail, workBaseline: record.baseline }, record.diagnostics)) {
    throw new Error(`BACKUP_NATIVE_${kind}: mutation control did not prove its intended failure: ${JSON.stringify(record)}`);
  }
  return record;
}
