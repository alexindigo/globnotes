import { expect, it, vi } from "vitest";
import { finalizeNativeCase } from "./native-case-finalization.mjs";

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
  const error = await finalizeNativeCase({ error: primary, report: async () => { throw write; }, cleanup: [() => { throw browser; }, async () => { throw server; }, released] }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([primary, write, browser, server]);
  expect(error.cause).toBe(primary);
  expect(released).toHaveBeenCalledOnce();
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
