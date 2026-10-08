import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../App.vue";
import NoteView from "../views/Note.vue";
import { useGlobalStore } from "../globalStore.js";
import { hasUnsavedWork } from "../sessionActions.js";
import { dispatchAction } from "../keybindings/dispatcher.js";
import { publish, TOPICS } from "../bus/index.js";
import { getStoredToken, storeToken } from "../tokenStorage.js";
import { getConfig, updateNote, resetSetup, postSetup, putAccessSettings, postAccessTotpEnrolment, getPluginPermissions, getPluginPermissionRequests, decidePluginPermissionRequest, putPluginEnabled } from "../api.js";
import { pluginCatalog } from "../pluginRuntime.js";
import ConfirmModal from "../components/ConfirmModal.vue";
import SettingsModal from "../components/SettingsModal.vue";

const state = vi.hoisted(() => ({ router: null }));
vi.mock("../router.js", () => ({ default: {
  get currentRoute() { return state.router.currentRoute; },
  get options() { return state.router.options; },
  push(...args) { return state.router.push(...args); },
  replace(...args) { return state.router.replace(...args); },
} }));
vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  const pluginCatalog = ref(null);
  return { pluginCatalog, startPluginRuntime: vi.fn(), stopPluginRuntime: vi.fn(),
    refreshPluginRuntimeCatalog: vi.fn(async () => ({ status: "accepted", catalog: pluginCatalog.value })),
    capturePluginCatalogOwnership: vi.fn(() => ({ current: () => true })), acknowledgePluginPolicy: vi.fn(() => true) };
});
vi.mock("../api.js", () => ({
  getConfig: vi.fn(), getNote: vi.fn(async path => ({ path, content: "Seed\n" })),
  getNoteIndex: vi.fn(async () => [{ path: "NoteA" }]), getPlugins: vi.fn(async () => []),
  getRenderedHtml: vi.fn(async () => "<p>Seed</p>"), getTree: vi.fn(async () => []),
  getIndexStatus: vi.fn(async () => ({ syncing: false })), getNotes: vi.fn(async () => []),
  updateNote: vi.fn(), createNote: vi.fn(), deleteNote: vi.fn(), previewRename: vi.fn(async () => []),
  operationError: vi.fn(() => null), apiErrorHandler: vi.fn(), uploadFile: vi.fn(), renderBuffer: vi.fn(),
  getPluginHostCatalog: vi.fn(async () => ({ plugins: [] })), getPluginSettings: vi.fn(),
  putPluginSettings: vi.fn(), putPluginPolicy: vi.fn(), putPluginEnabled: vi.fn(),
  getPluginPermissions: vi.fn(), putPluginPermissions: vi.fn(), getPluginPermissionRequests: vi.fn(async () => []), decidePluginPermissionRequest: vi.fn(),
  invokePluginCommand: vi.fn(), postSetup: vi.fn(), resetSetup: vi.fn(), postTotpEnrolment: vi.fn(), postBrand: vi.fn(),
  getAccessSettings: vi.fn(async () => ({ mode: "none", username: "", totpEnabled: false, settingsWritable: true, revision: 0, signature: "initial", pinned: {} })),
  putAccessSettings: vi.fn(async () => ({ view: { mode: "read_only", settingsWritable: false, revision: 1, pinned: {} }, requiresLogin: false })), postAccessTotpEnrolment: vi.fn(),
}));
vi.mock("../themes.js", async () => {
  const { ref } = await import("vue");
  return { currentTheme: ref("system"), THEMES: [], initTheme: vi.fn(), setTheme: vi.fn(), currentThemeLabel: ref("System"), resolvedTheme: ref({}) };
});
vi.mock("../brand.js", () => ({ applyBrandToDocument: vi.fn(), currentBrandName: () => "globnotes", brandRevision: { value: 0 } }));
let wrapper;
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/NoteA");
  const pinia = createPinia();
  setActivePinia(pinia);
  getConfig.mockResolvedValue({ authType: "none", setupRequired: false, brand: {} });
  pluginCatalog.value = null;
  getPluginPermissionRequests.mockResolvedValue([]);
  getPluginPermissions.mockReset();
  decidePluginPermissionRequest.mockReset();
  updateNote.mockResolvedValue({ path: "NoteA", content: "Seed\n" });
  state.router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "home", component: { template: "<p>Home</p>" } },
    { path: "/_/login", name: "login", component: { template: "<p>Login</p>" } },
    { path: "/:path(.*)", name: "note", component: NoteView, props: true },
  ] });
  await state.router.push("/NoteA");
  await state.router.isReady();
  wrapper = mount(App, { attachTo: document.body, global: {
    plugins: [pinia, state.router], directives: { focus: { mounted: el => el.focus() } },
    stubs: { NavBar: true, SidebarPanel: true, SyncBanner: true, PrimeToast: true, QuickSwitcher: true, CommandPalette: true },
  } });
  await flushPromises();
});
afterEach(() => { wrapper?.unmount(); wrapper = null; pluginCatalog.value = null; vi.clearAllMocks(); });
const visibleButton = (text, scope = document) => [...scope.querySelectorAll("button")].find(button => button.textContent.trim() === text && button.style.display !== "none");
const decisionButton = text => visibleButton(text, document.querySelector('[data-modal-top="true"]'));
async function editImmediately() {
  visibleButton("Edit").click();
  await flushPromises();
  const content = document.querySelector(".cm-content");
  expect(content).not.toBeNull();
  const editor = wrapper.findComponent({ name: "MarkdownEditor" });
  // Drive the real CodeMirror transaction; native input is proven separately.
  editor.vm.setMarkdown("immediate dirty marker\n");
  editor.vm.$emit("change");
  return content;
}

describe("real App/Note session integration", () => {
  it("optional wizard open/dismiss preserves the same immediate dirty editor", async () => {
    const content = await editImmediately();
    useGlobalStore().setupWizardRequested = true;
    await flushPromises();
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(content.textContent).toContain("immediate dirty marker");
    document.querySelector('[aria-label="Dismiss setup"]').click();
    await flushPromises();
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(hasUnsavedWork()).toBe(true);
  });

  it("a retained resumed draft is dirty before the display debounce", async () => {
    localStorage.setItem("NoteA", "resumed draft\n");
    visibleButton("Edit").click();
    await flushPromises();
    visibleButton("Resume Draft").click();
    await flushPromises();
    expect(document.querySelector(".cm-content").textContent).toContain("resumed draft");
    expect(hasUnsavedWork()).toBe(true);
  });

  it("Note teardown removes its participant rather than leaving stale dirty work", async () => {
    await editImmediately();
    expect(hasUnsavedWork()).toBe(true);
    wrapper.unmount();
    wrapper = null;
    expect(hasUnsavedWork()).toBe(false);
  });

  it.each(["Cancel", "Discard", "Save"])("Logout %s resolves immediate typing before clearing credentials", async choice => {
    useGlobalStore().config.authType = "password";
    storeToken("session-fixture-token", true);
    localStorage.setItem("unrelated-preference", "preserve-me");
    const content = await editImmediately();
    updateNote.mockImplementation(async (path, newPath, text) => {
      expect(getStoredToken()).toBe("session-fixture-token");
      return { path: newPath, content: text };
    });
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" });
    await flushPromises();
    visibleButton("Log out").click();
    await flushPromises();
    expect(getStoredToken()).toBe("session-fixture-token");
    expect(document.body.textContent).toContain("Save Changes");
    decisionButton(choice).click();
    await flushPromises();
    if (choice === "Cancel") {
      expect(getStoredToken()).toBe("session-fixture-token");
      expect(document.querySelector(".cm-content")).toBe(content);
      expect(content.textContent).toContain("immediate dirty marker");
      expect(state.router.currentRoute.value.name).toBe("note");
    } else {
      expect(getStoredToken()).toBeNull();
      expect(state.router.currentRoute.value.name).toBe("login");
    }
    expect(updateNote).toHaveBeenCalledTimes(choice === "Save" ? 1 : 0);
    expect(localStorage.getItem("unrelated-preference")).toBe("preserve-me");
  });

  it("blocked Logout Save keeps credentials, editor and Settings mounted", async () => {
    useGlobalStore().config.authType = "password";
    storeToken("session-fixture-token", true);
    const content = await editImmediately();
    updateNote.mockRejectedValue({ response: { status: 503, data: { code: "plugin_guard_failed" } } });
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" });
    await flushPromises();
    visibleButton("Log out").click();
    await flushPromises();
    decisionButton("Save").click();
    await flushPromises();
    expect(getStoredToken()).toBe("session-fixture-token");
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(document.querySelector("#settings-modal-title")).not.toBeNull();
    expect(hasUnsavedWork()).toBe(true);
  });

  it("one Escape cancels the Note decision without dismissing the pending wizard", async () => {
    const content = await editImmediately();
    useGlobalStore().setupWizardRequested = true;
    await flushPromises();
    document.querySelector("#setup-mode-read_only").click();
    await flushPromises();
    document.querySelector("button[type=submit]").click();
    await flushPromises();
    expect(document.body.textContent).toContain("Save Changes");
    const prompt = document.querySelector('[data-modal-top="true"]');
    expect(prompt.closest("[inert]")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushPromises();
    expect(document.querySelector("#setup-title")).not.toBeNull();
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(resetSetup).not.toHaveBeenCalled();
    expect(postSetup).not.toHaveBeenCalled();
  });

  it("Logout cannot clear credentials while an already-admitted toolbar Save is unresolved", async () => {
    useGlobalStore().config.authType = "password";
    storeToken("session-fixture-token", true);
    const content = await editImmediately();
    updateNote.mockImplementation(() => new Promise(() => {}));
    visibleButton("Save").click();
    await flushPromises();
    expect(updateNote).toHaveBeenCalledTimes(1);
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" });
    await flushPromises();
    visibleButton("Log out").click();
    await flushPromises();
    // The write has neither succeeded nor failed yet. Revoking its current
    // credentials or destroying its buffer here cannot be a safe handoff.
    const liveEditor = document.querySelector(".cm-content");
    expect({ token: getStoredToken(), sameEditor: liveEditor === content, bufferVisible: liveEditor?.textContent.includes("immediate dirty marker") ?? false, route: state.router.currentRoute.value.name }).toEqual({ token: "session-fixture-token", sameEditor: true, bufferVisible: true, route: "note" });
  });

  it("Logout waits for A/B and then asks about newer unsent D", async () => {
    useGlobalStore().config.authType = "password"; storeToken("session-fixture-token", true);
    await editImmediately();
    const pending = [];
    updateNote.mockImplementation((path, target, text) => new Promise(resolve => pending.push({ resolve, text, target })));
    visibleButton("Save").click(); await flushPromises();
    const editor = wrapper.findComponent({ name: "MarkdownEditor" });
    editor.vm.setMarkdown("B"); visibleButton("Save").click(); await flushPromises(); editor.vm.setMarkdown("D");
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" }); await flushPromises(); visibleButton("Log out").click(); await flushPromises();
    expect(document.body.textContent).not.toContain("Save Changes"); expect(pending).toHaveLength(1);
    pending[0].resolve({ path: "NoteA", content: pending[0].text }); await flushPromises();
    expect(pending).toHaveLength(2); expect(getStoredToken()).toBe("session-fixture-token");
    pending[1].resolve({ path: "NoteA", content: "B" }); await flushPromises();
    expect(document.body.textContent).toContain("Save Changes"); expect(document.querySelector(".cm-content").textContent).toBe("D");
    decisionButton("Cancel").click(); await flushPromises(); expect(getStoredToken()).toBe("session-fixture-token");
  });

  it("a failure encountered by Logout aborts, but a later known-settled attempt permits disclosed Discard", async () => {
    useGlobalStore().config.authType = "password"; storeToken("session-fixture-token", true);
    await editImmediately(); let reject;
    updateNote.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    visibleButton("Save").click(); await flushPromises();
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" }); await flushPromises(); visibleButton("Log out").click(); await flushPromises();
    reject({ response: { status: 409, data: { code: "plugin_cancelled", detail: "guard" } } }); await flushPromises();
    expect(getStoredToken()).toBe("session-fixture-token"); expect(document.body.textContent).not.toContain("Save Changes");
    visibleButton("Log out").click(); await flushPromises();
    expect(document.body.textContent).toContain("Discard removes queued saves");
    decisionButton("Discard").click(); await flushPromises();
    expect(getStoredToken()).toBeNull(); expect(state.router.currentRoute.value.name).toBe("login"); expect(updateNote).toHaveBeenCalledTimes(1);
  });

  it("an unknown dispatched outcome never permits Logout or a Discard shortcut", async () => {
    useGlobalStore().config.authType = "password"; storeToken("session-fixture-token", true);
    await editImmediately(); updateNote.mockRejectedValue(new Error("transport lost"));
    visibleButton("Save").click(); await flushPromises();
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" }); await flushPromises(); visibleButton("Log out").click(); await flushPromises();
    expect(getStoredToken()).toBe("session-fixture-token"); expect(document.body.textContent).not.toContain("Save Changes"); expect(document.querySelector(".cm-content")).not.toBeNull();
  });

  it("Access Finish keeps the in-place update pending until the foreground Save succeeds", async () => {
    await editImmediately(); let acknowledge;
    updateNote.mockImplementation((path, target, text) => new Promise(resolve => { acknowledge = () => resolve({ path: target, content: text }); }));
    visibleButton("Save").click(); await flushPromises();
    useGlobalStore().setupWizardRequested = true; await flushPromises();
    document.querySelector("#setup-mode-read_only").click(); await flushPromises(); document.querySelector("button[type=submit]").click(); await flushPromises();
    expect(resetSetup).not.toHaveBeenCalled(); expect(postSetup).not.toHaveBeenCalled();
    expect(putAccessSettings).not.toHaveBeenCalled();
    acknowledge(); await flushPromises();
    expect(resetSetup).not.toHaveBeenCalled(); expect(postSetup).not.toHaveBeenCalled();
    expect(putAccessSettings).toHaveBeenCalledTimes(1);
  });
  it("direct editor action publication cannot save behind the real Settings dialog", async () => {
    const content=await editImmediately(); dispatchAction(TOPICS.APP_OPEN_SETTINGS,{page:'core:appearance'}); await flushPromises();
    publish(TOPICS.EDITOR_SAVE); await flushPromises();
    expect(updateNote).not.toHaveBeenCalled(); expect(document.querySelector('.cm-content')).toBe(content); expect(content.textContent).toContain('immediate dirty marker');
  });
  it("a confirmed 2FA receipt switches to the correct login policy without waiting for another config request", async () => {
    storeToken("obsolete-session-fixture", true); localStorage.setItem("unrelated-preference", "retained");
    useGlobalStore().setupWizardRequested = true; await flushPromises();
    document.querySelector("#setup-mode-password").click(); await flushPromises();
    const input = async (selector, value) => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); await flushPromises(); };
    await input("#setup-username", "new-account"); await input("#setup-password", "new-password");
    postAccessTotpEnrolment.mockResolvedValue({ key: "fixture-new-key", qr: "data:image/png;base64,test", secret: "fixture-secret" });
    document.querySelector("#setup-totp").click(); await flushPromises();
    await input("#setup-totp-code", "123456");
    putAccessSettings.mockResolvedValueOnce({ view: { mode: "password", username: "new-account", totpEnabled: true, settingsWritable: true, revision: 1, pinned: {} }, requiresLogin: true });
    getConfig.mockImplementationOnce(() => new Promise(() => {}));
    document.querySelector('[aria-labelledby="setup-title"] form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flushPromises();
    expect(useGlobalStore().config.authType).toBe("totp");
    expect(state.router.currentRoute.value.name).toBe("login"); expect(getStoredToken()).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("retained");
  });
  it("review repairs: R13 an uncertain inventory response aborts real App Logout and preserves credentials after late success", async () => {
    vi.useFakeTimers(); let resolve;
    useGlobalStore().config.authType = "password"; storeToken("inventory-held-session", true);
    pluginCatalog.value = { policy: { revision: 0, signature: "p0", effectiveAutoEnable: true }, plugins: [{ id: "inventory", name: "Inventory", enabled: true, runtime: {}, pages: [], blocking: { actions: [] } }] };
    putPluginEnabled.mockImplementation(() => new Promise(done => { resolve = done; }));
    try {
      dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:plugins" }); await flushPromises();
      document.querySelector('[data-plugin-inventory-id="inventory"] button').click(); await flushPromises();
      wrapper.findComponent(SettingsModal).vm.$emit("logout"); await vi.advanceTimersByTimeAsync(5001); await flushPromises();
      expect(getStoredToken()).toBe("inventory-held-session"); expect(state.router.currentRoute.value.name).toBe("note");
      expect(document.querySelector('#settings-modal-title')).not.toBeNull();
      resolve({ policy: { revision: 1, signature: "p1" } }); await flushPromises();
      expect(getStoredToken()).toBe("inventory-held-session"); expect(state.router.currentRoute.value.name).toBe("note");
      expect(putPluginEnabled).toHaveBeenCalledTimes(1);
    } finally { resolve?.({ policy: { revision: 1, signature: "p1" } }); vi.useRealTimers(); await flushPromises(); }
  });
  it("review repairs: R13 Access submission cannot overtake an inventory wire and late ACK does not resume its failed handoff", async () => {
    vi.useFakeTimers(); let resolve;
    pluginCatalog.value = { policy: { revision: 0, signature: "p0", effectiveAutoEnable: true }, plugins: [{ id: "inventory", name: "Inventory", enabled: true, runtime: {}, pages: [], blocking: { actions: [] } }] };
    putPluginEnabled.mockImplementation(() => new Promise(done => { resolve = done; }));
    try {
      dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:plugins" }); await flushPromises();
      document.querySelector('[data-plugin-inventory-id="inventory"] button').click(); await flushPromises();
      useGlobalStore().setupWizardRequested = true; await flushPromises();
      document.querySelector('#setup-mode-read_only').click(); await flushPromises();
      document.querySelector('[aria-labelledby="setup-title"] form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(5001); await flushPromises(); expect(putAccessSettings).not.toHaveBeenCalled();
      resolve({ policy: { revision: 1, signature: "p1" } }); await flushPromises();
      expect(putAccessSettings).not.toHaveBeenCalled(); expect(document.querySelector('#setup-title')).not.toBeNull();
      expect(putPluginEnabled).toHaveBeenCalledTimes(1);
    } finally { resolve?.({ policy: { revision: 1, signature: "p1" } }); vi.useRealTimers(); await flushPromises(); }
  });
});

describe("real App permission prompt ownership", () => {
  const scope = { type: "host", authority: "service.example:443" };
  function permissionFixture() {
    const source = { key: "source-A", revision: 1, codeFingerprint: "code-A", settingsRevision: 0 };
    const request = { id: "request-A", pluginId: "p", source, kind: "network", scopes: [scope], reason: "<b>Escaped reason</b>", state: "pending" };
    const view = { pluginId: "p", revision: 2, signature: "v2", requestSourceKey: source.key, requestSourceRevision: source.revision, source,
      allowNetwork: false, requestedNetwork: [scope], requestedImports: [], approvedNetwork: [], approvedImports: [], effectiveNetwork: [], effectiveImports: [],
      rows: [], pendingRequests: [request], reload: { state: "none", fingerprint: "none" }, runsInBrowser: true, browserComponents: ["runtime"] };
    getPluginPermissions.mockResolvedValue(view);
    getPluginPermissionRequests.mockResolvedValue([request]);
    pluginCatalog.value = { plugins: [{ id: "p", name: "Prompt plugin", enabled: true, runtime: { server: true, client: true }, permissions: view, pages: [] }] };
    return { request, view };
  }

  it("Escape defers one request, restores the underlying Settings focus and grants nothing", async () => {
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:plugins" }); await flushPromises();
    const opener = document.activeElement;
    permissionFixture(); await flushPromises();
    const prompt = document.querySelector('[data-modal-top="true"]');
    expect(prompt.textContent).toContain("Plugin access request");
    expect(prompt.contains(document.activeElement)).toBe(true);
    expect(document.querySelector('[data-app-shell]').hasAttribute("inert")).toBe(true);
    expect(document.querySelector('#settings-modal-title').closest('[data-modal-top]').hasAttribute("inert")).toBe(true);
    expect(prompt.textContent).toContain("<b>Escaped reason</b>");
    expect(prompt.querySelector("b")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('#settings-modal-title')).not.toBeNull();
    pluginCatalog.value = { ...pluginCatalog.value }; await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("Deny persists only the request decision and never selects master or grants", async () => {
    const { view } = permissionFixture(); await flushPromises();
    decidePluginPermissionRequest.mockResolvedValue({ view: { ...view, revision: 3, signature: "v3", pendingRequests: [] } });
    getPluginPermissionRequests.mockResolvedValue([]);
    decisionButton("Deny").click(); await flushPromises();
    expect(decidePluginPermissionRequest).toHaveBeenCalledWith("p", "request-A", { revision: 2, signature: "v2", requestSourceKey: "source-A", requestSourceRevision: 1,
      decision: "deny", allowNetwork: false, approvedNetwork: [], approvedImports: [] });
    expect(document.querySelector('#permission-request-title')).toBeNull();
  });

  it("source retirement closes an old prompt before any stale decision can be sent", async () => {
    const { view } = permissionFixture(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    const source = { ...view.source, key: "source-B", revision: 2, codeFingerprint: "code-B" };
    const replacement = { ...view, source, requestSourceKey: source.key, requestSourceRevision: 2, pendingRequests: [] };
    getPluginPermissions.mockResolvedValue(replacement); getPluginPermissionRequests.mockResolvedValue([]);
    pluginCatalog.value = { plugins: [{ ...pluginCatalog.value.plugins[0], permissions: replacement }] }; await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("catalogue removal retires a prompt immediately even while pending-request refresh is unresolved", async () => {
    const { request } = permissionFixture(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(1);
    let reply;
    getPluginPermissionRequests.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    pluginCatalog.value = { plugins: [] }; await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    reply([request]); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(1);
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("initial route readiness re-admits pending review after fencing a load from the previous route", async () => {
    await state.router.push({ name: "home" }); await flushPromises();
    const { view } = permissionFixture();
    let resolve;
    const earlier = new Promise(done => { resolve = done; });
    getPluginPermissions.mockImplementationOnce(() => earlier).mockResolvedValue(view);
    try {
      await flushPromises();
      expect(getPluginPermissions).toHaveBeenCalledTimes(1);
      await state.router.push('/NoteA'); await flushPromises();
      expect(document.querySelector('#permission-request-title')).not.toBeNull();
      expect(getPluginPermissions).toHaveBeenCalledTimes(2);
      expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    } finally { resolve(view); await flushPromises(); }
  });

  it("mandatory setup keeps requests pending and a late request load cannot reopen after login teardown", async () => {
    useGlobalStore().config.setupRequired = true; await flushPromises();
    const { view } = permissionFixture(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    let resolve;
    getPluginPermissions.mockImplementation(() => new Promise(done => { resolve = done; }));
    useGlobalStore().config.setupRequired = false; await flushPromises();
    expect(resolve).toBeTypeOf("function");
    await state.router.push({ name: "login" }); await flushPromises();
    resolve(view); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("read-only review discloses browser trust while disabling every decision", async () => {
    useGlobalStore().config.authType = "read_only";
    permissionFixture(); await flushPromises();
    const prompt = document.querySelector('[data-modal-top="true"]');
    expect(prompt.textContent).toContain("Read-only session");
    expect(decisionButton("Deny").disabled).toBe(true);
    expect(decisionButton("Approve selected request").disabled).toBe(true);
    expect(prompt.textContent).toContain("trusted same-origin application code");
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("review repairs: R26 a late automatic load postpones behind Access and retries only after its dialog closes", async () => {
    let resolve; const held = new Promise(done => { resolve = done; });
    getPluginPermissions.mockImplementationOnce(() => held);
    const { view } = permissionFixture(); await flushPromises();
    expect(getPluginPermissions).toHaveBeenCalledTimes(1);
    useGlobalStore().setupWizardRequested = true; await flushPromises();
    resolve(view); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("Access settings");
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    document.querySelector('[aria-label="Dismiss setup"]').click(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(2); expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("review repairs: R26 a real unrelated confirmation owns focus across the held load without deferring the request", async () => {
    let resolve; const held = new Promise(done => { resolve = done; });
    getPluginPermissions.mockImplementationOnce(() => held);
    const { view } = permissionFixture(); await flushPromises();
    // VTU installs a process-global VNode transformer at each mount. Keep the
    // same unrelated chrome stubs when mounting this real second dialog.
    const blocker = mount(ConfirmModal, { props: { modelValue: true, title: "Owned confirmation", message: "Keep this decision first" }, attachTo: document.body,
      global: { directives: { focus: { mounted: el => el.focus() } },
        stubs: { NavBar: true, SidebarPanel: true, SyncBanner: true, PrimeToast: true, QuickSwitcher: true, CommandPalette: true } } });
    try {
      await flushPromises(); const focus = document.activeElement;
      resolve(view); await flushPromises();
      expect(document.querySelector('#permission-request-title')).toBeNull();
      expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("Owned confirmation");
      expect(document.activeElement).toBe(focus); expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    } finally { blocker.unmount(); resolve(view); }
    await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(2); expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("review repairs: R26 failed permission load cannot open from cached catalogue state", async () => {
    getPluginPermissions.mockRejectedValueOnce(Error("unavailable permission read"));
    permissionFixture(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    pluginCatalog.value = { ...pluginCatalog.value }; await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(2);
  });
});
