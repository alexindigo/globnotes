import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import { createSettingsSession } from "../settingsSession.js";
import { createSettingsPageState } from "../settingsPageState.js";
import { createAttentionRegistry } from '../attention.js';
import * as api from "../api.js";

vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  return { pluginCatalog: ref(null), refreshPluginRuntimeCatalog: vi.fn(),
    capturePluginCatalogOwnership: vi.fn(), acknowledgePluginPolicy: vi.fn() };
});
vi.mock("../api.js", () => ({
  getConfig: vi.fn(), getAccessSettings:vi.fn(), postBrand: vi.fn(), getTree: vi.fn(),
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
const corePage = id => ({ id: `core:${id}`, owner: "core", group: id === "appearance" ? "browser" : "vault", label: id,
  kind:id === "appearance" ? "browser-pref" : id === "branding" ? "branding" : id === "plugins" ? "plugins" : "unsupported" });
const pluginPage = { id: "plugin:a:p", owner: "a", pageId: "p", group: "plugin", kind:"plugin-page", plugin:{id:"a",name:"A"}, label: "Preferences", available: true,
  descriptor: { fields: [{ key: "folder", type: "folder", default: "" }, { key: "file", type: "file", default: "" }, { key: "limit", type: "number", min: 1, default: 2 }] } };
const folder = { key: "folder", type: "folder" }, file = { key: "file", type: "file" };
function fixture(options = {}) {
  const attentionRegistry=options.attentionRegistry ?? createAttentionRegistry();
  const config = reactive({ authType: "none", brand: { name: "Brand" } });
  const writable = ref(true), visible = ref(false), token = ref(null);
  const catalog = ref({ plugins: [{ id: "a" }], policy: { revision: 0, signature: "p0", effectiveAutoEnable: true } });
  const pages = ref([corePage("appearance"), corePage("branding"), corePage("plugins"), pluginPage]);
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
  const permissionRecords = reactive({ a: { plugin:{id:"a",name:"A"}, available:true, hasServer:true, view: { revision: 0 }, draft: null, busy: false } });
  const permissions = {
    snapshot: vi.fn(id => permissionRecords[id] ?? {available:false,hasServer:false,plugin:null}),
    permissionView: vi.fn(id => ({ id, requests:[], network:[], imports:[], allowNetwork:false,
      recovery:permissionRecords[id]?.draft ? {text:"Retained permission choice"} : null })),
    recoveryIds: vi.fn(() => Object.keys(permissionRecords).filter(id => permissionRecords[id].draft)),
    setSession: vi.fn(), reconcile: vi.fn(), hasWork: vi.fn(() => false), settle: vi.fn(async () => true),
    load: vi.fn(async () => true), retry: vi.fn(async () => true), discard: vi.fn(() => true), dispose: vi.fn(),
    approve: vi.fn(async () => true), remove: vi.fn(async () => true),
  };
  const core = { appearance:vi.fn(()=>({})), brandSnapshot: vi.fn(() => ({ name: config.brand.name })), keybindings: vi.fn(() => ({ id: "custom" })),
    hasWork: vi.fn(() => false), settle: vi.fn(async () => true), stopCapture: vi.fn(), dispose: vi.fn(),
    loadBrand: vi.fn(), discardBrand: vi.fn(() => true), saveBrand: vi.fn(async () => true), resetMessage: vi.fn(() => "Reset retained brand") };
  const inventory = { snapshot: vi.fn(() => ({ label: "Inventory", canMutate:true, canRetry: true, canDiscard: true })),
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
    registerParticipant, attentionRegistry, ...factories, ...options });
  sessions.push(session);
  return { session, config, writable, visible, token, catalog, pages, records, registry, pageState: session.pageState,
    permissions, permissionRecords, core, inventory, attentionRegistry, factories, participant, unregister, registerParticipant, focus, openAccess, readPaths };
}

describe("Settings composition and ownership", () => {
  it('r2 B1 refreshes the account on reopen and clears a previous login immediately', async () => {
    const readAccess=vi.fn(async()=>({mode:'password',username:'alice',settingsWritable:true}));
    const f=fixture({readAccess}); f.pages.value.push({...corePage('account'),kind:'account'});
    f.config.authType='password'; f.token.value='alice-token';
    await f.session.openSettings('core:account'); expect(f.session.state.accountName).toBe('alice');
    await f.session.requestClose(); f.config.authType='none'; f.token.value=null; await nextTick();
    expect(f.session.state.accountName).not.toContain('alice');
    f.config.authType='password'; f.token.value='bob-token'; await nextTick();
    readAccess.mockResolvedValue({mode:'password',username:'bob',settingsWritable:true});
    await f.session.openSettings(); expect(f.session.state.accountName).toBe('bob');
    expect(readAccess).toHaveBeenCalledTimes(2);
  });
  it('r2 B1 invalidates an Access revision and fences a held old-session summary', async () => {
    const old=deferred(),readAccess=vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({mode:'read_only',settingsWritable:false});
    const f=fixture({readAccess}); f.pages.value.push({...corePage('access'),kind:'access'});
    const opening=f.session.openSettings('core:access'); await flushPromises();
    f.config.accessRevision=2; await nextTick();
    old.resolve({mode:'none',settingsWritable:true}); await opening;
    await f.session.openSettings();
    expect(f.session.state.accessSummary.rows[0].value).toBe('Read-only');
  });
  it('r2 B1 clears identity at reopen even when the token adapter is nonreactive', async () => {
    let stored='alice-token'; const next=deferred();
    const readAccess=vi.fn().mockResolvedValueOnce({mode:'password',username:'alice',settingsWritable:true}).mockReturnValueOnce(next.promise);
    const f=fixture({token:()=>stored,readAccess}); f.config.authType='password'; f.pages.value.push({...corePage('account'),kind:'account'});
    await f.session.openSettings('core:account'); await f.session.requestClose();
    stored='bob-token'; const opening=f.session.openSettings();
    expect(f.session.state.accountName).toBe('');
    next.resolve({mode:'password',username:'bob',settingsWritable:true});await opening;
    expect(f.session.state.accountName).toBe('bob');
  });
  it.each(['loading','visible'])('r2 B1 refreshes an admitted summary identity while %s', async phase => {
    const old=deferred(),alice={mode:'password',username:'alice',settingsWritable:true},bob={...alice,username:'bob'};
    const readAccess=vi.fn().mockReturnValueOnce(phase==='loading'?old.promise:Promise.resolve(alice)).mockResolvedValue(bob);
    const f=fixture({readAccess});f.config.authType='password';f.token.value='current-user';f.pages.value.push({...corePage('account'),kind:'account'});
    const opening=f.session.openSettings('core:account');await flushPromises();
    f.config.accessRevision=1;await nextTick();
    if(phase==='loading')old.resolve(alice);
    await opening;await flushPromises();
    expect(f.session.state.accountName).toBe('bob');expect(f.session.state.accountSummary.text).toBe('Signed in as bob');
    expect(readAccess).toHaveBeenCalledTimes(2);expect(f.registry.commit).not.toHaveBeenCalled();
  });
  it('r2 B2 postponed edited requests outside the expanded owner do not guard page switching', async () => {
    const f=fixture(); await f.session.selectPage('core:plugins');
    f.permissions.recoveryIds.mockReturnValue(['a']); // request draft, not a permission-policy draft
    const selecting=f.session.selectPage('core:appearance'); await flushPromises();
    expect(f.session.state.departureVisible).toBe(false);
    expect(await selecting).toBe(true); expect(f.permissions.discard).not.toHaveBeenCalled();
  });
  it('r2 B4 retains a retired inventory intent owner and its recovery controls', () => {
    const f=fixture(); f.inventory.snapshot.mockReturnValue({intent:{type:'enabled',id:'retired',value:false},canDiscard:true,canReview:true,canRetry:false});
    const row=f.session.state.pluginRows.find(row=>row.id==='retired');
    expect(row).toMatchObject({id:'retired',canToggle:false,recovery:{canDiscard:true,canReview:true}});
    expect(f.inventory.discard).not.toHaveBeenCalled();
  });
  it('r2 B6 qualifies a disabled blocking plugin rather than claiming active hooks', () => {
    const f=fixture(); f.catalog.value.plugins[0]={id:'a',name:'A',enabled:false,blocking:{active:false,actions:['save']}};
    expect(f.session.state.pluginRows[0].attention.find(item=>item.key==='blocking').text).toBe('Can block when on: save');
  });
  it.each(['missing','browser-only'])('r2 B12 legacy links do not expand or load a %s owner', async kind => {
    const f=fixture(); if(kind==='browser-only')f.permissionRecords.a.hasServer=false;
    await f.session.openSettings(`core:plugin-permissions:${kind==='missing'?'unknown':'a'}`);
    expect(f.session.state.currentPageId).toBe('core:plugins');
    expect(f.session.state.expandedPluginId ?? f.session.state.expansionRequest?.id ?? null).toBeNull(); expect(f.permissions.load).not.toHaveBeenCalled();
  });
  it('Branding Cancel is scoped to the Branding owner and preserves other retained work', async () => {
    const f=fixture(); f.core.hasWork.mockReturnValue(true); f.records[pluginPage.id]={dirty:true};
    expect(typeof f.session.cancelBranding).toBe('function');
    expect(await f.session.cancelBranding()).toBe(true);
    expect(f.core.discardBrand).toHaveBeenCalledOnce();
    expect(f.pageState.resolveDeparture).not.toHaveBeenCalled(); expect(f.inventory.resolveDeparture).not.toHaveBeenCalled();
    expect(f.records[pluginPage.id].dirty).toBe(true); expect(f.visible.value).toBe(false);
  });
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
    f.records[pluginPage.id] = { dirty: true, page: { ...pluginPage, label: "Retained" } };
    const removed = { ...pluginPage, id:"plugin:gone:x", owner:"gone", plugin:{id:"gone",name:"Removed"}, label:"Recovery" };
    f.records[removed.id] = { dirty: true, page:removed };
    expect(f.session.state.groupedPages.map(group => group.label)).toEqual(["This browser", "This vault", "Plugin settings"]);
    expect(f.session.state.groupedPages[2].pages[0].pages).toEqual([{ ...pluginPage, label: "Retained" }]);
    expect(f.session.state.groupedPages[2].pages[1].pages).toEqual([removed]);
    expect(f.session.state.currentSnapshot.writable).toBe(true);
    expect(f.session.state.brandingSnapshot).toEqual({ name: "Brand" });
    expect(f.session.state.keybindingSnapshot).toEqual({ id: "custom" });
  });
});

describe("app version label", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  it("shows the version with the short revision when the build supplies one", () => {
    const f = fixture(); f.config.version = "2.3.2"; f.config.revision = revision;
    expect(f.session.state.versionLabel).toBe("v2.3.2 (0123456)");
  });
  it("marks a build without a revision as a development build", () => {
    const f = fixture(); f.config.version = "2.3.2"; f.config.revision = null;
    expect(f.session.state.versionLabel).toBe("v2.3.2-dev");
  });
  it("is empty without a version", () => {
    const f = fixture(); f.config.revision = revision;
    expect(f.session.state.versionLabel).toBe("");
  });
});

describe("Settings page projection", () => {
  // Entries group by scope and owner; all normalized pages remain in tab order.
  const ids = f => f.session.state.groupedPages.flatMap(group => group.pages.flatMap(entry => entry.pages.map(page => page.id)));
  const second = { ...pluginPage, id: "plugin:a:q", pageId: "q", label: "Second" };
  const registryIds = ["core:appearance", "core:branding", "core:plugins", "plugin:a:p", "plugin:a:q"];
  const withSecond = () => { const f = fixture(); f.pages.value = [...f.pages.value, second]; return f; };
  it("keeps registry order when nothing is retained, ignoring clean records", () => {
    const f = withSecond(); f.records[pluginPage.id] = { page: { ...pluginPage, label: "Clean record" } };
    expect(ids(f)).toEqual(registryIds);
    expect(f.session.state.groupedPages[2].pages[0].pages).toEqual([pluginPage, second]);
    expect(f.session.state.inventoryPages.a).toEqual([pluginPage, second]);
  });
  it.each(["dirty", "pending", "uncertain", "changedDescriptor"])("a %s page replaces its ID in place with the captured definition", flag => {
    const f = withSecond(), captured = { ...pluginPage, label: "Captured" };
    f.records[pluginPage.id] = { [flag]: flag === "uncertain" ? { limit: 3 } : true, page: captured };
    expect(ids(f)).toEqual(registryIds);
    expect(f.session.state.groupedPages.find(group => group.id === "plugin").pages[0].pages).toEqual([captured, second]);
    expect(f.session.state.inventoryPages.a).toEqual([captured, second]);
  });
  it("appends a removed recovery page after the registry pages without changing their order", () => {
    const f = withSecond(), removed = { ...pluginPage, id: "plugin:gone:x", owner: "gone", pageId: "x", plugin:{id:"gone",name:"Gone"}, label: "Removed page" };
    f.records[removed.id] = { dirty: true, page: removed };
    expect(ids(f)).toEqual([...registryIds, removed.id]);
    expect(f.session.state.groupedPages.at(-1).pages.at(-1)).toMatchObject({ id:"plugin:gone", label:"Gone", target:removed.id, pages:[removed] });
    expect(f.session.state.inventoryPages.gone).toEqual([removed]);
  });
  it("groups plugin pages by owner for the inventory and excludes non-plugin pages", () => {
    const other = { ...pluginPage, id: "plugin:b:p", owner: "b", group: "B" };
    const coreNamed = { ...pluginPage, id: "plugin:core:p", owner: "core", group: "Core plugin" };
    const coreOwnedByPlugin = { id: "core:x", owner: "a", group: "Settings", label: "Core page" };
    const f = withSecond(); f.pages.value = [...f.pages.value, other, coreNamed, coreOwnedByPlugin];
    expect(f.session.state.inventoryPages).toEqual({ a: [pluginPage, second], b: [other], core: [coreNamed] });
  });
  it("loads pages by plugin-page identity rather than owner name", async () => {
    const coreNamed = { ...pluginPage, id: "plugin:core:p", owner: "core", group: "Core plugin" };
    const f = fixture(); f.pages.value = [...f.pages.value, coreNamed, { id: "core:x", owner: "a", group: "Settings", label: "Core page" }];
    await f.session.selectPage(coreNamed.id);
    expect(f.session.state.currentPageIsPlugin).toBe(true); expect(f.pageState.load).toHaveBeenCalledWith(coreNamed.id);
    f.pageState.load.mockClear(); await f.session.selectPage("core:x");
    expect(f.session.state.currentPageIsPlugin).toBe(false); expect(f.pageState.load).not.toHaveBeenCalled();
  });
  it("projects attention in order and uses the inventory's admission capability", () => {
    const f=fixture();
    f.catalog.value.plugins[0]={id:"a",name:"A",enabled:true,runsInBrowser:true,status:"failed",diagnostics:[{detail:"Failed activation"}],blocking:{actions:["save","rename"]}};
    for(const id of ['r1','r2']) f.attentionRegistry.publish({id,kind:'plugin-access-request',owner:'a',label:id,open:()=>true});
    f.inventory.snapshot.mockReturnValue({canMutate:false});
    expect(f.session.state.pluginRows[0]).toMatchObject({runsInBrowser:true,canToggle:false,attention:[
      {text:"2 access requests",tone:"quiet"},{text:"Failed: Failed activation",tone:"danger"},{text:"Can block: save, rename",tone:"warning"},
    ]});
  });
  it("keeps a removed permission owner visible and non-mutable until its retained choice is resolved", () => {
    const f=fixture(); f.permissionRecords.a.draft={intent:{type:"master",value:true}};
    f.permissionRecords.a.available=false; f.catalog.value.plugins=[];
    const row=f.session.state.pluginRows.find(row=>row.id==="a");
    expect(row).toMatchObject({id:"a",name:"A",canToggle:false,permission:{recovery:{text:"Retained permission choice"}}});
    expect(row.toggleNote).toContain("unavailable");
    expect(f.permissions.discard).not.toHaveBeenCalled();
  });
  it("leaves unsupported plugin renderers discoverable without loading their data", async () => {
    const f=fixture();const unsupported={...pluginPage,id:"plugin:a:custom",kind:"unsupported",unsupported:true};
    f.pages.value.push(unsupported);await f.session.selectPage(unsupported.id);
    expect(f.session.state.currentPageId).toBe(unsupported.id);
    expect(f.pageState.load).not.toHaveBeenCalled();
    expect(f.session.state.inventoryPages.a).toContainEqual(unsupported);
  });
  it("reads plugin settings through the default registry by page identity", async () => {
    const f = fixture({ registry: undefined }), registry = f.factories.createPages.mock.calls[0][0].registry;
    api.getPluginSettings.mockResolvedValue({ values: { limit: 4 }, revision: 2 });
    expect(await registry.read({ id: "plugin:core:p", owner: "core", pageId: "p" })).toEqual({ values: { limit: 4 }, revision: 2 });
    expect(api.getPluginSettings).toHaveBeenCalledWith("core", "p");
    expect(await registry.read({ id: "core:appearance", owner: "a", pageId: "appearance" })).toEqual({ values: {}, revision: 0 });
    expect(api.getPluginSettings).toHaveBeenCalledOnce();
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
  it("a rejected departure also blocks a legacy permission deep link without opening or expanding", async () => {
    const f=fixture();f.inventory.resolveDeparture.mockResolvedValue(false);
    await f.session.openSettings("core:plugin-permissions:a");
    expect(f.visible.value).toBe(false);expect(f.session.state.currentPageId).toBe("core:appearance");
    expect(f.session.state.expandedPluginId).toBeNull();expect(f.permissions.load).not.toHaveBeenCalled();
  });
  it("loads branding at its page and permissions through a legacy deep link to Plugins", async () => {
    const f = fixture();
    await f.session.selectPage("core:branding"); expect(f.core.loadBrand).toHaveBeenCalledOnce();
    await f.session.openSettings("core:plugin-permissions:a");
    expect(f.permissions.load).toHaveBeenCalledWith("a");
    expect(f.session.state.currentPageId).toBe("core:plugins");
    expect(f.session.state.expandedPluginId).toBe("a");
    expect(f.permissions.snapshot("a")).toMatchObject({ view: { revision: 0 } });
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
    const f = fixture(); await f.session.managePlugin("a");
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
    expect(f.session.state.departureMessage).toContain("Unsaved changes on Preferences, Permissions for A, Branding, Plugins.");
    expect(f.session.state.departureMessage).toContain("before logout");
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
  it("permission row cannot collapse while its wire fails settlement or its decision is cancelled", async () => {
    const f = fixture();
    await f.session.managePlugin("a");
    expect(f.permissions.snapshot("a").view.revision).toBe(0);
    f.permissionRecords.a.busy = true; f.permissions.settle.mockResolvedValue(false);
    expect(await f.session.toggleExpansion('a')).toBe(false); expect(f.session.state.expandedPluginId).toBe("a");
    f.permissionRecords.a.busy = false; f.permissionRecords.a.draft = {};
    const closing = f.session.toggleExpansion('a'); await flushPromises();
    expect(f.session.state.departureCanSave).toBe(true); f.session.decideDeparture("cancel");
    expect(await closing).toBe(false); expect(f.session.state.expandedPluginId).toBe("a");
    const retry = f.session.toggleExpansion('a'); await flushPromises(); f.session.decideDeparture("retry");
    expect(await retry).toBe(true); expect(f.permissions.retry).toHaveBeenCalledWith("a");
    expect(f.session.state.expandedPluginId).toBeNull();
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
    expect(f.session.state.riskConfirmText).toBe("Reset branding"); expect(f.session.state.riskConfirmStyle).toBe("danger");
    expect(f.session.state.riskMessage).toBe("Reset retained brand"); f.session.resolveRisk(true); await reset;
    expect(f.core.saveBrand).toHaveBeenCalledWith(true);
    const discard = f.session.discardInventoryChoice(); expect(f.session.state.riskConfirmStyle).toBe("danger");
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
