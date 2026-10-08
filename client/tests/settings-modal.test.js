import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import SettingsModal from "../components/SettingsModal.vue";
import NavBar from "../partials/NavBar.vue";
import { pluginCatalog } from "../pluginRuntime.js";
import { useGlobalStore } from "../globalStore.js";
import { getPluginSettings, putPluginSettings, postBrand, getTree, putPluginEnabled, putPluginPolicy } from "../api.js";
import { hasUnsavedWork, resolveParticipants } from "../sessionActions.js";
import { registerPluginCommand, removeCommandOwner } from "../commands.js";
import { viewLineNumbers, saveViewLineNumbers } from "../pluginSettings.js";
import { currentLayerId, setLayer } from "../keybindings/store.js";
import { debugEnabled } from "../debug.js";
import Toggle from "../components/Toggle.vue";

vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock("../pluginRuntime.js", async () => { const { ref } = await import("vue"); const pluginCatalog = ref(null); return { pluginCatalog,
  refreshPluginRuntimeCatalog: vi.fn(async () => ({ status: "accepted", catalog: pluginCatalog.value })),
  capturePluginCatalogOwnership: vi.fn(() => ({ current: () => true })), acknowledgePluginPolicy: vi.fn(() => true) }; });
vi.mock("../api.js", async importOriginal => ({ ...await importOriginal(), getPluginHostCatalog: vi.fn(), getPluginSettings: vi.fn(), putPluginSettings: vi.fn(), putPluginEnabled: vi.fn(), putPluginPolicy: vi.fn(),
  getPluginPermissions: vi.fn(), putPluginPermissions: vi.fn(), getPluginPermissionRequests: vi.fn(async () => []), decidePluginPermissionRequest: vi.fn(),
  invokePluginCommand: vi.fn(), getConfig: vi.fn(), postBrand: vi.fn(), getTree: vi.fn(async () => ({folders:[],notes:[]})), getNotes: vi.fn(async () => []) }));

let wrapper;
const originalCreateUrl=URL.createObjectURL, originalRevokeUrl=URL.revokeObjectURL;
const button = (text, scope = document) => [...scope.querySelectorAll("button")].find(el => el.textContent.trim() === text);
const page = { id: "p", label: "Fixture preferences", renderer: { kind: "declarative-v1", version: 1 }, groups: [{ id: "general", label: "General group", description: "Group help", fields: ["message", "enabled"] }], fields: [
  { key: "message", label: "Message", description: "Message help", type: "text", default: "seed" },
  { key: "enabled", label: "Enabled", type: "toggle", default: false },
  { key: "limit", label: "Limit", type: "number", default: 5, min: 1, max: 10 },
  { key: "folder", label: "Folder", type: "folder", default: "" },
] };
beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear(); const pinia = createPinia(); setActivePinia(pinia);
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  useGlobalStore().config = { authType: "none", setupRequired: false, brand: { name: "my notes", accent: "#53c729", files: ["logo.svg", "icon.svg"] } };
  pluginCatalog.value = { policy: { revision: 0, signature: "policy", effectiveAutoEnable: true }, plugins: [{ id: "a", name: "Fixture", enabled: true, runtime: { server: true }, pages: [page], blocking: { actions: [] } }] };
  getPluginSettings.mockResolvedValue({ revision: 0, values: { message: "stored", enabled: false, limit: 5, folder: "" } });
  putPluginSettings.mockImplementation(async (id, p, values, revision) => ({ values, revision: revision + 1 }));
  postBrand.mockResolvedValue({ name: null, accent: null, files: [] }); saveViewLineNumbers(false); debugEnabled.value = false; setLayer("legacy");
  getTree.mockResolvedValue({folders:[],notes:[]});
});
afterEach(() => { wrapper?.unmount(); wrapper = null; pluginCatalog.value = null; removeCommandOwner("settings-fixture"); URL.createObjectURL=originalCreateUrl;URL.revokeObjectURL=originalRevokeUrl;vi.clearAllMocks(); });
async function open(id, writable = true) {
  wrapper = mount(SettingsModal, { attachTo: document.body, props: { modelValue: true, writable }, global: { directives: { focus: { mounted: el => el.focus() } } } });
  await wrapper.vm.openSettings(id); await flushPromises();
}

describe("actual retained Settings entry and inline pages", () => {
  it("review repairs: R18 mounted enabled fields keep Enter/blur admission during a same-page refresh", async () => {
    await open("plugin:a:p"); let release;
    getPluginSettings.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const refreshing = wrapper.vm.selectPage("plugin:a:p"); await flushPromises();
    try {
      expect(document.querySelector('#settings-field-message').readOnly).toBe(false);
      await wrapper.find('#settings-field-message').setValue("explicit refresh-race value");
      await wrapper.find('#settings-field-message').trigger("keydown", { key: "Enter" });
      await wrapper.find('#settings-field-message').trigger("blur"); await flushPromises();
      expect(putPluginSettings).toHaveBeenCalledTimes(1);
      expect(putPluginSettings).toHaveBeenCalledWith("a", "p", { message: "explicit refresh-race value", enabled: false, limit: 5, folder: "" }, 0);
      release({ revision: 0, values: { message: "late old read", enabled: false, limit: 5, folder: "" } }); await refreshing; await flushPromises();
      expect(document.querySelector('#settings-field-message').value).toBe("explicit refresh-race value");
    } finally { release({ revision: 0, values: { message: "old", enabled: false, limit: 5, folder: "" } }); await refreshing; }
  });
  it("shows the real inline layer rail and registered plugin command remapping", async () => {
    registerPluginCommand("settings-fixture", { id: "inspect", label: "Fixture live command", target: "browser" }, () => "consumer");
    await open("core:keybindings");
    expect(document.body.textContent).toContain("Legacy Flatnotes");
    expect(document.body.textContent).toContain("Save note");
    expect(document.body.textContent).toContain("Fixture live command");
    button("Custom").click(); await flushPromises(); expect(currentLayerId.value).toBe("custom");
    expect(document.querySelector('[data-modal-top=true]').textContent).not.toContain("opens in its own panel");
  });
  it("renders Branding content in the existing Settings instance and reset asks before posting", async () => {
    await open("core:branding"); expect(document.querySelector('#brand-name').value).toBe("my notes");
    button("Reset").click(); await flushPromises();
    expect(document.querySelector('[data-modal-top=true]').textContent).toContain('name "my notes"');
    expect(postBrand).not.toHaveBeenCalled(); button("Cancel", document.querySelector('[data-modal-top=true]')).click(); await flushPromises();
    expect(document.querySelector('#brand-name').value).toBe("my notes"); expect(document.querySelector('#settings-modal-title')).not.toBeNull();
  });
  it("core line-number and diagnostics toggles use the actual Toggle click contract", async () => {
    await open("core:editor"); await wrapper.findComponent(Toggle).trigger("click"); await flushPromises();
    expect(viewLineNumbers.value).toBe(true); expect(localStorage.getItem("viewLineNumbers")).toBe("true");
    await wrapper.vm.openSettings("core:diagnostics"); await wrapper.findComponent(Toggle).trigger("click"); expect(debugEnabled.value).toBe(true);
  });
  it("renders the Close Settings glyph through the supported icon input", async () => {
    await open("core:appearance"); expect(document.querySelector('[aria-label="Close settings"] svg path')?.getAttribute("d")).toBeTruthy();
  });
  it("read-only plugin pages remain visible but every mutation input is unavailable", async () => {
    await open("plugin:a:p", false); expect(document.querySelector('#settings-field-message').readOnly).toBe(true);
    expect(wrapper.findComponent(Toggle).element.disabled).toBe(true);
    expect(putPluginSettings).not.toHaveBeenCalled();
  });
  it("groups/help and host folder choices are present on the real page", async () => {
    await open("plugin:a:p"); expect(document.body.textContent).toContain("General group"); expect(document.body.textContent).toContain("Group help");
    expect(document.body.textContent).toContain("Message help"); expect(button("Choose folder")).toBeTruthy();
  });
  it("Enter then blur persists a typed value once and keeps the acknowledged consumer value", async () => {
    await open("plugin:a:p"); const input = wrapper.find('#settings-field-message'); await input.setValue("typed committed value");
    await input.trigger("keydown", { key: "Enter" }); await input.trigger("blur"); await flushPromises();
    expect(putPluginSettings).toHaveBeenCalledTimes(1); expect(putPluginSettings.mock.calls[0][2].message).toBe("typed committed value");
    expect(document.querySelector('#settings-field-message').value).toBe("typed committed value");
  });
  it("an acknowledged branding snapshot cannot erase newer name edits or bypass the departure decision", async () => {
    await open('core:branding');let acknowledge;postBrand.mockImplementation(()=>new Promise(resolve=>{acknowledge=resolve;}));
    await wrapper.find('#brand-name').setValue('submitted A');button('Save',document.querySelector('[data-branding-settings]')).click();await flushPromises();
    expect(postBrand.mock.calls[0][0].get('name')).toBe('submitted A');
    await wrapper.find('#brand-name').setValue('newer D');acknowledge({name:'submitted A',accent:'#53c729',files:['logo.svg','icon.svg']});await flushPromises();
    expect(useGlobalStore().config.brand.name).toBe('submitted A');expect(document.querySelector('#brand-name').value).toBe('newer D');
    document.querySelector('[aria-label="Close settings"]').click();await flushPromises();expect(document.querySelector('[data-modal-top=true]').textContent).toContain('Unsaved settings');
    button('Keep editing',document.querySelector('[data-modal-top=true]')).click();await flushPromises();expect(document.querySelector('#brand-name').value).toBe('newer D');
  });
  it("File drafts/previews survive a cancelled page departure and revoke only on explicit discard", async () => {
    const create=vi.fn(()=> 'blob:retained-file'),revoke=vi.fn();URL.createObjectURL=create;URL.revokeObjectURL=revoke;
    await open('core:branding');const input=document.querySelector('[data-branding-settings] input[type=file]'),file=new File(['image bytes'],'logo.svg',{type:'image/svg+xml'});
    Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new Event('change',{bubbles:true}));await flushPromises();
    const departure=wrapper.vm.selectPage('core:appearance');await flushPromises();button('Keep editing',document.querySelector('[data-modal-top=true]')).click();expect(await departure).toBe(false);await flushPromises();
    expect(document.querySelector('[data-branding-settings] img').getAttribute('src')).toBe('blob:retained-file');expect(revoke).not.toHaveBeenCalled();
    const discard=wrapper.vm.selectPage('core:appearance');await flushPromises();button('Discard',document.querySelector('[data-modal-top=true]')).click();expect(await discard).toBe(true);await flushPromises();
    expect(revoke).toHaveBeenCalledWith('blob:retained-file');expect(postBrand).not.toHaveBeenCalled();
  });
  it("host folder choice uses the actual tree identity and persists to the captured field", async () => {
    getTree.mockImplementation(async path=>path ? {folders:[],notes:[]} : {folders:[{name:'Chosen',path:'Chosen'}],notes:[]});
    await open('plugin:a:p');button('Choose folder').click();await flushPromises();
    expect(getTree).toHaveBeenCalledWith('');expect(document.querySelector('[data-modal-top=true]').textContent).toContain('Chosen');
    button('Chosen/',document.querySelector('[data-modal-top=true]')).click();await flushPromises();
    button('Use this folder',document.querySelector('[data-modal-top=true]')).click();await flushPromises();
    expect(putPluginSettings).toHaveBeenCalledWith('a','p',{message:'stored',enabled:false,limit:5,folder:'Chosen'},0);
    expect(document.querySelector('#settings-field-folder').value).toBe('Chosen');
  });
  it("review repairs: R18 the mounted Settings page adopts D3 after clean ACK without remounting its owner", async () => {
    let acknowledge, readNew;
    await open("plugin:a:p"); const owner = document.querySelector('#settings-modal-title');
    putPluginSettings.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    await wrapper.find('#settings-field-message').setValue("D1 submitted"); await wrapper.find('#settings-field-message').trigger("keydown", { key: "Enter" }); await flushPromises();
    const replace = key => { pluginCatalog.value = { ...pluginCatalog.value, plugins: [{ ...pluginCatalog.value.plugins[0], pages: [{ ...page, groups: [], fields: [{ key, label: key.toUpperCase(), type: "text", default: "default" }] }] }] }; };
    replace("d2"); await flushPromises(); replace("d3"); await flushPromises();
    expect(document.querySelector('#settings-field-message').value).toBe("D1 submitted");
    getPluginSettings.mockImplementation(() => new Promise(resolve => { readNew = resolve; }));
    acknowledge({ revision: 1, values: { message: "D1 submitted", enabled: false, limit: 5, folder: "" } }); await flushPromises();
    expect(document.querySelector('#settings-field-message')).toBeNull(); expect(document.querySelector('#settings-field-d3')).not.toBeNull();
    expect(document.querySelector('#settings-field-d3').readOnly).toBe(true);
    expect(document.body.textContent).not.toContain("original draft is retained");
    readNew({ revision: 7, values: { d3: "D3 authoritative" } }); await flushPromises();
    expect(document.querySelector('#settings-field-d3').value).toBe("D3 authoritative");
    expect(document.querySelector('#settings-field-d3').readOnly).toBe(false); expect(document.querySelector('#settings-modal-title')).toBe(owner);
    putPluginSettings.mockImplementation(async (id, p, values, revision) => ({ values, revision: revision + 1 }));
    await wrapper.find('#settings-field-d3').setValue("D3 explicit"); await wrapper.find('#settings-field-d3').trigger("keydown", { key: "Enter" }); await flushPromises();
    expect(putPluginSettings).toHaveBeenLastCalledWith("a", "p", { d3: "D3 explicit" }, 7);
  });
  it("review repairs: R18 real Settings read-back retains removed-field intent until explicit discard and loads D3 without replay", async () => {
    await open("plugin:a:p"); const owner = document.querySelector('#settings-modal-title');
    putPluginSettings.mockRejectedValue(Error("original response lost"));
    await wrapper.find('#settings-field-message').setValue("retained D1 intent"); await wrapper.find('#settings-field-message').trigger("keydown", { key: "Enter" }); await flushPromises();
    pluginCatalog.value = { ...pluginCatalog.value, plugins: [{ ...pluginCatalog.value.plugins[0], pages: [{ ...page, groups: [], fields: [{ key: "d3", label: "D3", type: "text", default: "default" }] }] }] };
    await flushPromises(); getPluginSettings.mockResolvedValue({ revision: 1, values: { d3: "D3 authoritative" } });
    button("Review / Retry").click(); await flushPromises();
    expect(getPluginSettings).toHaveBeenCalledTimes(2); expect(putPluginSettings).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#settings-field-message').value).toBe("retained D1 intent");
    expect(document.querySelector('#settings-field-d3')).toBeNull();
    button("Reload").click(); await flushPromises();
    expect(document.querySelector('[data-modal-top=true]').textContent).toContain("Unsaved settings");
    button("Keep editing", document.querySelector('[data-modal-top=true]')).click(); await flushPromises();
    expect(document.querySelector('#settings-field-message').value).toBe("retained D1 intent");
    button("Reload").click(); await flushPromises(); button("Discard", document.querySelector('[data-modal-top=true]')).click(); await flushPromises();
    expect(document.querySelector('#settings-field-d3').value).toBe("D3 authoritative");
    expect(document.querySelector('#settings-field-d3').readOnly).toBe(false);
    expect(document.querySelector('#settings-modal-title')).toBe(owner); expect(putPluginSettings).toHaveBeenCalledTimes(1);
  });
});

describe("review repairs: R13 real inventory policy wires participate in protected handoffs", () => {
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const inventoryButton = () => document.querySelector('[data-plugin-inventory-id="a"] button');

  it("a held enablement wire is unsaved work and cannot close Settings", async () => {
    const wire = deferred(); putPluginEnabled.mockReturnValue(wire.promise);
    try {
      await open("core:plugins"); inventoryButton().click(); await flushPromises();
      expect(putPluginEnabled).toHaveBeenCalledTimes(1);
      expect(hasUnsavedWork()).toBe(true);
      document.querySelector('[aria-label="Close settings"]').click(); await flushPromises();
      expect(wrapper.emitted("update:modelValue")?.some(([visible]) => visible === false) ?? false).toBe(false);
    } finally { wire.resolve({ policy: { revision: 1, signature: "committed" } }); await flushPromises(); }
  });

  it("enablement and auto-enable reserve the same policy CAS before sending", async () => {
    const wire = deferred(); putPluginEnabled.mockReturnValue(wire.promise); putPluginPolicy.mockResolvedValue({ policy: { revision: 1, signature: "other" } });
    try {
      await open("core:plugins"); inventoryButton().click(); await flushPromises();
      const switches = [...document.querySelectorAll('[data-plugin-inventory] button')];
      const automatic = switches.find(button => button.textContent.includes("Auto-enable new plugins"));
      expect(automatic).toBeTruthy(); automatic.click();
      await flushPromises();
      expect(putPluginPolicy).not.toHaveBeenCalled();
      expect(putPluginEnabled).toHaveBeenCalledTimes(1);
    } finally { wire.resolve({ policy: { revision: 1, signature: "committed" } }); await flushPromises(); }
  });

  it("a failure while a session handoff waits aborts that attempt without clearing inventory intent", async () => {
    const wire = deferred(); putPluginEnabled.mockReturnValue(wire.promise);
    let pending;
    try {
      await open("core:plugins"); inventoryButton().click(); await flushPromises();
      pending = resolveParticipants("logout"); await flushPromises();
      wire.reject({ response: { status: 503, data: { detail: "policy persisted but activation failed" } } }); await flushPromises();
      expect(await pending).toBe("cancel"); expect(hasUnsavedWork()).toBe(true);
    } finally { wire.resolve({ policy: { revision: 1, signature: "late" } }); await flushPromises(); if (pending) await pending; }
  });
});

describe("actual menu replacement", () => {
  it("navbar no longer renders the obsolete floating menu", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", name: "home", component: { template: "<p>Home</p>" } }] });
    await router.push("/"); await router.isReady();
    wrapper = mount(NavBar, { global: { plugins: [router], stubs: { RouterLink: { template: '<a><slot /></a>' } } } });
    expect(wrapper.find('[title="Menu"]').exists()).toBe(false);
  });
});
