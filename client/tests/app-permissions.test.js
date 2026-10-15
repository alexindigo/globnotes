import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import { createAppPermissions, permissionRequestKey } from "../appPermissions.js";
import * as api from "../api.js";

vi.mock("../api.js", () => ({ getPluginPermissions: vi.fn(), putPluginPermissions: vi.fn(), getPluginPermissionRequests: vi.fn(), decidePluginPermissionRequest: vi.fn() }));
vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  return { pluginCatalog: ref(null), refreshPluginRuntimeCatalog: vi.fn(), startPluginRuntime: vi.fn(), stopPluginRuntime: vi.fn() };
});
const owners = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.clearAllMocks(); });
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const host = { type: "host", authority: "example.test:443" }, all = { type: "all" };
const request = (id = "request-A") => ({ pluginId: "p", id, state: "pending", kind: "network", scopes: [host], source: { key: "source-A", revision: 1 } });
function fixture(options = {}) {
  const inputs = reactive({ config: { authType: "none", setupRequired: false }, ready: false, route: "note", setup: false, token: null });
  const catalog = ref(null), modals = ref([]), next = ref(null), pendingRequests = ref([]);
  const record = reactive({ available: true, hasServer: true, busy: false, view: { pendingRequests: [] } });
  const choices = reactive({ scopes: [host], allowNetwork: false });
  const permissions = {
    setSession: vi.fn(), reconcile: vi.fn(), refreshPending: vi.fn(), dispose: vi.fn(),
    snapshot: vi.fn(() => record), nextRequest: vi.fn(() => next.value), pendingRequests,
    load: vi.fn(async () => ({ status: "accepted", current: () => true })),
    requestChoices: vi.fn(() => choices), editRequest: vi.fn((request, patch) => Object.assign(choices, patch)),
    decide: vi.fn(async () => true), defer: vi.fn(),
  };
  const createPermissions = vi.fn(() => permissions), refreshConfig = vi.fn(), startRuntime = vi.fn(), stopRuntime = vi.fn();
  const owner = createAppPermissions({ config: () => inputs.config, configReady: () => inputs.ready,
    routeName: () => inputs.route, setupRequested: () => inputs.setup, token: () => inputs.token,
    catalog, modals, createPermissions, refreshConfig, startRuntime, stopRuntime, ...options });
  owners.push(owner);
  // Production admits the session before a pending-request read can publish.
  function publish(value = request()) { inputs.ready = true; record.view = { pendingRequests: [value] }; pendingRequests.value = [value]; next.value = value; }
  return { owner, inputs, catalog, modals, next, record, choices, permissions, createPermissions, refreshConfig, startRuntime, stopRuntime, publish };
}
async function opened() { const f = fixture(); f.publish(); await flushPromises(); expect(f.owner.state.activePermissionRequest?.id).toBe("request-A"); return f; }

describe("App permission owner", () => {
  it("binds default transport at its owning module", () => {
    const f = fixture();
    expect(f.createPermissions).toHaveBeenCalledWith(expect.objectContaining({ readView: api.getPluginPermissions,
      writeView: api.putPluginPermissions, readPending: api.getPluginPermissionRequests, decideRequest: api.decidePluginPermissionRequest }));
    expect(f.permissions.setSession).toHaveBeenCalledWith("none:anonymous", { active: false, canWrite: false });
    expect(f.startRuntime).not.toHaveBeenCalled(); expect(f.stopRuntime).not.toHaveBeenCalled();
  });
  it("reconciles eligible sessions/catalogs and starts/stops the matching runtime namespace", async () => {
    const f = fixture(); f.inputs.ready = true; await nextTick();
    expect(f.permissions.setSession).toHaveBeenLastCalledWith("none:anonymous", { active: true, canWrite: true });
    expect(f.startRuntime).toHaveBeenLastCalledWith("none:anonymous");
    f.catalog.value = { plugins: [{ id: "p" }] }; await nextTick();
    expect(f.permissions.reconcile).toHaveBeenLastCalledWith(f.catalog.value); expect(f.refreshConfig).toHaveBeenCalledOnce();
    f.inputs.config.authType = "password"; f.inputs.token = "token"; await nextTick();
    expect(f.startRuntime).toHaveBeenLastCalledWith("password:token");
    f.inputs.route = "login"; await nextTick();
    expect(f.permissions.setSession).toHaveBeenLastCalledWith("password:token", { active: false, canWrite: false });
    expect(f.stopRuntime).toHaveBeenCalledOnce();
  });
  it("keeps inactive catalog reconciliation separate from configuration readiness", async () => {
    const f = fixture(); f.catalog.value = { plugins: [] }; await nextTick();
    expect(f.permissions.reconcile).toHaveBeenCalledOnce(); expect(f.permissions.refreshPending).not.toHaveBeenCalled();
    expect(f.refreshConfig).not.toHaveBeenCalled();
  });
  it.each(["setup", "modal"])("postpones automatic reads behind %s without deferring consent", async blocker => {
    const f = fixture();
    if (blocker === "setup") f.inputs.setup = true; else f.modals.value = [{ name: "confirm" }];
    f.publish(); await flushPromises(); expect(f.permissions.load).not.toHaveBeenCalled();
    expect(f.owner.state.activePermissionRequest).toBeNull(); expect(f.permissions.defer).not.toHaveBeenCalled();
    f.inputs.setup = false; f.modals.value = []; await flushPromises();
    expect(f.permissions.load).toHaveBeenCalledOnce(); expect(f.owner.state.activePermissionRequest.id).toBe("request-A");
  });
  it("allows an automatic request over Settings", async () => {
    const f = fixture(); f.inputs.ready = true; await nextTick();
    f.modals.value = [{ name: "settings" }]; f.publish(); await flushPromises();
    expect(f.owner.state.activePermissionRequest.id).toBe("request-A");
  });
  it("readiness admission invalidates a request opening queued before its session", async () => {
    const f = fixture();
    // Unlike a real pending read, this fake input can appear before setSession.
    f.next.value = request(); f.publish(); await flushPromises();
    expect(f.permissions.load).toHaveBeenCalledOnce(); expect(f.owner.state.activePermissionRequest).toBeNull();
    f.catalog.value = { plugins: [{ id: "p" }] }; await flushPromises();
    expect(f.permissions.load).toHaveBeenCalledTimes(2); expect(f.owner.state.activePermissionRequest.id).toBe("request-A");
  });
  it.each(["error", "superseded", "inactive", "expired", "unavailable", "browser-only", "changed-request"])("requires a current accepted server view: %s", async failure => {
    const f = fixture();
    f.permissions.load.mockImplementation(async () => {
      if (failure === "unavailable") f.record.available = false;
      if (failure === "browser-only") f.record.hasServer = false;
      if (failure === "changed-request") f.record.view.pendingRequests = [{ ...request(), scopes: [all] }];
      return { status: ["error", "superseded", "inactive"].includes(failure) ? failure : "accepted", current: () => failure !== "expired" };
    });
    f.publish(); await flushPromises();
    expect(f.owner.state.activePermissionRequest).toBeNull(); expect(f.permissions.decide).not.toHaveBeenCalled();
  });
  it.each(["setup", "modal", "route", "session", "request", "dispose"])("fences a held automatic read on %s", async change => {
    const f = fixture(), read = deferred(); f.permissions.load.mockReturnValue(read.promise); f.publish(); await flushPromises();
    expect(f.permissions.load).toHaveBeenCalledOnce();
    if (change === "setup") f.inputs.setup = true;
    if (change === "modal") f.modals.value = [{ name: "confirmation" }];
    if (change === "route") f.inputs.route = "login";
    if (change === "session") { f.inputs.config.authType = "password"; f.inputs.token = null; }
    if (change === "request") f.next.value = null;
    if (change === "dispose") { f.owner.dispose(); owners.pop(); }
    await nextTick(); read.resolve({ status: "accepted", current: () => true }); await flushPromises();
    expect(f.owner.state.activePermissionRequest).toBeNull(); expect(f.permissions.defer).not.toHaveBeenCalled();
  });
  it("retires a prompt and cancels its risk choice when the current source disappears", async () => {
    const f = await opened(), choice = f.owner.chooseRequestScope(all, true);
    f.record.view = { pendingRequests: [] }; await flushPromises(); await choice;
    expect(f.owner.state.activePermissionRequest).toBeNull(); expect(f.owner.state.permissionRiskVisible).toBe(false);
    expect(f.permissions.editRequest).not.toHaveBeenCalled();
  });
  it("manual review requires a fresh view, but can open over an unrelated modal", async () => {
    const f = fixture(); f.inputs.ready = true; f.modals.value = [{ name: "confirmation" }]; await nextTick();
    const value = request(); f.record.view.pendingRequests = [value];
    await f.owner.openRequestedPermissionReview(value);
    expect(f.permissions.load).toHaveBeenCalledWith("p"); expect(f.owner.state.activePermissionRequest.id).toBe(value.id);
  });
  it("manual review does not load in an ineligible session or reopen behind Access", async () => {
    const f = fixture(); await f.owner.openRequestedPermissionReview(request()); expect(f.permissions.load).not.toHaveBeenCalled();
    const read = deferred(); f.inputs.ready = true; await nextTick(); f.permissions.load.mockReturnValue(read.promise);
    f.record.view.pendingRequests = [request()]; const opening = f.owner.openRequestedPermissionReview(request());
    f.inputs.setup = true; await nextTick(); read.resolve({ status: "accepted", current: () => true }); await opening;
    expect(f.owner.state.activePermissionRequest).toBeNull();
  });
  it.each(["network", "imports"])("all-host %s selection is a separate explicit risk decision", async kind => {
    const f = fixture(); const value = { ...request(), kind }; f.publish(value); await flushPromises();
    const selection = f.owner.chooseRequestScope(all, true);
    expect(f.owner.state.permissionRiskVisible).toBe(true);
    expect(f.owner.state.permissionRiskMessage).toContain(kind === "imports" ? "remote-code imports" : "network data");
    expect(f.permissions.editRequest).not.toHaveBeenCalled(); f.owner.setPermissionRiskVisible(false);
    f.owner.finishPermissionRisk(true); await selection;
    expect(f.choices.scopes).toEqual([host, all]); expect(f.choices.allowNetwork).toBe(false);
    expect(f.permissions.decide).not.toHaveBeenCalled();
  });
  it("cancelled broad selection grants nothing; exact selection deduplicates and deselection does not prompt", async () => {
    const f = await opened(); const choice = f.owner.chooseRequestScope(all, true);
    f.owner.finishPermissionRisk(false); await choice; expect(f.permissions.editRequest).not.toHaveBeenCalled();
    await f.owner.chooseRequestScope(host, true); expect(f.choices.scopes).toEqual([host]);
    await f.owner.chooseRequestScope(host, false); expect(f.choices.scopes).toEqual([]);
    f.owner.chooseRequestMaster(true); expect(f.choices.allowNetwork).toBe(true);
  });
  it("busy review ignores scope changes and local deferral", async () => {
    const f = await opened(); f.record.busy = true;
    await f.owner.chooseRequestScope(all, true); f.owner.deferPermissionRequest();
    expect(f.owner.state.permissionRiskVisible).toBe(false); expect(f.permissions.editRequest).not.toHaveBeenCalled();
    expect(f.permissions.defer).not.toHaveBeenCalled(); expect(f.owner.state.activePermissionRequest).not.toBeNull();
  });
  it("local deferral cancels broad confirmation without sending a server decision", async () => {
    const f = await opened(); const selection = f.owner.chooseRequestScope(all, true); f.owner.deferPermissionRequest(); await selection;
    expect(f.permissions.defer).toHaveBeenCalledWith("request-A"); expect(f.owner.state.activePermissionRequest).toBeNull();
    expect(f.permissions.decide).not.toHaveBeenCalled(); expect(f.permissions.editRequest).not.toHaveBeenCalled();
  });
  it.each(["approve", "deny"])("%s forwards the captured request and closes only on acknowledgement", async decision => {
    const f = await opened(), done = deferred(); f.permissions.decide.mockReturnValue(done.promise);
    const intent = decision === "approve" ? f.owner.approvePermissionRequest : f.owner.denyPermissionRequest;
    const response = intent(); expect(f.owner.state.activePermissionRequest).not.toBeNull();
    const args = f.permissions.decide.mock.calls[0]; expect(args.slice(0, 3)).toEqual(["p", request(), decision]);
    if (decision === "approve") expect(args.slice(3)).toEqual([false, [host]]);
    else expect(args).toHaveLength(3);
    done.resolve(false); await response; expect(f.owner.state.activePermissionRequest).not.toBeNull();
    f.permissions.decide.mockResolvedValue(true); await intent(); expect(f.owner.state.activePermissionRequest).toBeNull();
  });
  it("late acknowledgement of an earlier request cannot dismiss its replacement", async () => {
    const f = await opened(), done = deferred(); f.permissions.decide.mockReturnValue(done.promise);
    const response = f.owner.approvePermissionRequest(); f.owner.deferPermissionRequest();
    f.publish(request("request-B")); await flushPromises(); expect(f.owner.state.activePermissionRequest.id).toBe("request-B");
    done.resolve(true); await response; expect(f.owner.state.activePermissionRequest.id).toBe("request-B");
  });
  it("dispose cancels pending risk, releases the permission owner and stops input watches", async () => {
    const f = await opened(), selection = f.owner.chooseRequestScope(all, true);
    f.owner.dispose(); owners.pop(); await selection;
    expect(f.permissions.dispose).toHaveBeenCalledOnce(); expect(f.owner.state.permissionRiskVisible).toBe(false);
    const calls = f.permissions.reconcile.mock.calls.length;
    f.catalog.value = { plugins: [] }; f.inputs.route = "login"; await nextTick();
    expect(f.permissions.reconcile).toHaveBeenCalledTimes(calls); expect(f.stopRuntime).not.toHaveBeenCalled();
  });
  it("request identity includes every consent/source field and ignores unrelated descriptions", () => {
    const value = request(); expect(permissionRequestKey(null)).toBeNull();
    expect(permissionRequestKey({ ...value, reason: "new caption" })).toBe(permissionRequestKey(value));
    for (const patch of [{ pluginId: "q" }, { id: "next" }, { state: "denied" }, { kind: "imports" }, { scopes: [all] },
      { source: { ...value.source, key: "source-B" } }, { source: { ...value.source, revision: 2 } }]) {
      expect(permissionRequestKey({ ...value, ...patch })).not.toBe(permissionRequestKey(value));
    }
  });
});
