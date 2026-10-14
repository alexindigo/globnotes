import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({ catalog: vi.fn(), events: vi.fn(), remove: vi.fn() }));
vi.mock("../api.js", () => ({ getPluginHostCatalog: adapters.catalog, openPluginHostEvents: adapters.events }));
vi.mock("../commands.js", () => ({ removeCommandOwner: adapters.remove }));
vi.mock("../pluginSdk.js", () => ({ createPluginSdk: vi.fn() }));
let runtime;
let listeners;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((name, callback, options) => {
    if (["pagehide", "pageshow"].includes(name)) listeners.push({ name, callback, options });
    add(name, callback, options);
  });
  adapters.catalog.mockResolvedValue({ contractVersion: 1, plugins: [] });
  adapters.events.mockResolvedValue(vi.fn());
  runtime = await import("../pluginRuntime.js");
});
afterEach(() => {
  runtime.stopPluginRuntime();
  for (const listener of listeners) window.removeEventListener(listener.name, listener.callback, listener.options);
  vi.restoreAllMocks(); vi.useRealTimers();
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("browser document-owned runtime streams", () => {
  it("pagehide closes the admitted stream and pageshow refetches/reconnects once", async () => {
    const close = vi.fn(); adapters.events.mockResolvedValue(close);
    await runtime.startPluginRuntime();
    window.dispatchEvent(new Event("pagehide"));
    expect(close).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pageshow")); await flush();
    expect(adapters.catalog).toHaveBeenCalledTimes(2);
    expect(adapters.events).toHaveBeenCalledTimes(2);
  });
  it("pagehide aborts outstanding stream admission and retires late receipts", async () => {
    let acknowledge;
    adapters.events.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    const starting = runtime.startPluginRuntime(); await flush();
    const signal = adapters.events.mock.calls[0][0].signal;
    window.dispatchEvent(new Event("pagehide"));
    expect(signal?.aborted).toBe(true);
    const lateClose = vi.fn(); acknowledge(lateClose); await starting;
    expect(lateClose).toHaveBeenCalledTimes(1);
  });
  it("explicit stop while suspended cannot reopen contributions on pageshow", async () => {
    await runtime.startPluginRuntime();
    window.dispatchEvent(new Event("pagehide")); runtime.stopPluginRuntime();
    window.dispatchEvent(new Event("pageshow")); await flush();
    expect(adapters.events).toHaveBeenCalledTimes(1);
    expect(runtime.pluginCatalog.value).toBeNull();
  });
  it("stale document close callbacks do not reconnect after suspension", async () => {
    vi.useFakeTimers();
    await runtime.startPluginRuntime();
    const oldClose = adapters.events.mock.calls[0][0].onClose;
    window.dispatchEvent(new Event("pagehide")); oldClose("ended");
    await vi.advanceTimersByTimeAsync(6000);
    expect(adapters.events).toHaveBeenCalledTimes(1);
  });
});
