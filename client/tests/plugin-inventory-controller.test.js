import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginInventoryController } from "../pluginInventoryController.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const initial = () => ({ policy: { revision: 0, signature: "base", effectiveAutoEnable: true }, plugins: [{ id: "p", enabled: true }] });
let controller;
afterEach(() => { controller?.dispose(); controller = null; vi.useRealTimers(); });
function fixture(overrides = {}) {
  let catalog = initial(), session = "A", canWrite = true;
  const adapters = {
    getCatalog: () => catalog, getSession: () => session, writable: () => canWrite,
    captureOwner: () => { const key = session; return { current: () => key === session }; }, acknowledge: vi.fn(),
    writeEnabled: vi.fn(async (id, value, base) => {
      catalog = { ...catalog, policy: { ...catalog.policy, revision: base.revision + 1, signature: "acknowledged" }, plugins: catalog.plugins.map(plugin => plugin.id === id ? { ...plugin, enabled: value } : plugin) };
      return { policy: catalog.policy };
    }), writePolicy: vi.fn(), refreshCatalog: vi.fn(async () => ({ status: "accepted", catalog })),
    prepareDisable: vi.fn(async () => true), timeout: 100, ...overrides,
  };
  controller = createPluginInventoryController(adapters);
  return { controller, adapters, setCatalog: value => { catalog = value; }, setSession: value => { session = value; }, setWritable: value => { canWrite = value; } };
}

describe("review repairs: R13 retained inventory operation ownership", () => {
  it("reserves enablement and auto-enable before any captured-plugin preparation await", async () => {
    const prepare = deferred(), { controller: c, adapters } = fixture({ prepareDisable: vi.fn(() => prepare.promise) });
    const disabling = c.setEnabled("p", false); await flush();
    expect(c.snapshot()).toMatchObject({ preparing: true, intent: { type: "enabled", id: "p", value: false }, hasWork: true });
    expect(await c.setAutoEnable(false)).toBe(false); expect(await c.setEnabled("p", true)).toBe(false);
    expect(adapters.writeEnabled).not.toHaveBeenCalled(); expect(adapters.writePolicy).not.toHaveBeenCalled();
    prepare.resolve(true); expect(await disabling).toBe(true);
    expect(adapters.writeEnabled).toHaveBeenCalledWith("p", false, { revision: 0, signature: "base" });
    expect(c.hasWork()).toBe(false);
  });

  it.each(["policy", "session", "writability"])("rechecks captured %s after disable preparation instead of borrowing a new base", async change => {
    const prepare = deferred(), f = fixture({ prepareDisable: vi.fn(() => prepare.promise) });
    const disabling = f.controller.setEnabled("p", false); await flush();
    if (change === "policy") f.setCatalog({ ...initial(), policy: { revision: 1, signature: "newer", effectiveAutoEnable: true } });
    if (change === "session") f.setSession("B"); if (change === "writability") f.setWritable(false);
    prepare.resolve(true); expect(await disabling).toBe(false); expect(f.adapters.writeEnabled).not.toHaveBeenCalled();
    expect(f.controller.snapshot().intent).toEqual({ type: "enabled", id: "p", value: false });
  });

  it("observation timeout retains the original wire and late success never resumes the aborted handoff", async () => {
    vi.useFakeTimers(); const wire = deferred(), f = fixture({ writeEnabled: vi.fn(() => wire.promise) });
    const saving = f.controller.setEnabled("p", true); await flush();
    const leaving = f.controller.resolveDeparture("Logout");
    await vi.advanceTimersByTimeAsync(101);
    expect(await saving).toBe(false); expect(await leaving).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ unknown: true, inFlight: true, hasWork: true });
    expect(f.controller.discard()).toBe(false); expect(await f.controller.retry()).toBe(false);
    const committed = { ...initial(), policy: { revision: 1, signature: "late", effectiveAutoEnable: true } };
    f.setCatalog(committed); wire.resolve({ policy: committed.policy }); await flush();
    expect(f.adapters.writeEnabled).toHaveBeenCalledTimes(1); expect(f.controller.hasWork()).toBe(false);
  });

  it("bare post-persistence 503 is unknown and equal read-back policy does not identify this request or prove readiness", async () => {
    const f = fixture({ writeEnabled: vi.fn().mockRejectedValue({ response: { status: 503, data: { detail: "source replacement failed after persistence" } } }) });
    expect(await f.controller.setEnabled("p", true)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ unknown: true, needsReview: true });
    const committedElsewhere = { ...initial(), policy: { revision: 1, signature: "another writer", effectiveAutoEnable: true } };
    f.setCatalog(committedElsewhere); expect(await f.controller.review()).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ unknown: true, committed: false, needsReview: true, canRetry: false, canDiscard: true });
    expect(await f.controller.retry()).toBe(false); expect(f.adapters.writeEnabled).toHaveBeenCalledTimes(1);
    expect(f.controller.discard()).toBe(true);
    f.adapters.writeEnabled.mockResolvedValue({ policy: { revision: 2, signature: "fresh explicit enable" } });
    f.adapters.refreshCatalog.mockResolvedValue({ status: "accepted", catalog: { ...committedElsewhere, policy: { revision: 2, signature: "fresh explicit enable" } } });
    expect(await f.controller.setEnabled("p", true)).toBe(true);
    expect(f.adapters.writeEnabled.mock.calls[1]).toEqual(["p", true, { revision: 1, signature: "another writer" }]);
  });

  it("successful PUT is committed before a failed catalogue refresh and cannot be replayed", async () => {
    const f = fixture({ refreshCatalog: vi.fn().mockResolvedValue({ status: "error", detail: "read failed" }) });
    expect(await f.controller.setEnabled("p", false)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ committed: true, unknown: false, hasWork: true, canRetry: false });
    expect(await f.controller.retry()).toBe(false); expect(f.adapters.writeEnabled).toHaveBeenCalledTimes(1);
    f.adapters.refreshCatalog.mockResolvedValue({ status: "accepted", catalog: { ...initial(), policy: { revision: 1, signature: "acknowledged" } } });
    expect(await f.controller.review()).toBe(true); expect(f.controller.hasWork()).toBe(false);
  });

  it("an explicit reviewed same-base retry uses the original CAS without auto-rebase", async () => {
    const f = fixture({ writeEnabled: vi.fn().mockRejectedValueOnce({ response: { status: 409, data: { code: "plugin_policy_conflict", detail: "CAS rejected before replacement" } } }) });
    expect(await f.controller.setEnabled("p", false)).toBe(false); expect(f.controller.snapshot().unknown).toBe(false);
    expect(await f.controller.retry()).toBe(false); expect(await f.controller.review()).toBe(true);
    f.adapters.writeEnabled.mockResolvedValue({ policy: { revision: 1, signature: "retry ack" } });
    f.adapters.refreshCatalog.mockResolvedValue({ status: "accepted", catalog: { ...initial(), policy: { revision: 1, signature: "retry ack" } } });
    expect(await f.controller.retry()).toBe(true);
    expect(f.adapters.writeEnabled.mock.calls.map(call => call[2])).toEqual([{ revision: 0, signature: "base" }, { revision: 0, signature: "base" }]);
  });
});
