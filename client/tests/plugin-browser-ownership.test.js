import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntime } from "../pluginRuntime.js";
import { createPluginSdk } from "../pluginSdk.js";
import { hasCommand, registerPluginCommand, removeCommandOwner, runCommand } from "../commands.js";
import { publish, subscribe } from "../bus/index.js";

vi.mock("../api.js", () => ({ getPluginHostCatalog: vi.fn(), openPluginHostEvents: vi.fn(), getPluginSettings: vi.fn(), invokePluginCommand: vi.fn() }));
vi.mock("../keybindings/dispatcher.js", () => ({ dispatchAction: vi.fn() }));

const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const catalogue = (revision, enabled = true) => ({ contractVersion: 1, policy: { revision, signature: `policy-${revision}` }, plugins: [{ id: "owned-browser", version: "1", enabled, runtime: { client: true } }] });
const topic = "note:save";
let owner;
afterEach(() => { owner?.stop(); owner = null; removeCommandOwner("owned-browser"); removeCommandOwner("later-browser"); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("review repairs: R15 exact browser activation ownership", () => {
  it("late A activation failure cannot dispose B's real command or bus subscription", async () => {
    const release = deferred(), reached = deferred(), received = [];
    const read = vi.fn().mockResolvedValueOnce(catalogue(1)).mockResolvedValueOnce(catalogue(2, false)).mockResolvedValueOnce(catalogue(3));
    const imports = vi.fn().mockResolvedValueOnce({ activate: async ctx => {
      ctx.commands.register({ id: "live", label: "A command" }, () => "A consumer"); reached.resolve();
      await release.promise; throw Error("late owned A activation failure");
    } }).mockResolvedValueOnce({ activate: ctx => {
      ctx.commands.register({ id: "live", label: "B command" }, () => "B consumer");
      ctx.events.on(topic, payload => received.push(payload));
    } });
    owner = createPluginRuntime({ readCatalog: read, openEvents: async () => () => {}, importModule: imports, getSession: () => "owned-session", report: vi.fn() });
    const a = owner.start(); await reached.promise;
    await owner.refresh(); await owner.refresh();
    const generationB = owner.browserGenerations.value.get("owned-browser").generation;
    expect(await runCommand("plugin:owned-browser:live")).toEqual({ result: "B consumer" });
    release.resolve(); await a;
    expect(await runCommand("plugin:owned-browser:live")).toEqual({ result: "B consumer" });
    publish(topic, { path: "B event consumer" });
    expect(received).toEqual([{ path: "B event consumer" }]);
    expect(owner.browserGenerations.value.get("owned-browser").generation).toBe(generationB);
  });

  it("A's captured raw command disposer cannot delete B's reused command ID", async () => {
    const a = registerPluginCommand("owned-browser", { id: "live", label: "A", target: "browser" }, () => "A");
    removeCommandOwner("owned-browser");
    registerPluginCommand("owned-browser", { id: "live", label: "B", target: "browser" }, () => "B retained consumer");
    a();
    expect(await runCommand("plugin:owned-browser:live")).toEqual({ result: "B retained consumer" });
  });
});

describe("review repairs: R16 managed effect admission", () => {
  it("a retired SDK command attempt creates no executable ghost registration", async () => {
    let sdk;
    const read = vi.fn().mockResolvedValueOnce(catalogue(1)).mockResolvedValueOnce(catalogue(2, false));
    owner = createPluginRuntime({ readCatalog: read, openEvents: async () => () => {}, importModule: async () => ({ activate: ctx => { sdk = ctx; } }), getSession: () => "owned-session" });
    await owner.start(); await owner.refresh();
    expect(() => sdk.commands.register({ id: "ghost", label: "Ghost" }, () => "must not be executable")).toThrow("obsolete");
    expect(hasCommand("plugin:owned-browser:ghost")).toBe(false);
  });

  it("a retired SDK event attempt leaves no subscriber behind", async () => {
    let sdk;
    const received = vi.fn(), read = vi.fn().mockResolvedValueOnce(catalogue(1)).mockResolvedValueOnce(catalogue(2, false));
    owner = createPluginRuntime({ readCatalog: read, openEvents: async () => () => {}, importModule: async () => ({ activate: ctx => { sdk = ctx; } }), getSession: () => "owned-session" });
    await owner.start(); await owner.refresh();
    expect(() => sdk.events.on(topic, received)).toThrow("obsolete");
    publish(topic, { path: "must not reach retired listener" });
    expect(received).not.toHaveBeenCalled();
  });

  it("retired interval admission allocates no timer", async () => {
    vi.useFakeTimers(); let sdk;
    const read = vi.fn().mockResolvedValueOnce(catalogue(1)).mockResolvedValueOnce(catalogue(2, false));
    owner = createPluginRuntime({ readCatalog: read, openEvents: async () => () => {}, importModule: async () => ({ activate: ctx => { sdk = ctx; } }), getSession: () => "owned-session" });
    await owner.start(); await owner.refresh();
    const baseline = vi.getTimerCount();
    expect(() => sdk.timers.setInterval(() => {}, 10)).toThrow("obsolete");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("reentrant ownership rejection rolls back the actual event subscription exactly once", () => {
    const received = vi.fn(); let adopted;
    const sdk = createPluginSdk({ pluginId: "owned-browser", snapshot: {}, assertActive: () => {}, own: release => { adopted = release; throw Error("adoption rejected"); } });
    expect(() => sdk.events.on(topic, received)).toThrow("adoption rejected");
    publish(topic, { path: "must not reach rejected listener" });
    expect(received).not.toHaveBeenCalled();
    expect(() => { adopted(); adopted(); }).not.toThrow();
  });

  it("a bus delivery already snapshotted before retirement cannot invoke the retired handler", async () => {
    let sdk;
    const stopFirst = subscribe(topic, () => owner.stop()), received = vi.fn();
    owner = createPluginRuntime({ readCatalog: async () => catalogue(1), openEvents: async () => () => {}, importModule: async () => ({ activate: ctx => { sdk = ctx; ctx.events.on(topic, received); } }), getSession: () => "owned-session" });
    try { await owner.start(); publish(topic, { path: "queued after stop" }); expect(received).not.toHaveBeenCalled(); }
    finally { stopFirst(); }
  });

  it("valid one-shot self-release still invokes its admitted callback once", async () => {
    vi.useFakeTimers(); let sdk;
    owner = createPluginRuntime({ readCatalog: async () => catalogue(1), openEvents: async () => () => {}, importModule: async () => ({ activate: ctx => { sdk = ctx; } }), getSession: () => "owned-session" });
    await owner.start();
    const callback = vi.fn(); sdk.timers.setTimeout(callback, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(callback).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("a timer's queued microtask cannot invoke a retired generation", async () => {
    vi.useFakeTimers(); let sdk;
    owner = createPluginRuntime({ readCatalog: async () => catalogue(1), openEvents: async () => () => {}, importModule: async () => ({ activate: ctx => { sdk = ctx; } }), getSession: () => "owned-session" });
    await owner.start();
    const callback = vi.fn(); sdk.timers.setTimeout(callback, 10);
    vi.advanceTimersByTime(10); owner.stop(); await Promise.resolve();
    expect(callback).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("review repairs: R17 reconciliation follows publication rather than pending-read admission", () => {
  it("a newer pending read does not invalidate an already accepted owner reconciliation", async () => {
    const reached = deferred(), release = deferred(), nextRead = deferred();
    const initial = catalogue(1); initial.plugins.push({ id: "later-browser", version: "1", enabled: true, runtime: { client: true } });
    const read = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(nextRead.promise);
    owner = createPluginRuntime({ readCatalog: read, openEvents: async () => () => {}, getSession: () => "owned-session", importModule: async url => url.includes("/later-browser/") ? { activate: ctx => { ctx.commands.register({ id: "live", label: "Later live command" }, () => "accepted later consumer"); } } : { activate: async () => { reached.resolve(); await release.promise; } } });
    const starting = owner.start(); await reached.promise;
    const refreshing = owner.refresh(); release.resolve(); await starting;
    expect(await runCommand("plugin:later-browser:live")).toEqual({ result: "accepted later consumer" });
    nextRead.resolve({ ...catalogue(2, false), plugins: [] }); await refreshing;
    expect(hasCommand("plugin:later-browser:live")).toBe(false);
  });

  it("a newer accepted publication fences later effects from the old wanted set", async () => {
    const reached = deferred(), release = deferred(), importedLater = vi.fn();
    const initial = catalogue(1); initial.plugins.push({ id: "later-browser", version: "1", enabled: true, runtime: { client: true } });
    owner = createPluginRuntime({ readCatalog: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...catalogue(2), plugins: [] }), openEvents: async () => () => {}, getSession: () => "owned-session", importModule: async url => {
      if (url.includes("/later-browser/")) { importedLater(); return { activate: () => {} }; }
      return { activate: async () => { reached.resolve(); await release.promise; } };
    } });
    const starting = owner.start(); await reached.promise;
    await owner.refresh(); release.resolve(); await starting;
    expect(importedLater).not.toHaveBeenCalled(); expect(owner.browserGenerations.value.size).toBe(0);
  });
});
