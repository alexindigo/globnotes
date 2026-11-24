import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identitySessionKey } from "../../shared/identity_session.ts";
import { accountProjection } from "./helpers/account-projection.js";

const adapters = { catalog: vi.fn(), events: vi.fn() };
let runtime, unbind, session;
let listeners;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); listeners = [];
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((name, callback, options) => {
      if (["pagehide", "pageshow", "visibilitychange"].includes(name)) listeners.push({ target, name, callback, options });
      add(name, callback, options);
    });
  }
  adapters.catalog.mockResolvedValue({ contractVersion: 1, plugins: [] });
  adapters.events.mockResolvedValue(vi.fn());
  runtime = await import("../pluginRuntime.js");
  const { connectionLifetime } = await import("../connectionLifetime.js");
  session = identitySessionKey(accountProjection());
  unbind = runtime.bindPluginRuntime(runtime.createIdentityPluginRuntime({ sessionKey: () => session,
    lifetime: connectionLifetime, readCatalog: adapters.catalog, openEvents: adapters.events }));
});
afterEach(() => {
  runtime.stopPluginRuntime();
  unbind();
  for (const listener of listeners) listener.target.removeEventListener(listener.name, listener.callback, listener.options);
  vi.restoreAllMocks(); vi.useRealTimers();
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("browser document-owned runtime streams", () => {
  it("hidden tabs release plugin streams after the shared grace and refetch on show", async () => {
    vi.useFakeTimers();
    const close = vi.fn(); adapters.events.mockResolvedValue(close);
    await runtime.startPluginRuntime(session);
    const signal = adapters.events.mock.calls[0][0].signal;
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(9999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      adapters.events.mock.calls[0][0].onClose("ended");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapters.events).toHaveBeenCalledTimes(1);
      visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); await flush();
      expect(adapters.catalog).toHaveBeenCalledTimes(2);
      expect(adapters.events).toHaveBeenCalledTimes(2);
    } finally {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  it("pagehide closes the admitted stream and pageshow refetches/reconnects once", async () => {
    const close = vi.fn(); adapters.events.mockResolvedValue(close);
    await runtime.startPluginRuntime(session);
    window.dispatchEvent(new Event("pagehide"));
    expect(close).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pageshow")); await flush();
    expect(adapters.catalog).toHaveBeenCalledTimes(2);
    expect(adapters.events).toHaveBeenCalledTimes(2);
  });
  it("pagehide aborts outstanding stream admission and retires late receipts", async () => {
    let acknowledge;
    adapters.events.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    const starting = runtime.startPluginRuntime(session); await flush();
    const signal = adapters.events.mock.calls[0][0].signal;
    window.dispatchEvent(new Event("pagehide"));
    expect(signal?.aborted).toBe(true);
    const lateClose = vi.fn(); acknowledge(lateClose); await starting;
    expect(lateClose).toHaveBeenCalledTimes(1);
  });
  it("explicit stop while suspended cannot reopen contributions on pageshow", async () => {
    await runtime.startPluginRuntime(session);
    window.dispatchEvent(new Event("pagehide")); runtime.stopPluginRuntime();
    window.dispatchEvent(new Event("pageshow")); await flush();
    expect(adapters.events).toHaveBeenCalledTimes(1);
    expect(runtime.pluginCatalog.value).toBeNull();
  });
  it("stale document close callbacks do not reconnect after suspension", async () => {
    vi.useFakeTimers();
    await runtime.startPluginRuntime(session);
    const oldClose = adapters.events.mock.calls[0][0].onClose;
    window.dispatchEvent(new Event("pagehide")); oldClose("ended");
    await vi.advanceTimersByTimeAsync(6000);
    expect(adapters.events).toHaveBeenCalledTimes(1);
  });
});
