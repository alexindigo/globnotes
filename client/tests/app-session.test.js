import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createAppSession } from "../appSession.js";
import { permissionEligibility, permissionSessionKey, permissionWritability } from "../appSessionPolicy.js";
import * as api from "../api.js";
import { clearStoredToken } from "../tokenStorage.js";

vi.mock("../api.js", () => ({ getConfig: vi.fn(), apiErrorHandler: vi.fn() }));
vi.mock("../brand.js", () => ({ applyBrandToDocument: vi.fn() }));
vi.mock("../noteIndex.js", () => ({ refreshNoteIndex: vi.fn() }));
vi.mock("../pluginRuntime.js", () => ({ refreshPluginRuntimeCatalog: vi.fn(), stopPluginRuntime: vi.fn() }));
vi.mock("../tokenStorage.js", () => ({ clearStoredToken: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  const state = { config: { authType: "password", setupRequired: true, accessRevision: 2, brand: { name: "Kept" } }, setup: true, settings: true };
  const order = [];
  const adapters = {
    config: () => state.config, setConfig: value => { state.config = value; order.push("config"); },
    setSetupRequested: value => { state.setup = value; order.push(`setup:${value}`); },
    setSettingsVisible: value => { state.settings = value; order.push(`settings:${value}`); },
    navigate: vi.fn(async target => { order.push(`route:${target.name}`); }), toast: { add: vi.fn() },
    loaded: vi.fn(() => order.push("loaded")), failed: vi.fn(),
    readConfig: vi.fn(async () => ({ authType: "none", accessRevision: 2, brand: { name: "Read" } })),
    applyBrand: vi.fn(() => order.push("brand")), reportError: vi.fn(),
    refreshNotes: vi.fn(() => order.push("notes")), refreshCatalog: vi.fn(() => order.push("catalog")),
    stopRuntime: vi.fn(() => order.push("stop")), resolve: vi.fn(async () => "proceed"),
    clearToken: vi.fn(() => order.push("clear")),
    loadTokenStorage: vi.fn(async () => ({ clearStoredToken: () => order.push("clear-import") })),
    ...overrides,
  };
  return { session: createAppSession(adapters), state, order, ...adapters };
}

describe("shared app permission session policy", () => {
  it.each([
    ["none", null, "none:anonymous"], ["password", "token", "password:token"],
    ["totp", "", "totp:"], ["read_only", undefined, "read_only:anonymous"],
  ])("preserves %s session namespace", (authType, token, key) => {
    expect(permissionSessionKey({ authType }, token)).toBe(key);
  });
  it.each([
    [false, "none", false, "home", null, false], [true, "none", true, "home", null, false],
    [true, "none", false, "login", null, false], [true, "none", false, "note", null, true],
    [true, "read_only", false, "note", null, true], [true, "password", false, "note", null, false],
    [true, "password", false, "note", "token", true], [true, "totp", false, "note", "token", true],
  ])("gates readiness/auth/route: %s %s %s %s %s", (ready, authType, setupRequired, route, token, eligible) => {
    expect(permissionEligibility(ready, { authType, setupRequired }, route, token)).toBe(eligible);
  });
  it.each([
    [false, "none", true, false], [true, "read_only", undefined, false],
    [true, "none", undefined, true], [true, "password", false, false], [true, "read_only", true, true],
  ])("retains explicit settings policy and legacy fallback: %s %s %s", (eligible, authType, settingsWritable, writable) => {
    expect(permissionWritability(eligible, { authType, settingsWritable })).toBe(writable);
  });
});

describe("app configuration and handoff owner", () => {
  it("publishes initial config/readiness before brand, loaded and index callbacks", async () => {
    const f = fixture();
    expect(f.session.state.configReady).toBe(false);
    await f.session.load();
    expect(f.session.state.configReady).toBe(true); expect(f.state.config.brand.name).toBe("Read");
    expect(f.order).toEqual(["config", "brand", "loaded", "notes"]);
  });
  it("reports initial configuration failure without admitting readiness", async () => {
    const error = Error("offline"), f = fixture({ readConfig: vi.fn(async () => { throw error; }) });
    await f.session.load();
    expect(f.session.state.configReady).toBe(false); expect(f.reportError).toHaveBeenCalledWith(error, f.toast);
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.loaded).not.toHaveBeenCalled(); expect(f.refreshNotes).not.toHaveBeenCalled();
  });
  it("binds the default configuration transport and token adapter", async () => {
    const f = fixture({ readConfig: undefined, loadTokenStorage: undefined });
    api.getConfig.mockResolvedValue({ authType: "none", brand: {} });
    await f.session.load(); expect(api.getConfig).toHaveBeenCalledOnce();
    await f.session.logoutFromSettings(); expect(clearStoredToken).toHaveBeenCalledOnce();
  });
  it("accepts only the newest catalog refresh and never regresses access revision", async () => {
    const a = deferred(), b = deferred(), f = fixture({ readConfig: vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise) });
    const first = f.session.refreshConfig(), second = f.session.refreshConfig();
    b.resolve({ authType: "none", accessRevision: 4 }); await second;
    a.resolve({ authType: "password", accessRevision: 5 }); await first;
    expect(f.state.config).toEqual({ authType: "none", accessRevision: 4 });
    f.readConfig.mockResolvedValue({ accessRevision: 3 }); await f.session.refreshConfig();
    f.readConfig.mockResolvedValue({ authType: "totp" }); await f.session.refreshConfig();
    f.readConfig.mockRejectedValue(Error("offline")); await f.session.refreshConfig();
    expect(f.state.config).toEqual({ authType: "none", accessRevision: 4 });
  });
  it("opens Access after hiding Settings", () => {
    const f = fixture(); f.session.openAccessFromSettings();
    expect(f.order).toEqual(["settings:false", "setup:true"]); expect(f.state).toMatchObject({ settings: false, setup: true });
  });
  it.each(["proceed", "cancel", "failed"])("Access preparation maps participant result %s", async result => {
    const f = fixture({ resolve: vi.fn(async () => result) });
    expect(await f.session.beforeSetupCommit()).toBe(result === "proceed"); expect(f.resolve).toHaveBeenCalledWith("access");
    expect(f.order).toEqual([]);
  });
  it("deduplicates logout, retains credentials through settlement and awaits navigation", async () => {
    const settled = deferred(), routed = deferred();
    const f = fixture({ resolve: vi.fn(() => settled.promise), navigate: vi.fn(() => routed.promise) });
    const first = f.session.logoutFromSettings(); expect(f.session.logoutFromSettings()).toBe(first);
    expect(f.order).toEqual([]); expect(f.resolve).toHaveBeenCalledWith("logout");
    settled.resolve("proceed"); await flushPromises();
    expect(f.order).toEqual(["stop", "clear-import", "settings:false"]); expect(f.navigate).toHaveBeenCalledWith({ name: "login" });
    expect(f.session.logoutFromSettings()).toBe(first);
    routed.resolve(); await first;
    expect(f.session.logoutFromSettings()).not.toBe(first); await flushPromises();
  });
  it.each(["cancel", "failed"])("aborted logout (%s) retains Settings and credentials", async decision => {
    const f = fixture({ resolve: vi.fn(async () => decision) }); await f.session.logoutFromSettings();
    expect(f.state.settings).toBe(true); expect(f.stopRuntime).not.toHaveBeenCalled();
    expect(f.loadTokenStorage).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled();
  });
  it("releases the logout reservation after a rejected handoff", async () => {
    const f = fixture({ resolve: vi.fn().mockRejectedValueOnce(Error("failed")).mockResolvedValue("proceed") });
    await expect(f.session.logoutFromSettings()).rejects.toThrow("failed");
    await f.session.logoutFromSettings(); expect(f.navigate).toHaveBeenCalledWith({ name: "login" });
  });
  it.each([[false, "password"], [true, "totp"]])("uses acknowledged password/TOTP policy immediately (%s)", async (totpEnabled, authType) => {
    const read = deferred(), f = fixture({ readConfig: vi.fn(() => read.promise) });
    f.session.setupCompleted({ view: { mode: "password", totpEnabled, revision: 3, settingsWritable: true, readOnlySettings: false }, requiresLogin: true });
    expect(f.state.config).toMatchObject({ authType, setupRequired: false, accessRevision: 3, settingsWritable: true, brand: { name: "Kept" } });
    expect(f.state.setup).toBe(false); expect(f.order).toEqual(["config", "setup:false", "stop", "clear", "route:login"]);
    expect(f.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Access updated", detail: "Access updated — sign in with your confirmed credentials." }));
    read.resolve({ accessRevision: 2 }); await flushPromises(); expect(f.state.config.authType).toBe(authType);
  });
  it.each(["none", "read_only", "password"])("preserves acknowledged non-login routing for %s", async authType => {
    const f = fixture({ readConfig: vi.fn(async () => { throw Error("refresh failed"); }) });
    f.session.setupCompleted({ view: {}, config: { authType, accessRevision: 3, setupRequired: false }, requiresLogin: false });
    expect(f.state.config.authType).toBe(authType); expect(f.state.setup).toBe(false);
    expect(f.clearToken).toHaveBeenCalledTimes(authType === "password" ? 0 : 1);
    expect(f.refreshNotes).toHaveBeenCalledTimes(authType === "none" ? 1 : 0);
    expect(f.refreshCatalog).toHaveBeenCalledTimes(authType === "read_only" ? 0 : 1);
    if (authType === "read_only") expect(f.navigate).toHaveBeenCalledWith({ name: "home" });
    else expect(f.navigate).not.toHaveBeenCalled();
    await flushPromises(); expect(f.state.config.authType).toBe(authType);
  });
  it("fences pre-acknowledgement catalog reads and accepts a current follow-up without replay", async () => {
    const old = deferred(), fresh = deferred(), f = fixture({ readConfig: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
    const refresh = f.session.refreshConfig();
    f.session.setupCompleted({ view: { mode: "none", revision: 3 }, requiresLogin: false });
    old.resolve({ authType: "password", accessRevision: 9 }); await refresh;
    expect(f.state.config.authType).toBe("none");
    fresh.resolve({ authType: "none", accessRevision: 4, extra: true }); await flushPromises();
    expect(f.state.config).toEqual({ authType: "none", accessRevision: 4, extra: true });
    expect(f.clearToken).toHaveBeenCalledOnce(); expect(f.refreshCatalog).toHaveBeenCalledOnce();
  });
  it.each(["none", "read_only", "password", "totp"])("preserves first-run completion for %s", async authType => {
    const f = fixture({ readConfig: vi.fn(async () => ({ authType, brand: { name: "First" } })) });
    f.session.setupCompleted(); expect(f.state.setup).toBe(false); await flushPromises();
    expect(f.state.config.authType).toBe(authType); expect(f.applyBrand).toHaveBeenCalledWith({ name: "First" });
    const publicMode = ["none", "read_only"].includes(authType);
    expect(f.navigate).toHaveBeenCalledWith({ name: publicMode ? "home" : "login" });
    expect(f.order).toContain("clear-import"); expect(f.refreshNotes).toHaveBeenCalledTimes(publicMode ? 1 : 0);
    expect(f.stopRuntime).toHaveBeenCalledTimes(publicMode ? 0 : 1);
    if (!publicMode) expect(f.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Setup complete" }));
  });
});
