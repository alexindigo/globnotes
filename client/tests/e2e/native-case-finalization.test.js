import { expect, it, vi } from "vitest";
import { rejects } from "node:assert/strict";
import { closeNativeCase, createNativeFailureReporter, finalizeNativeCase, runNativeCase } from "./native-case-finalization.mjs";

it("keeps teardown and publication failures when the report rejects", async () => {
  const failure = new Error("teardown failed"), write = new Error("report failed");
  await rejects(closeNativeCase(async () => { throw failure; }, async () => { throw write; }), error => {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe("Native teardown and failure report failed");
    expect(error.errors).toEqual([failure, write]);
    expect(error.errors[0]).toBe(failure);
    expect(error.errors[1]).toBe(write);
    expect(error.cause).toBe(failure);
    return true;
  });
});

it("finishes reporting before releasing each owner once in order", async () => {
  const order = [];
  const report = vi.fn(async () => { order.push("report"); });
  const browser = vi.fn(async () => { order.push("browser"); });
  const server = vi.fn(async () => { order.push("server"); });
  await finalizeNativeCase({ report, cleanup: [browser, server] });
  expect(order).toEqual(["report", "browser", "server"]);
  for (const callback of [report, browser, server]) expect(callback).toHaveBeenCalledTimes(1);
});

it("a rejected report still closes every owner and remains the reported error", async () => {
  const error = new Error("observations write failed");
  const browser = vi.fn(), server = vi.fn();
  await expect(finalizeNativeCase({ report: () => { throw error; }, cleanup: [browser, server] })).rejects.toBe(error);
  expect(browser).toHaveBeenCalledOnce();
  expect(server).toHaveBeenCalledOnce();
});

it("a failed cleanup cannot skip the remaining owners", async () => {
  const error = new Error("browser close failed"), server = vi.fn();
  await expect(finalizeNativeCase({ cleanup: [() => { throw error; }, server] })).rejects.toBe(error);
  expect(server).toHaveBeenCalledOnce();
});

it("retains the original case, report and all cleanup failures", async () => {
  const primary = new Error("case failed"), write = new Error("write failed"), browser = new Error("browser failed"), server = new Error("server failed");
  const released = vi.fn();
  await rejects(finalizeNativeCase({ error: primary, report: async () => { throw write; }, cleanup: [() => { throw browser; }, async () => { throw server; }, released] }), error => {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe("Native diagnostics or cleanup failed");
    expect(error.errors).toEqual([primary, write, browser, server]);
    expect(error.cause).toBe(primary);
    return true;
  });
  expect(released).toHaveBeenCalledOnce();
});

for (const bodyFails of [false, true]) for (const closeFails of [false, true]) {
  it(`owns case error precedence and detaches listeners (body=${bodyFails}, close=${closeFails})`, async () => {
    const primary = new Error("case failed"), teardown = new Error("close failed"), events = [];
    const running = runNativeCase({
      run() { events.push("run"); if (bodyFails) throw primary; return "value"; },
      reportFailure(error) { expect(error).toBe(primary); events.push("report"); },
      close() { events.push("close"); if (closeFails) throw teardown; },
      detach() { events.push("detach"); },
    });
    if (bodyFails && closeFails) {
      await rejects(running, error => {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toBe("Native diagnostics or cleanup failed");
        expect(error.errors).toEqual([primary, teardown]);
        expect(error.errors[0]).toBe(primary); expect(error.errors[1]).toBe(teardown);
        expect(error.cause).toBe(primary); return true;
      });
    } else if (bodyFails || closeFails) await expect(running).rejects.toBe(bodyFails ? primary : teardown);
    else await expect(running).resolves.toBe("value");
    expect(events).toEqual(bodyFails ? ["run", "report", "close", "detach"] : ["run", "close", "detach"]);
  });
}

it("report failure cannot replace the case or skip teardown and listener removal", async () => {
  const primary = new Error("case failed"), write = new Error("write failed"), teardown = new Error("close failed"), detach = new Error("detach failed");
  const events = [];
  await rejects(runNativeCase({
    run() { throw primary; }, reportFailure() { events.push("report"); throw write; },
    close() { events.push("close"); throw teardown; }, detach() { events.push("detach"); throw detach; },
  }), error => {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe("Native diagnostics or cleanup failed");
    expect(error.errors).toEqual([primary, write, teardown, detach]);
    expect(error.cause).toBe(primary); return true;
  });
  expect(events).toEqual(["report", "close", "detach"]);
});

it("retains original evidence while appending separately captured teardown evidence", async () => {
  const primary = new Error("case failed"), teardown = new Error("close failed");
  const original = { observed: { url: "http://globnotes.test/readme", body: "original", selection: "selected" }, pageErrors: [], writes: [{ status: 200 }] };
  const later = { observed: { error: "page closed" }, pageErrors: ["later"], writes: [] };
  const capture = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(later), records = [];
  const reporter = createNativeFailureReporter(capture, (record, options) => records.push({ record, options }));
  await reporter.report(primary);
  original.observed.body = "mutated"; original.writes[0].status = 500;
  await reporter.report(teardown);
  await reporter.report(primary);
  await reporter.settle();
  const first = { error: String(primary), observed: { url: "http://globnotes.test/readme", body: "original", selection: "selected" }, pageErrors: [], writes: [{ status: 200 }] };
  expect(records).toEqual([
    { record: { ...first, failures: [{ message: String(primary) }], observations: [first] }, options: { createNew: true } },
    { record: { ...first, failures: [{ message: String(primary) }, { message: String(teardown) }], observations: [first, { error: String(teardown), ...later }] }, options: { createNew: false } },
  ]);
  expect(capture).toHaveBeenCalledTimes(2);
});

it("does not replace an existing case failure when finalization succeeds", async () => {
  const primary = new Error("primary assertion"), closed = vi.fn();
  async function driver() {
    try { throw primary; }
    finally { await finalizeNativeCase({ error: primary, cleanup: [closed] }); }
  }
  await expect(driver()).rejects.toBe(primary);
  expect(closed).toHaveBeenCalledOnce();
});
