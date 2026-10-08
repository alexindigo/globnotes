import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsModal from "../components/SettingsModal.vue";
import { pluginCatalog } from "../pluginRuntime.js";
import { createPluginPermissionController } from "../pluginPermissionController.js";

vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  const pluginCatalog = ref(null);
  return { pluginCatalog,
    refreshPluginRuntimeCatalog: vi.fn(async () => ({ status: "accepted", catalog: pluginCatalog.value })),
    capturePluginCatalogOwnership: vi.fn(() => ({ current: () => true })), acknowledgePluginPolicy: vi.fn(() => true) };
});
vi.mock("../api.js", () => ({
  getPluginHostCatalog: vi.fn(), getPluginSettings: vi.fn(),
  putPluginSettings: vi.fn(), putPluginEnabled: vi.fn(), putPluginPolicy: vi.fn(),
  getPluginPermissions: vi.fn(async id => ({ pluginId: id, revision: 0, signature: "v0", requestSourceKey: "source", requestSourceRevision: 0,
    source: { key: "source", revision: 0, codeFingerprint: "code", settingsRevision: 0 }, allowNetwork: false,
    approvedNetwork: [], approvedImports: [], requestedNetwork: [], requestedImports: [], effectiveNetwork: [], effectiveImports: [], rows: [], pendingRequests: [],
    reload: { state: "none", fingerprint: "none" }, runsInBrowser: true, browserComponents: ["editor"] })),
  putPluginPermissions: vi.fn(), getPluginPermissionRequests: vi.fn(async () => []), decidePluginPermissionRequest: vi.fn(),
  getConfig: vi.fn(), postBrand: vi.fn(), getTree: vi.fn(),
}));
let wrapper;
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { wrapper?.unmount(); wrapper = null; pluginCatalog.value = null; vi.useRealTimers(); });

async function inventory() {
  pluginCatalog.value = {
    policy: { revision: 0, signature: "policy", effectiveAutoEnable: true },
    plugins: [
      { id: "mixed", name: "Mixed plugin", enabled: true, status: "ready", runtime: { server: true, client: true }, client: true, runsInBrowser: true, browserComponents: ["editor", "runtime"], pages: [], blocking: { actions: [] } },
      { id: "disabled-editor", name: "Disabled editor", enabled: false, status: "disabled", runtime: {}, client: true, runsInBrowser: true, browserComponents: ["editor"], pages: [], blocking: { actions: [] } },
    ],
  };
  wrapper = mount(SettingsModal, { attachTo: document.body, props: { modelValue: true }, global: { stubs: { Modal: { template: "<div role='dialog'><slot /></div>", methods: { focus() {} } }, ConfirmModal: true } } });
  await wrapper.vm.openSettings("core:plugins");
  await flushPromises();
}

describe("actual Settings permissions entry", () => {
  it("shows the prominent server-only trust boundary", async () => {
    await inventory();
    expect(document.body.textContent).toContain("These permission controls apply to sandboxed server Workers only.");
    expect(document.body.textContent).toContain("Browser network loads from rendered content");
  });
  it("shows framework browser badges on mixed and disabled inventory", async () => {
    await inventory();
    expect([...document.querySelectorAll("[data-plugin-browser-badge]")].map(el => el.textContent.trim())).toEqual(["Runs in browser", "Runs in browser"]);
  });
  it("exposes review and framework permission pages without declared settings", async () => {
    await inventory();
    expect([...document.querySelectorAll("button")].filter(el => el.textContent.trim() === "Review permissions")).toHaveLength(2);
    expect(document.querySelector('[data-permission-page="mixed"]')).not.toBeNull();
  });
});

function view(id = "p", revision = 0, overrides = {}) {
  return { pluginId: id, revision, signature: `v${revision}`, requestSourceKey: "source", requestSourceRevision: 0,
    source: { key: "source", revision: 0, codeFingerprint: "code", settingsRevision: 0 }, allowNetwork: false,
    requestedNetwork: [{ type: "host", authority: "service.example:443" }], requestedImports: [], approvedNetwork: [], approvedImports: [], effectiveNetwork: [], effectiveImports: [], rows: [], pendingRequests: [],
    reload: { state: "none", fingerprint: "none" }, runsInBrowser: true, browserComponents: ["editor"], ...overrides };
}
function controllerFixture(initial = view()) {
  const adapters = { readView: vi.fn(async () => initial), writeView: vi.fn(), readPending: vi.fn(async () => []), decideRequest: vi.fn(), timeout: 100 };
  const controller = createPluginPermissionController(adapters);
  controller.setSession("fixture", { active: true, canWrite: true });
  controller.reconcile({ plugins: [{ id: "p", name: "P", runtime: { server: true, client: true }, permissions: initial }] });
  return { controller, adapters };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("permission controller ownership and actual mutation envelopes", () => {
  it("network approval preserves imports and never implicitly enables the master", async () => {
    const initial = view("p", 0, { approvedImports: [{ type: "host", authority: "code.example:443" }] });
    const { controller, adapters } = controllerFixture(initial);
    adapters.writeView.mockImplementation(async (id, body) => ({ view: view(id, 1, { ...body, revision: 1, signature: "v1" }) }));
    await controller.approve("p", "network", { type: "host", authority: "service.example:443" });
    expect(adapters.writeView.mock.calls[0]).toEqual(["p", { revision: 0, signature: "v0", requestSourceKey: "source", requestSourceRevision: 0, allowNetwork: false,
      approvedNetwork: [{ type: "host", authority: "service.example:443" }], approvedImports: [{ type: "host", authority: "code.example:443" }] }]);
  });
  it("a late GET cannot replace a committed decision or another plugin view", async () => {
    const { controller, adapters } = controllerFixture();
    const get = deferred(); adapters.readView.mockReturnValue(get.promise);
    const loading = controller.load("p");
    adapters.writeView.mockResolvedValue({ view: view("p", 1, { allowNetwork: true }) });
    await controller.setMaster("p", true);
    get.resolve(view()); await loading;
    expect(controller.snapshot("p").view.allowNetwork).toBe(true);
    expect(controller.snapshot("p").view.revision).toBe(1);
    expect(controller.snapshot("other").view).toBeNull();
  });
  it("queued choices retain their owner and require review instead of overwriting an earlier grant", async () => {
    const { controller, adapters } = controllerFixture(); const first = deferred();
    adapters.writeView.mockReturnValue(first.promise);
    const a = controller.setMaster("p", true), b = controller.approve("p", "network", { type: "host", authority: "service.example:443" });
    await flushPromises(); expect(adapters.writeView).toHaveBeenCalledTimes(1);
    first.resolve({ view: view("p", 1, { allowNetwork: true }) });
    await a; await b;
    expect(adapters.writeView).toHaveBeenCalledTimes(1);
    expect(controller.snapshot("p").needsReview).toBe(true);
    expect(controller.snapshot("p").draft.intent.type).toBe("approve");
    expect(controller.snapshot("p").view.allowNetwork).toBe(true);
  });
  it("same revision under a changed source cannot authorize a stale confirmation", async () => {
    const { controller, adapters } = controllerFixture(); const captured = controller.snapshot("p").view;
    controller.reconcile({ plugins: [{ id: "p", runtime: { server: true }, permissions: view("p", 0, { requestSourceKey: "replacement", source: { key: "replacement", revision: 1, codeFingerprint: "B", settingsRevision: 0 } }) }] });
    await controller.approve("p", "network", { type: "host", authority: "service.example:443" }, captured);
    expect(adapters.writeView).not.toHaveBeenCalled();
    expect(controller.snapshot("p").needsReview).toBe(true);
    expect(controller.snapshot("p").draft.base.requestSourceKey).toBe("source");
  });
  it("unknown observation timeout retains the wire slot, blocks discard/handoff and accepts only its late acknowledgement", async () => {
    vi.useFakeTimers(); const { controller, adapters } = controllerFixture(); const wire = deferred();
    adapters.writeView.mockReturnValue(wire.promise);
    const mutation = controller.setMaster("p", true); await vi.advanceTimersByTimeAsync(101); await mutation;
    expect(controller.snapshot("p").unknown).toBe(true); expect(controller.snapshot("p").busy).toBe(true);
    expect(controller.discard("p")).toBe(false); expect(await controller.settle()).toBe(false);
    await controller.setMaster("p", false); expect(adapters.writeView).toHaveBeenCalledTimes(1);
    wire.resolve({ view: view("p", 1, { allowNetwork: true }) }); await flushPromises();
    expect(controller.snapshot("p").busy).toBe(false); expect(controller.snapshot("p").view.allowNetwork).toBe(true);
    expect(controller.snapshot("p").draft).toBeNull();
  });
  it("logout/auth scope prevents late pending requests or writes reopening another session", async () => {
    const { controller, adapters } = controllerFixture(); const pending = deferred(); adapters.readPending.mockReturnValue(pending.promise);
    const reading = controller.refreshPending(); controller.setSession("other-user", { active: false, canWrite: false });
    pending.resolve([{ id: "old", pluginId: "p", state: "pending" }]); await reading;
    expect(controller.pendingRequests.value).toEqual([]); expect(controller.snapshot("p").view).toBeNull();
  });
  it("cancel defers only that pending ID and keeps explicit selected choices", async () => {
    const request = { id: "r", pluginId: "p", state: "pending", kind: "network", scopes: [{ type: "host", authority: "service.example:443" }], source: view().source };
    const { controller, adapters } = controllerFixture(view("p", 0, { pendingRequests: [request] }));
    adapters.readPending.mockResolvedValue([request]); await controller.refreshPending();
    controller.editRequest(request, { allowNetwork: true }); controller.defer("r");
    expect(controller.nextRequest()).toBeNull(); expect(controller.requestChoices(request).allowNetwork).toBe(true);
    expect(adapters.decideRequest).not.toHaveBeenCalled(); expect(controller.hasWork()).toBe(true);
  });
  it("a rejected CAS preserves the choice until explicit current-status review and retry", async () => {
    const { controller, adapters } = controllerFixture();
    adapters.writeView.mockRejectedValueOnce({ response: { status: 409, data: { code: "permission_revision_conflict", detail: "Another browser changed the decision" } } });
    await controller.setMaster("p", true);
    expect(controller.snapshot("p").draft.intent).toEqual({ type: "master", value: true });
    expect(controller.snapshot("p").needsReview).toBe(true);
    expect(controller.snapshot("p").view.allowNetwork).toBe(false);
    const updated = view("p", 1, { approvedImports: [{ type: "host", authority: "code.example:443" }] });
    adapters.readView.mockResolvedValue(updated);
    adapters.writeView.mockResolvedValue({ view: view("p", 2, { ...updated, revision: 2, signature: "v2", allowNetwork: true }) });
    await controller.review("p");
    expect(adapters.writeView).toHaveBeenCalledTimes(1);
    await controller.retry("p");
    expect(adapters.writeView.mock.calls[1][1]).toMatchObject({ revision: 1, signature: "v1", allowNetwork: true, approvedImports: updated.approvedImports });
    expect(controller.snapshot("p").draft).toBeNull();
  });
  it("removed owners retain recovery choices but cannot accept writes or reopen late requests", async () => {
    const request = { id: "r", pluginId: "p", state: "pending", kind: "network", scopes: [{ type: "host", authority: "service.example:443" }], source: view().source };
    const { controller, adapters } = controllerFixture(view("p", 0, { pendingRequests: [request] }));
    adapters.writeView.mockRejectedValue({ response: { status: 409, data: { code: "permission_revision_conflict" } } });
    await controller.setMaster("p", true);
    controller.reconcile({ plugins: [] });
    adapters.readPending.mockResolvedValue([request]); await controller.refreshPending();
    expect(controller.nextRequest()).toBeNull();
    expect(controller.snapshot("p").writable).toBe(false);
    expect(controller.snapshot("p").draft.intent.value).toBe(true);
    expect(controller.recoveryIds()).toEqual(["p"]);
    await controller.setMaster("p", false);
    expect(adapters.writeView).toHaveBeenCalledTimes(1);
  });
});

describe("operator confirmation through the reusable Settings review", () => {
  async function reviewFixture(permissionView) {
    const { controller, adapters } = controllerFixture(permissionView);
    pluginCatalog.value = { policy: { revision: 0, signature: "policy", effectiveAutoEnable: true }, plugins: [{ id: "p", name: "P", enabled: true, status: "ready", runtime: { server: true }, permissions: permissionView, pages: [], blocking: { actions: [] } }] };
    wrapper = mount(SettingsModal, { attachTo: document.body, props: { modelValue: true, permissionController: controller, writable: true }, global: { directives: { focus: { mounted: el => el.focus() } } } });
    await wrapper.vm.openSettings("core:plugins"); await flushPromises();
    [...document.querySelectorAll("button")].find(el => el.textContent.trim() === "Review permissions").click(); await flushPromises();
    return { controller, adapters };
  }
  it("all-host approval requires a distinct topmost confirmation and Cancel grants nothing", async () => {
    const all = { type: "all" };
    const row = { kind: "network", scope: all, requested: true, approved: false, effective: false, approvalCoverage: [], sources: ["static"], blockedReasons: ["unapproved", "master-off"] };
    const { adapters } = await reviewFixture(view("p", 0, { requestedNetwork: [all], rows: [row] }));
    [...document.querySelectorAll('[data-permission-review] button')].find(el => el.textContent.trim() === "Approve").click(); await flushPromises();
    expect(document.querySelector('[data-modal-top=true]').textContent).toContain("Approve all hosts");
    expect(adapters.writeView).not.toHaveBeenCalled();
    [...document.querySelectorAll('[data-modal-top=true] button')].find(el => el.textContent.trim() === "Cancel").click(); await flushPromises();
    expect(adapters.writeView).not.toHaveBeenCalled();
    expect(document.querySelector('[data-permission-review]')).not.toBeNull();
  });
  it("deleting a covered host explicitly names broader grants and removes every covering approval only on confirmation", async () => {
    const all = { type: "all" }, exact = { type: "host", authority: "service.example:443" };
    const row = { kind: "network", scope: exact, requested: true, approved: true, effective: true, approvalCoverage: [all, exact], sources: ["static"], blockedReasons: [] };
    const { adapters } = await reviewFixture(view("p", 0, { allowNetwork: true, approvedNetwork: [all, exact], rows: [row] }));
    adapters.writeView.mockResolvedValue({ view: view("p", 1, { allowNetwork: true }) });
    [...document.querySelectorAll('[data-permission-review] button')].find(el => el.textContent.trim() === "Delete approval").click(); await flushPromises();
    expect(document.querySelector('[data-modal-top=true]').textContent).toContain("All hosts");
    expect(document.querySelector('[data-modal-top=true]').textContent).toContain("Other hosts covered");
    expect(adapters.writeView).not.toHaveBeenCalled();
    [...document.querySelectorAll('[data-modal-top=true] button')].find(el => el.textContent.trim() === "Confirm permission change").click(); await flushPromises();
    expect(adapters.writeView.mock.calls[0][1].approvedNetwork).toEqual([]);
  });
});
