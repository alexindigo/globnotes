import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({ read: vi.fn(), events: vi.fn(), remove: vi.fn() }));
vi.mock("../api.js", () => ({ getPluginHostCatalog: adapters.read, openPluginHostEvents: adapters.events }));
vi.mock("../commands.js", () => ({ removeCommandOwner: adapters.remove }));
vi.mock("../pluginSdk.js", () => ({ createPluginSdk: vi.fn(() => ({})) }));

const catalog = revision => ({ contractVersion: 1, policy: { revision, signature: `policy-${revision}`, effectiveAutoEnable: true }, plugins: [] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let runtime, listeners;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((name, callback, options) => {
    if (["pagehide", "pageshow"].includes(name)) listeners.push({ name, callback, options });
    add(name, callback, options);
  });
  adapters.read.mockResolvedValue(catalog(0)); adapters.events.mockResolvedValue(vi.fn());
  runtime = await import("../pluginRuntime.js");
});
afterEach(() => {
  runtime.stopPluginRuntime();
  for (const listener of listeners) window.removeEventListener(listener.name, listener.callback, listener.options);
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe("review repairs: R17 catalogue publication ownership", () => {
  it("reverse refresh replies cannot replace the current accepted policy projection", async () => {
    await runtime.startPluginRuntime();
    const a = deferred(), b = deferred();
    adapters.read.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = runtime.refreshPluginRuntimeCatalog(), second = runtime.refreshPluginRuntimeCatalog();
    b.resolve(catalog(2)); await second;
    expect(runtime.pluginCatalog.value.policy.revision).toBe(2);
    a.resolve(catalog(1)); await first;
    expect(runtime.pluginCatalog.value.policy.revision).toBe(2);
  });

  it.each(["session", "document"])("a stale %s 401 cannot retire the replacement projection or stream", async ending => {
    const originalClose = vi.fn(), freshClose = vi.fn();
    adapters.events.mockResolvedValueOnce(originalClose).mockResolvedValueOnce(freshClose);
    await runtime.startPluginRuntime();
    const a = deferred(); adapters.read.mockReturnValueOnce(a.promise);
    const stale = runtime.refreshPluginRuntimeCatalog();
    adapters.read.mockResolvedValueOnce(catalog(3));
    if (ending === "session") { runtime.stopPluginRuntime(); await runtime.startPluginRuntime(); }
    else { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); await flush(); }
    expect(runtime.pluginCatalog.value.policy.revision).toBe(3);
    expect(originalClose).toHaveBeenCalledTimes(1);
    a.reject({ response: { status: 401 } }); await stale; await flush();
    expect(runtime.pluginCatalog.value?.policy.revision).toBe(3);
    expect(freshClose).not.toHaveBeenCalled();
  });
});

describe("review repairs: R17 shared publisher receipts and policy floor", () => {
  it("latest read owns a 401 while an older read failure cannot stop the accepted stream", async () => {
    const close = vi.fn(); adapters.events.mockResolvedValue(close);
    await runtime.startPluginRuntime();
    const a = deferred(); adapters.read.mockReturnValueOnce(a.promise).mockResolvedValueOnce(catalog(2));
    const older = runtime.refreshPluginRuntimeCatalog();
    expect((await runtime.refreshPluginRuntimeCatalog()).status).toBe("accepted");
    a.reject({ response: { status: 401 } });
    expect((await older).status).toBe("superseded");
    expect(close).not.toHaveBeenCalled(); expect(runtime.pluginCatalog.value.policy.revision).toBe(2);
    adapters.read.mockRejectedValueOnce({ response: { status: 401 } });
    expect((await runtime.refreshPluginRuntimeCatalog()).status).toBe("error");
    expect(close).toHaveBeenCalledTimes(1); expect(runtime.pluginCatalog.value).toBeNull();
  });

  it("acknowledged policy writes fence lower reads without using permission revision as policy authority", async () => {
    await runtime.startPluginRuntime();
    const owner = runtime.capturePluginCatalogOwnership();
    expect(runtime.acknowledgePluginPolicy({ revision: 4, signature: "committed-policy" }, owner)).toBe(true);
    adapters.read.mockResolvedValueOnce(catalog(3));
    expect((await runtime.refreshPluginRuntimeCatalog()).status).toBe("superseded");
    expect(runtime.pluginCatalog.value.policy.revision).toBe(0);
    adapters.read.mockResolvedValueOnce(catalog(4));
    const accepted = await runtime.refreshPluginRuntimeCatalog();
    expect(accepted.status).toBe("accepted"); expect(accepted.catalog.policy.revision).toBe(4);
    adapters.read.mockResolvedValueOnce(catalog(5));
    expect((await runtime.refreshPluginRuntimeCatalog({ revision: 9000, signature: "permission-only" })).status).toBe("accepted");
    expect(runtime.pluginCatalog.value.policy.revision).toBe(5);
  });

  it("an old session write acknowledgement cannot raise the replacement session floor", async () => {
    await runtime.startPluginRuntime("session-A");
    const owner = runtime.capturePluginCatalogOwnership();
    runtime.stopPluginRuntime(); adapters.read.mockResolvedValueOnce(catalog(1));
    await runtime.startPluginRuntime("session-B");
    expect(runtime.acknowledgePluginPolicy({ revision: 800, signature: "old-A" }, owner)).toBe(false);
    adapters.read.mockResolvedValueOnce(catalog(2));
    expect((await runtime.refreshPluginRuntimeCatalog()).status).toBe("accepted");
    expect(runtime.pluginCatalog.value.policy.revision).toBe(2);
  });

  it("framework consumers cannot mutate the catalogue ref or its nested policy", async () => {
    await runtime.startPluginRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runtime.pluginCatalog.value.policy.revision = 500;
    runtime.pluginCatalog.value = catalog(700);
    expect(runtime.pluginCatalog.value.policy.revision).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
