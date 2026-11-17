import { describe, expect, it, vi } from "vitest";
import { BACKUP_CONTROL_FAILURES, backupControlReason, recordBackupNegative, requireBackupNegative } from "./helpers/backup-controls.js";

function aliasFailure() {
  const error = Object.assign(new Error("BACKUP_NATIVE_aliases: plugin 'globnotes-backup' work failed: observed catalogue"), {
    workBaseline: { generation: "owner", deliveryFailures: 0, lanes: { ordinary: { admitted: 1, failures: 0 }, versioning: { admitted: 0, failures: 0 } } },
  });
  const diagnostics = {
    catalog: { status: "ready", deliveryFailures: 1, work: { generation: "owner", ordinary: { failures: 0, pending: 0 }, versioning: {
      admitted: 2, settled: 2, pending: 0, failures: 1, lastFailure: { sequence: 2, code: "plugin_work_failed" },
    } } },
    status: { status: 200, body: { failed: 1, completed: 1, pendingJobs: 0, lastError: { code: "backup_alien_slot" }, configuration: { basePath: "." } } },
    settings: { body: { values: { basePath: "." } } }, live: "C", firstSlot: "A",
  };
  return { error, diagnostics };
}

describe("backup mutation outcome ownership", () => {
  it("accepts every other control only for its own intended consumer assertion", () => {
    for (const [kind, reason] of Object.entries(BACKUP_CONTROL_FAILURES)) {
      if (["aliases", "retarget"].includes(kind)) continue;
      expect(backupControlReason(kind, new Error(reason), null)).toBe(reason);
      expect(backupControlReason(kind, new Error(`BACKUP_NATIVE_${kind}: plugin work failed`), null)).toBeNull();
      expect(backupControlReason(kind, new Error("unrelated browser/transport failure"), null)).toBeNull();
    }
  });
  it("proves alias family ownership failure from post-baseline counts and private/physical outcomes", () => {
    const { error, diagnostics } = aliasFailure();
    expect(backupControlReason("aliases", error, diagnostics)).toBe(BACKUP_CONTROL_FAILURES.aliases);
    const stale = structuredClone(diagnostics); error.workBaseline.lanes.versioning.failures = 1;
    expect(backupControlReason("aliases", error, stale)).toBeNull();
    error.workBaseline.lanes.versioning.failures = 0;
    for (const change of [
      data => data.catalog.work.generation = "replacement",
      data => data.catalog.work.versioning.lastFailure.code = "plugin_work_deadline",
      data => data.status.body.lastError.code = "fs_denied",
      data => data.firstSlot = "unrelated bytes",
      data => data.catalog.work.ordinary.failures = 1,
    ]) { const data = structuredClone(diagnostics); change(data); expect(backupControlReason("aliases", error, data)).toBeNull(); }
    error.workBaseline.lanes.versioning.admitted = 2;
    expect(backupControlReason("aliases", error, diagnostics)).toBeNull();
  });
  it("writes the original outcome even when diagnostics and cleanup fail, attempting every owner", async () => {
    const error = new Error(BACKUP_CONTROL_FAILURES.count), write = vi.fn(), server = vi.fn();
    const record = await recordBackupNegative({ kind: "count", error,
      diagnostics: () => { throw Error("diagnostic read failed"); },
      cleanup: [() => { throw Error("browser close failed"); }, server], write });
    expect(record.detail).toBe(error.message); expect(record.observed).toBe(false);
    expect(record.failures.map(item => item.stage)).toEqual(["diagnostics", "cleanup-0"]);
    expect(record.ownedResourcesClosedAfterCustody).toBe(false);
    expect(server).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledExactlyOnceWith(record);
  });
  it("accepts retarget only after a successful first publication and the observed retarget barrier", () => {
    const { error, diagnostics } = aliasFailure();
    error.message = "BACKUP_NATIVE_retarget: plugin 'globnotes-backup' work failed: observed catalogue";
    diagnostics.vault = "/owned/vault";
    diagnostics.status.body.lastError.code = "backup_owned_slot_conflict";
    diagnostics.status.body.pendingRecovery = true;
    diagnostics.status.body.configuration.basePath = diagnostics.settings.body.values.basePath = "/owned/vault/alias";
    diagnostics.retarget = { aliasTarget: "/owned/vault/second", firstSlot: "A", secondSlot: null, ready: true, released: true };
    expect(backupControlReason("retarget", error, diagnostics)).toBe(BACKUP_CONTROL_FAILURES.retarget);
    for (const change of [
      data => data.retarget.ready = false,
      data => data.retarget.released = false,
      data => data.retarget.aliasTarget = "/owned/vault/first",
      data => data.catalog.work.versioning.admitted = 1,
      data => data.status.body.completed = 0,
      data => data.retarget.firstSlot = null,
      data => data.retarget.secondSlot = "B",
      data => data.status.body.lastError.code = "backup_alien_slot",
    ]) { const data = structuredClone(diagnostics); change(data); expect(backupControlReason("retarget", error, data)).toBeNull(); }
  });
  it("records a valid negative with exactly one raw diagnostics read, then cleanup", async () => {
    const { error, diagnostics } = aliasFailure(), order = [], write = vi.fn();
    const read = vi.fn(() => { order.push("read"); return diagnostics; });
    const record = await recordBackupNegative({ kind: "aliases", error, diagnostics: read,
      cleanup: [() => order.push("browser"), () => order.push("server")], write });
    expect(order).toEqual(["read", "browser", "server"]); expect(read).toHaveBeenCalledOnce();
    expect(record.observed).toBe(true); expect(record.reason).toBe(BACKUP_CONTROL_FAILURES.aliases);
    expect(record.baseline).toEqual(error.workBaseline); expect(write).toHaveBeenCalledOnce();
  });
  it("records unexpected failures and page exceptions as failed controls rather than accepting their names", async () => {
    for (const [error, pageErrors] of [[new Error("BACKUP_NATIVE_count: plugin work failed"), []], [new Error(BACKUP_CONTROL_FAILURES.count), ["page exception"]]]) {
      const write = vi.fn();
      const record = await recordBackupNegative({ kind: "count", error, pageErrors, diagnostics: () => ({}), cleanup: [vi.fn()], write });
      expect(record.observed).toBe(false); expect(record.detail).toBe(error.message); expect(write).toHaveBeenCalledOnce();
    }
  });
  it("retains the original case cause when the record itself cannot be written", async () => {
    const primary = new Error("original consumer failure"), disk = new Error("disk write failed"), close = vi.fn();
    const error = await recordBackupNegative({ kind: "count", error: primary, diagnostics: () => ({}), cleanup: [close], write: () => { throw disk; } }).catch(error => error);
    expect(error.message).toContain(primary.message); expect(error.cause).toBe(disk); expect(close).toHaveBeenCalledOnce();
  });
  it("reports a missing record as that control's failure with its child cause", async () => {
    const missing = new Error("missing record"), stderr = new TextEncoder().encode("original child assertion");
    const error = await requireBackupNegative("aliases", { code: 1, stderr, timedOut: false }, () => { throw missing; }).catch(error => error);
    expect(error.message).toContain("BACKUP_NATIVE_aliases"); expect(error.message).toContain("original child assertion"); expect(error.cause).toBe(missing);
  });
  it("the parent validates the intended reason instead of trusting observed:true", async () => {
    const { error, diagnostics } = aliasFailure();
    const record = await recordBackupNegative({ kind: "aliases", error, diagnostics: () => diagnostics, write: () => {} });
    const result = { code: 1, stderr: new TextEncoder().encode(error.message), timedOut: false };
    expect(await requireBackupNegative("aliases", result, () => record)).toBe(record);
    await expect(requireBackupNegative("aliases", result, () => ({ ...record, reason: "unrelated" }))).rejects.toThrow("did not prove its intended failure");
    await expect(requireBackupNegative("aliases", { ...result, code: 0 }, () => record)).rejects.toThrow("did not prove its intended failure");
    await expect(requireBackupNegative("aliases", { ...result, timedOut: true }, () => record)).rejects.toThrow("did not prove its intended failure");
    await expect(requireBackupNegative("aliases", result, () => null)).rejects.toThrow("BACKUP_NATIVE_aliases");
  });
});
