import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import { createSettingsSession } from "../settingsSession.js";
import { createSettingsPageState } from "../settingsPageState.js";
import * as api from "../api.js";

vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  return { pluginCatalog: ref(null), refreshPluginRuntimeCatalog: vi.fn(),
    capturePluginCatalogOwnership: vi.fn(), acknowledgePluginPolicy: vi.fn() };
});
vi.mock("../api.js", () => ({
  getConfig: vi.fn(), postBrand: vi.fn(), getTree: vi.fn(),
  getPluginSettings: vi.fn(), putPluginSettings: vi.fn(),
  putPluginEnabled: vi.fn(), putPluginPolicy: vi.fn(),
  getPluginPermissions: vi.fn(), putPluginPermissions: vi.fn(),
  getPluginPermissionRequests: vi.fn(), decidePluginPermissionRequest: vi.fn(),
}));

const sessions = [];
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers(); vi.clearAllMocks(); });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const corePage = id => ({ id: `core:${id}`, owner: "core", group: "Settings", label: id });
const pluginPage = { id: "plugin:a:p", owner: "a", pageId: "p", group: "A", label: "Preferences", available: true,
  descriptor: { fields: [{ key: "folder", type: "folder", default: "" }, { key: "file", type: "file", default: "" }, { key: "limit", type: "number", min: 1, default: 2 }] } };
const folder = { key: "folder", type: "folder" }, file = { key: "file", type: "file" };
function fixture(options = {}) {
  const config = reactive({ authType: "none", brand: { name: "Brand" } });
  const writable = ref(true), visible = ref(false), token = ref(null);
  const catalog = ref({ plugins: [{ id: "a" }], policy: { revision: 0, signature: "p0", effectiveAutoEnable: true } });
  const pages = ref([corePage("appearance"), corePage("branding"), corePage("plugins"), pluginPage,
    { ...corePage("plugin-permissions:a"), permissionPluginId: "a" }]);
  const records = reactive({});
  const registry = { find: id => pages.value.find(page => page.id === id),
    read: vi.fn(async () => ({ values: { folder: "", file: "", limit: 2 }, revision: 0 })),
    commit: vi.fn(async (page, values, revision) => ({ values, revision: revision + 1 })) };
  const pageState = {
    snapshot: vi.fn(id => ({ page: registry.find(id), available: true, dirty: false, pending: false, canSave: true, ...records[id] })),
    pageIds: vi.fn(() => Object.keys(records)), recoveryPages: vi.fn(() => []), hasWork: vi.fn(() => false),
    settle: vi.fn(async () => true), resolveDeparture: vi.fn(async () => true), reconcile: vi.fn(), dispose: vi.fn(),
    load: vi.fn(async () => true), edit: vi.fn(), commit: vi.fn(),
  };
  const permissionRecords = reactive({ a: { view: { revision: 0 }, draft: null, busy: false } });
  const permissions = {
    snapshot: vi.fn(id => permissionRecords[id]),
    recoveryIds: vi.fn(() => Object.keys(permissionRecords).filter(id => permissionRecords[id].draft)),
    setSession: vi.fn(), reconcile: vi.fn(), hasWork: vi.fn(() => false), settle: vi.fn(async () => true),
    load: vi.fn(async () => true), retry: vi.fn(async () => true), discard: vi.fn(() => true), dispose: vi.fn(),
    approve: vi.fn(async () => true), remove: vi.fn(async () => true),
  };
  const core = { brandSnapshot: vi.fn(() => ({ name: config.brand.name })), keybindings: vi.fn(() => ({ id: "custom" })),
    hasWork: vi.fn(() => false), settle: vi.fn(async () => true), stopCapture: vi.fn(), dispose: vi.fn(),
    loadBrand: vi.fn(), discardBrand: vi.fn(() => true), saveBrand: vi.fn(async () => true), resetMessage: vi.fn(() => "Reset retained brand") };
  const inventory = { snapshot: vi.fn(() => ({ label: "Inventory", canRetry: true, canDiscard: true })),
    hasWork: vi.fn(() => false), settle: vi.fn(async () => true), resolveDeparture: vi.fn(async () => true),
    setEnabled: vi.fn(async () => true), setAutoEnable: vi.fn(async () => true), discard: vi.fn(() => true), dispose: vi.fn() };
  const factories = { createCore: vi.fn(() => core), createPages: vi.fn(() => pageState),
    createInventory: vi.fn(() => inventory), createPermissions: vi.fn(() => permissions) };
  let participant;
  const unregister = vi.fn(), registerParticipant = vi.fn((id, value) => { participant = value; return unregister; });
  const focus = vi.fn(), openAccess = vi.fn(), readPaths = vi.fn(async () => ({ folders: [], notes: [] }));
  const session = createSettingsSession({ config: () => config, writable: () => writable.value,
    applyBrand: fresh => { config.brand = fresh; }, isVisible: () => visible.value, setVisible: value => { visible.value = value; },
    token: () => token.value, focus, openAccess, catalog, pages, registry, readPaths,
    registerParticipant, ...factories, ...options });
  sessions.push(session);
  return { session, config, writable, visible, token, catalog, pages, records, registry, pageState: session.pageState,
    permissions, permissionRecords, core, inventory, factories, participant, unregister, registerParticipant, focus, openAccess, readPaths };
}

describe("Settings composition and ownership", () => {
  it("binds real transport defaults at the owner and supplies live brand/session adapters", async () => {
    const f = fixture();
    const core = f.factories.createCore.mock.calls[0][0], inventory = f.factories.createInventory.mock.calls[0][0];
    const permissions = f.factories.createPermissions.mock.calls[0][0];
    expect(core.writeBrand).toBe(api.postBrand);
    api.getConfig.mockResolvedValue({ brand: { name: "Fresh" } });
    expect(await core.readBrand()).toEqual({ name: "Fresh" });
    core.applyBrand({ name: "Applied" }); expect(core.getBrand()).toEqual({ name: "Applied" });
    expect(inventory.writeEnabled).toBe(api.putPluginEnabled); expect(inventory.writePolicy).toBe(api.putPluginPolicy);
    expect(inventory.getCatalog()).toEqual(f.catalog.value);
    expect(inventory.getSession()).toBe("none:anonymous");
    f.config.authType = "password"; f.token.value = "new-token";
    expect(inventory.getSession()).toBe("password:new-token");
    expect(permissions).toMatchObject({ readView: api.getPluginPermissions, writeView: api.putPluginPermissions,
      readPending: api.getPluginPermissionRequests, decideRequest: api.decidePluginPermissionRequest });
    expect(f.registerParticipant).toHaveBeenCalledWith("settings", f.participant);
    f.writable.value = false; await nextTick();
    expect(core.writable()).toBe(false);
    expect(f.permissions.setSession).toHaveBeenLastCalledWith("settings", { active: true, canWrite: false });
  });
  it("reconciles catalogue/registry changes and stops both watches on disposal", async () => {
    const f = fixture();
    expect(f.permissions.reconcile).toHaveBeenCalledWith(f.catalog.value);
    f.catalog.value = { plugins: [] }; f.pages.value = [...f.pages.value]; await nextTick();
    expect(f.pageState.reconcile).toHaveBeenCalledOnce();
    expect(f.permissions.reconcile).toHaveBeenCalledTimes(2);
    f.session.dispose(); f.catalog.value = null; f.pages.value = []; await nextTick();
    expect(f.permissions.reconcile).toHaveBeenCalledTimes(2); expect(f.pageState.reconcile).toHaveBeenCalledOnce();
    expect(f.unregister).toHaveBeenCalledOnce();
    for (const owner of [f.inventory, f.pageState, f.core, f.permissions]) expect(owner.dispose).toHaveBeenCalledOnce();
    sessions.pop();
  });
  it("keeps an injected permission controller's session and lifetime with its caller", async () => {
    const outer = fixture(); const permissions = outer.permissions;
    permissions.setSession.mockClear(); permissions.dispose.mockClear();
    const inner = fixture({ permissionController: permissions });
    expect(inner.session.permissions).toBe(permissions); expect(inner.factories.createPermissions).not.toHaveBeenCalled();
    inner.writable.value = false; await nextTick();
    inner.session.dispose(); sessions.pop();
    expect(permissions.setSession).not.toHaveBeenCalled(); expect(permissions.dispose).not.toHaveBeenCalled();
    expect(permissions.reconcile).toHaveBeenCalledWith(inner.catalog.value);
  });
  it.each([["none", false], ["password", true], ["totp", true], ["unknown", false]])("derives account availability for %s", (type, expected) => {
    const f = fixture(); f.config.authType = type; expect(f.session.state.canLogout).toBe(expected);
  });
  it("groups current and retained recovery pages by stable ID, preferring the recovery record", () => {
    const f = fixture();
    f.pageState.recoveryPages.mockReturnValue([{ ...pluginPage, label: "Retained" }, { id: "removed", group: "Removed", label: "Recovery" }]);
    expect(f.session.state.groupedPages.map(group => group.name)).toEqual(["Settings", "A", "Removed"]);
    expect(f.session.state.groupedPages[1].pages).toEqual([{ ...pluginPage, label: "Retained" }]);
    expect(f.session.state.currentSnapshot.writable).toBe(true);
    expect(f.session.state.brandingSnapshot).toEqual({ name: "Brand" });
    expect(f.session.state.keybindingSnapshot).toEqual({ id: "custom" });
  });
});

describe("Settings page and close orchestration", () => {
  it("opens/focuses idempotently and loads plugin pages without changing visible state on repeated opens", async () => {
    const f = fixture();
    await f.session.openSettings("plugin:a:p");
    expect(f.visible.value).toBe(true); expect(f.focus).not.toHaveBeenCalled();
    expect(f.pageState.load.mock.calls).toEqual([["plugin:a:p"], ["plugin:a:p"]]);
    await f.session.openSettings("plugin:a:p");
    expect(f.focus).toHaveBeenCalledOnce(); expect(f.pageState.load).toHaveBeenCalledTimes(3);
    expect(f.inventory.resolveDeparture).toHaveBeenCalledTimes(1);
  });
  it("ignores an unknown open target and leaves the selected page intact", async () => {
    const f = fixture(); await f.session.openSettings("unknown");
    expect(f.visible.value).toBe(true); expect(f.session.state.currentPageId).toBe("core:appearance");
    expect(f.pageState.load).not.toHaveBeenCalled();
  });
  it("loads branding and permission owners only at their respective page entries", async () => {
    const f = fixture();
    await f.session.selectPage("core:branding"); expect(f.core.loadBrand).toHaveBeenCalledOnce();
    await f.session.selectPage("core:plugin-permissions:a");
    expect(f.permissions.load).toHaveBeenCalledWith("a");
    expect(f.session.state.permissionSnapshot).toMatchObject({ view: { revision: 0 } });
    expect(f.pageState.load).not.toHaveBeenCalled();
  });
  it.each(["inventory", "pageState", "core"])("a rejected %s departure preserves the current page and visibility", async owner => {
    const f = fixture(); f.visible.value = true;
    if (owner === "core") { f.core.hasWork.mockReturnValue(true); f.core.settle.mockResolvedValue(false); }
    else f[owner].resolveDeparture.mockResolvedValue(false);
    await f.session.openSettings("plugin:a:p");
    expect(f.session.state.currentPageId).toBe("core:appearance"); expect(f.visible.value).toBe(true);
    expect(f.pageState.load).not.toHaveBeenCalled(); expect(f.focus).not.toHaveBeenCalled();
    expect(f.core.stopCapture).not.toHaveBeenCalled();
  });
  it("orders page departure as inventory, current draft, permission recovery, then branding", async () => {
    const f = fixture(); await f.session.selectPage("core:plugin-permissions:a");
    const order = [];
    f.inventory.resolveDeparture.mockImplementation(async () => { order.push("inventory"); return true; });
    f.pageState.resolveDeparture.mockImplementation(async () => { order.push("page"); return true; });
    f.permissionRecords.a.draft = {}; f.permissions.retry.mockImplementation(async () => { order.push("permission"); return true; });
    f.core.hasWork.mockReturnValue(true); f.core.discardBrand.mockImplementation(() => { order.push("brand"); return true; });
    const selecting = f.session.selectPage("core:appearance"); await flushPromises();
    expect(order).toEqual(["inventory", "page"]);
    f.session.decideDeparture("save"); await flushPromises();
    expect(f.session.state.departureMessage).toContain("Branding");
    f.session.decideDeparture("discard"); expect(await selecting).toBe(true);
    expect(order).toEqual(["inventory", "page", "permission", "brand"]);
  });
  it("close resolves every retained page before hiding or opening Access", async () => {
    const f = fixture(); f.visible.value = true; f.records[pluginPage.id] = {};
    f.inventory.resolveDeparture.mockResolvedValue(false); await f.session.openAccess();
    expect(f.openAccess).not.toHaveBeenCalled(); expect(f.visible.value).toBe(true);
    f.inventory.resolveDeparture.mockResolvedValue(true); await f.session.openAccess();
    expect(f.pageState.resolveDeparture).toHaveBeenCalledWith([pluginPage.id], "closing Settings");
    expect(f.visible.value).toBe(false); expect(f.openAccess).toHaveBeenCalledOnce(); expect(f.core.stopCapture).toHaveBeenCalledOnce();
  });
  it("reload resolves only the current draft and does not reload a cancelled decision", async () => {
    const f = fixture(); await f.session.selectPage(pluginPage.id); f.pageState.load.mockClear();
    f.pageState.resolveDeparture.mockResolvedValue(false); await f.session.reloadCurrentPage();
    expect(f.pageState.load).not.toHaveBeenCalled();
    f.pageState.resolveDeparture.mockResolvedValue(true); await f.session.reloadCurrentPage();
    expect(f.pageState.resolveDeparture).toHaveBeenLastCalledWith([pluginPage.id], "reloading");
    expect(f.pageState.load).toHaveBeenCalledWith(pluginPage.id);
  });
  it("prepares plugin disable with only that plugin's pages, then its permissions", async () => {
    const f = fixture(); f.records[pluginPage.id] = {}; f.records["other"] = { page: { owner: "b" } };
    const prepare = f.factories.createInventory.mock.calls[0][0].prepareDisable;
    expect(await prepare("a")).toBe(true);
    expect(f.pageState.resolveDeparture).toHaveBeenCalledWith([pluginPage.id], "disabling plugin");
    f.pageState.resolveDeparture.mockResolvedValue(false); f.permissions.snapshot.mockClear();
    expect(await prepare("a")).toBe(false); expect(f.permissions.snapshot).not.toHaveBeenCalled();
  });
  it("forwards enablement and inverse auto-enable against the current policy", async () => {
    const f = fixture(); await f.session.togglePlugin({ id: "a" }, false); await f.session.toggleAutoEnable();
    expect(f.inventory.setEnabled).toHaveBeenCalledWith("a", false, f.catalog.value.policy);
    expect(f.inventory.setAutoEnable).toHaveBeenCalledWith(false, f.catalog.value.policy);
  });
});

describe("aggregated session participant and departure decisions", () => {
  it.each(["inventory", "pageState", "permissions", "core"])("includes %s in unsaved work", owner => {
    const f = fixture(); expect(f.participant.hasUnsavedChanges()).toBe(false);
    f[owner].hasWork.mockReturnValue(true); expect(f.participant.hasUnsavedChanges()).toBe(true);
  });
  it.each(["inventory", "pageState", "permissions", "core"])("stops settlement when %s fails", async owner => {
    const f = fixture(), owners = ["inventory", "pageState", "permissions", "core"];
    f[owner].settle.mockResolvedValue(false); expect(await f.participant.settlePending()).toBe(false);
    for (const later of owners.slice(owners.indexOf(owner) + 1)) expect(f[later].settle).not.toHaveBeenCalled();
  });
  it("aggregates all retained labels/capabilities and shares a pending decision without replacing it", async () => {
    const f = fixture(); f.records[pluginPage.id] = { dirty: true, canSave: false };
    f.permissionRecords.a.draft = {}; f.core.hasWork.mockReturnValue(true); f.inventory.hasWork.mockReturnValue(true);
    const first = f.participant.requestDecision("logout"), second = f.participant.requestDecision("other reason");
    expect(first).toBe(second); expect(f.session.state.departureCanSave).toBe(false);
    expect(f.session.state.departureMessage).toContain("before logout. Preferences, Server permissions: a, Branding, Inventory.");
    f.session.setDepartureVisible(false); expect(f.session.state.departureVisible).toBe(false);
    f.session.decideDeparture("cancel"); expect(await first).toBe("cancel");
    const third = f.participant.requestDecision("Access"); expect(third).not.toBe(first);
    f.session.decideDeparture("discard"); expect(await third).toBe("discard");
  });
  it.each(["save", "discard"])("applies one confirmed %s decision in controller order without asking again", async decision => {
    const f = fixture(), order = [];
    f.records[pluginPage.id] = { dirty: true }; f.permissionRecords.a.draft = {}; f.core.hasWork.mockReturnValue(true);
    f.inventory.resolveDeparture.mockImplementation(async (...args) => { order.push(["inventory", ...args]); return true; });
    f.pageState.resolveDeparture.mockImplementation(async (...args) => { order.push(["page", ...args]); return true; });
    f.permissions.retry.mockImplementation(async id => { order.push(["permission", id]); return true; });
    f.permissions.discard.mockImplementation(id => { order.push(["permission", id]); return true; });
    f.core.saveBrand.mockImplementation(async () => { order.push(["brand"]); f.core.hasWork.mockReturnValue(false); return true; });
    f.core.discardBrand.mockImplementation(() => { order.push(["brand"]); return true; });
    expect(await f.participant[decision]()).toBe(true);
    expect(order).toEqual([["inventory", "session handoff", decision], ["page", [pluginPage.id], "session handoff", decision], ["permission", "a"], ["brand"]]);
    expect(f.session.state.departureVisible).toBe(false);
  });
  it("permission review cannot close while its wire fails settlement or its decision is cancelled", async () => {
    const f = fixture(); await f.session.openPermissionReview("a");
    expect(f.session.state.reviewSnapshot.view.revision).toBe(0);
    f.permissionRecords.a.busy = true; f.permissions.settle.mockResolvedValue(false);
    expect(await f.session.closePermissionReview()).toBe(false); expect(f.session.state.reviewPluginId).toBe("a");
    f.permissionRecords.a.busy = false; f.permissionRecords.a.draft = {};
    const closing = f.session.closePermissionReview(); await flushPromises();
    expect(f.session.state.departureCanSave).toBe(true); f.session.decideDeparture("cancel");
    expect(await closing).toBe(false); expect(f.session.state.reviewPluginId).toBe("a");
    const retry = f.session.closePermissionReview(); await flushPromises(); f.session.decideDeparture("retry");
    expect(await retry).toBe(true); expect(f.permissions.retry).toHaveBeenCalledWith("a");
    expect(f.session.state.reviewPluginId).toBeNull();
  });
  it("permission retries stop on failure and branding saves must leave the owner clean", async () => {
    const f = fixture(); f.permissionRecords.a.draft = {}; f.permissions.retry.mockResolvedValue(false);
    expect(await f.participant.save()).toBe(false); expect(f.core.settle).not.toHaveBeenCalled();
    f.permissionRecords.a.draft = null; f.core.hasWork.mockReturnValue(true);
    expect(await f.participant.save()).toBe(false); expect(f.core.saveBrand).toHaveBeenCalledOnce();
  });
  it("retains invalid raw drafts on cancelled close and commits only explicit valid departure through the real page owner", async () => {
    const f = fixture({ createPages: createSettingsPageState });
    await f.session.selectPage(pluginPage.id); f.pageState.edit(pluginPage.id, "limit", "invalid");
    const closing = f.session.requestClose(); await flushPromises();
    expect(f.session.state.departureCanSave).toBe(false); f.session.decideDeparture("cancel");
    expect(await closing).toBe(false); expect(f.pageState.snapshot(pluginPage.id).drafts.limit).toBe("invalid");
    expect(f.registry.commit).not.toHaveBeenCalled();
    f.pageState.edit(pluginPage.id, "limit", "7");
    const saving = f.session.requestClose(); await flushPromises(); f.session.decideDeparture("save");
    expect(await saving).toBe(true);
    expect(f.registry.commit).toHaveBeenCalledWith(expect.objectContaining({ id: pluginPage.id }), { folder: "", file: "", limit: 7 }, 0);
    expect(f.pageState.snapshot(pluginPage.id).committed.limit).toBe(7);
    expect(f.pageState.hasWork()).toBe(false);
  });
});

describe("risk decisions retain their captured permission view", () => {
  const all = { type: "all" }, exact = { type: "host", authority: "example.test:443" };
  it("exact approval needs no broad prompt; all-host cancellation grants nothing", async () => {
    const f = fixture(); await f.session.approveScope("a", "network", exact);
    expect(f.permissions.approve).toHaveBeenCalledWith("a", "network", exact, f.permissionRecords.a.view);
    f.permissions.approve.mockClear(); const approval = f.session.approveScope("a", "imports", all);
    expect(f.session.state.riskTitle).toBe("Approve all hosts"); expect(f.session.state.riskMessage).toContain("remote-code imports");
    f.session.resolveRisk(false); expect(await approval).toBe(false); expect(f.permissions.approve).not.toHaveBeenCalled();
  });
  it("confirmation forwards the pre-prompt view for the permission owner's stale-CAS check", async () => {
    const f = fixture(), captured = f.permissionRecords.a.view;
    const approval = f.session.approveScope("a", "network", all);
    f.permissionRecords.a.view = { revision: 1 };
    f.session.setRiskVisible(false); f.session.resolveRisk(true); expect(await approval).toBe(true);
    expect(f.permissions.approve).toHaveBeenCalledWith("a", "network", all, captured);
  });
  it("rejects a second risk prompt without displacing the first", async () => {
    const f = fixture(); const approval = f.session.approveScope("a", "network", all);
    expect(await f.session.discardPermission("a")).toBe(false);
    expect(f.session.state.riskTitle).toBe("Approve all hosts"); expect(f.permissions.discard).not.toHaveBeenCalled();
    f.session.resolveRisk(true); expect(await approval).toBe(true);
  });
  it("names and deletes covering grants only after explicit approval", async () => {
    const f = fixture(); const deletion = f.session.deleteScope("a", "network", { scope: exact, approvalCoverage: [all, exact] });
    expect(f.session.state.riskTitle).toBe("Remove covering approvals");
    expect(f.session.state.riskMessage).toContain("All hosts, example.test:443");
    expect(f.permissions.remove).not.toHaveBeenCalled(); f.session.resolveRisk(true); expect(await deletion).toBe(true);
    expect(f.permissions.remove).toHaveBeenCalledWith("a", "network", [all, exact], f.permissionRecords.a.view);
  });
  it("deletes an exact-only approval directly", async () => {
    const f = fixture(); await f.session.deleteScope("a", "imports", { scope: exact, approvalCoverage: [exact] });
    expect(f.session.state.riskVisible).toBe(false); expect(f.permissions.remove).toHaveBeenCalledWith("a", "imports", [exact], f.permissionRecords.a.view);
  });
  it("permission/inventory discards and branding resets retain explicit risk decisions and captions", async () => {
    const f = fixture(); const permission = f.session.discardPermission("a");
    f.session.resolveRisk(true); expect(await permission).toBe(true); expect(f.permissions.discard).toHaveBeenCalledWith("a");
    const inventory = f.session.discardInventoryChoice(); expect(f.session.state.riskMessage).toContain("does not undo a committed request");
    f.session.resolveRisk(false); expect(await inventory).toBe(false); expect(f.inventory.discard).not.toHaveBeenCalled();
    const reset = f.session.resetCoreBranding();
    expect(f.session.state.riskConfirmText).toBe("Reset"); expect(f.session.state.riskConfirmStyle).toBe("danger");
    expect(f.session.state.riskMessage).toBe("Reset retained brand"); f.session.resolveRisk(true); await reset;
    expect(f.core.saveBrand).toHaveBeenCalledWith(true);
    const discard = f.session.discardInventoryChoice(); expect(f.session.state.riskConfirmStyle).toBe("cta");
    f.session.resolveRisk(true); expect(await discard).toBe(true); expect(f.inventory.discard).toHaveBeenCalledOnce();
  });
  it("does not prompt when an inventory choice cannot be discarded", async () => {
    const f = fixture(); f.inventory.snapshot.mockReturnValue({ canDiscard: false });
    expect(await f.session.discardInventoryChoice()).toBe(false); expect(f.session.state.riskVisible).toBe(false);
  });
  it("disposal cancels both pending decisions and unregisters the participant", async () => {
    const f = fixture(); const departure = f.participant.requestDecision("logout");
    const risk = f.session.approveScope("a", "network", all); f.session.dispose(); sessions.pop();
    expect(await departure).toBe("cancel"); expect(await risk).toBe(false); expect(f.unregister).toHaveBeenCalledOnce();
    expect(f.permissions.approve).not.toHaveBeenCalled();
  });
});

describe("ticketed host path chooser", () => {
  const tree = { folders: [{ name: "Folder", path: "nested/Folder" }], notes: [{ title: "Title", path: "nested/Note" }] };
  it.each([[folder, [{ path: "nested/Folder", label: "Folder", directory: true }]],
    [file, [{ path: "nested/Folder", label: "Folder", directory: true }, { path: "nested/Note.md", label: "Title.md", directory: false }]]])("projects host entries for $type", async (field, entries) => {
    const f = fixture(); f.readPaths.mockResolvedValue(tree); await f.session.browseField(pluginPage.id, field);
    expect(f.session.state.pathEntries).toEqual(entries); expect(f.readPaths).toHaveBeenCalledWith("");
    await f.session.loadPathChoices("nested"); expect(f.session.state.pathChoice.root).toBe("nested");
    expect(f.session.parentPath("nested/Folder")).toBe("nested"); expect(f.session.parentPath("nested")).toBe("");
  });
  it.each(["readonly", "unavailable"])("does not start browsing a %s field", async mode => {
    const f = fixture(); if (mode === "readonly") f.writable.value = false; else f.records[pluginPage.id] = { available: false };
    await f.session.browseField(pluginPage.id, folder); expect(f.readPaths).not.toHaveBeenCalled(); expect(f.session.state.pathChoice).toBeNull();
  });
  it("fences superseded successes and errors without overwriting current entries or errors", async () => {
    const f = fixture(), old = deferred(), current = deferred();
    f.readPaths.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const browsing = f.session.browseField(pluginPage.id, folder), next = f.session.loadPathChoices("nested");
    current.resolve(tree); await next; old.reject(Error("stale")); await browsing;
    expect(f.session.state.pathChoice.root).toBe("nested"); expect(f.session.state.pathChoiceError).toBe("");
    expect(f.session.state.pathEntries[0].path).toBe("nested/Folder");
    const stale = deferred(); f.readPaths.mockResolvedValue(tree).mockReturnValueOnce(stale.promise); const loading = f.session.loadPathChoices("old");
    await f.session.loadPathChoices("new"); stale.resolve({ folders: [], notes: [] }); await loading;
    expect(f.session.state.pathChoice.root).toBe("new"); expect(f.session.state.pathEntries).toHaveLength(1);
  });
  it("closing/reopening or disposing retires an earlier chooser response", async () => {
    const f = fixture(), old = deferred(); f.readPaths.mockReturnValueOnce(old.promise);
    const browsing = f.session.browseField(pluginPage.id, folder); f.session.closePathChoice();
    f.readPaths.mockResolvedValue(tree); await f.session.browseField(pluginPage.id, file);
    old.resolve({ folders: [], notes: [] }); await browsing; expect(f.session.state.pathEntries).toHaveLength(2);
    const pending = deferred(); f.readPaths.mockReturnValueOnce(pending.promise); const loading = f.session.loadPathChoices("pending");
    f.session.dispose(); sessions.pop(); pending.resolve(tree); await loading;
    expect(f.session.state.pathChoice).toBeNull(); expect(f.session.state.pathEntries).toEqual([]);
  });
  it("reports its five-second observation deadline and does not adopt the late response", async () => {
    vi.useFakeTimers(); const f = fixture(), wire = deferred(); f.readPaths.mockReturnValue(wire.promise);
    const browsing = f.session.browseField(pluginPage.id, folder);
    await vi.advanceTimersByTimeAsync(5000); await browsing;
    expect(f.session.state.pathChoiceError).toBe("Host path choices could not be loaded within the deadline.");
    expect(vi.getTimerCount()).toBe(0); wire.resolve(tree); await flushPromises();
    expect(f.session.state.pathEntries).toEqual([]); expect(f.session.state.pathChoice).not.toBeNull();
  });
  it("selects the captured page/field, starts its commit and closes the chooser", async () => {
    const f = fixture(); await f.session.browseField(pluginPage.id, file); f.session.selectPath("nested/Note.md");
    expect(f.pageState.edit).toHaveBeenCalledWith(pluginPage.id, "file", "nested/Note.md");
    expect(f.pageState.commit).toHaveBeenCalledWith(pluginPage.id, "file"); expect(f.session.state.pathChoice).toBeNull();
  });
  it.each(["readonly", "unavailable", "changedDescriptor"])("rechecks %s before selecting without losing the chooser", async mode => {
    const f = fixture(); await f.session.browseField(pluginPage.id, folder);
    if (mode === "readonly") f.writable.value = false;
    else f.records[pluginPage.id] = { [mode === "unavailable" ? "available" : mode]: mode !== "unavailable" };
    f.session.selectPath("nested"); expect(f.pageState.edit).not.toHaveBeenCalled(); expect(f.pageState.commit).not.toHaveBeenCalled();
    expect(f.session.state.pathChoice).not.toBeNull();
  });
});
