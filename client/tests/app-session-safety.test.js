import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watch } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, isNavigationFailure } from "vue-router";
import App from "../App.vue";
import NoteView from "../views/Note.vue";
import LogIn from "../views/LogIn.vue";
import Setup from "../views/Setup.vue";
import { hasUnsavedWork } from "../sessionActions.js";
import { dispatchAction } from "../keybindings/dispatcher.js";
import { publish, subscribe, TOPICS } from "../bus/index.js";
import { getStoredToken, storeToken } from "../tokenStorage.js";
import { getConfig, getToken, updateNote, postIdentitySetup, putIdentityAccess, patchOwnAccount, getOwnAccount, postAccountTotpEnrolment, getIdentityAccess, getPluginHostCatalog, getPluginPermissions, getPluginPermissionRequests, decidePluginPermissionRequest, putPluginEnabled, getPluginSettings, putPluginSettings } from "../api.js";
import { pluginCatalog, refreshPluginRuntimeCatalog } from "../pluginRuntime.js";
import ConfirmModal from "../components/ConfirmModal.vue";
import SettingsModal from "../components/SettingsModal.vue";
import { IDENTITY_APPLICATION } from "../identityApplication.js";
import { reauthenticationRequest } from "../reauthentication.js";
import { accountProjection, identityFixtureIO, scopedDraftKey } from "./helpers/account-projection.js";

const state = vi.hoisted(() => ({ router: null, http: null }));
vi.mock("../router.js", () => ({ bindIdentityRouteSession: () => () => {}, default: {
  get currentRoute() { return state.router.currentRoute; },
  get options() { return state.router.options; },
  push(...args) { return state.router.push(...args); },
  replace(...args) { return state.router.replace(...args); },
} }));
vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock("axios", async importOriginal => {
  const { default: axios } = await importOriginal();
  return { default: { ...axios, create: options => axios.create({ ...options,
    adapter: config => state.http ? state.http(config) : axios.getAdapter(axios.defaults.adapter)(config),
  }) } };
});
vi.mock("../api.js", async importOriginal => {
  const api = await importOriginal();
  return {
  ...api,
  createIdentityApi: options => state.http ? api.createIdentityApi(options) :
    identityFixtureIO({ getConfig, getToken, getPluginHostCatalog, getNoteIndex: async () => [{ path: "NoteA" }] }),
  getDrivers: vi.fn(async () => ({revision:0,instances:[],plugins:[]})),
  getConflicts: vi.fn(async () => ({ revision: 0, total: 0, conflicts: [] })),
  getConfig: vi.fn(), getToken: vi.fn(), getNote: vi.fn(async path => ({ path, content: "Seed\n" })),
  getNoteIndex: vi.fn(async () => [{ path: "NoteA" }]), getPlugins: vi.fn(async () => []),
  getRenderedHtml: vi.fn(async () => "<p>Seed</p>"), getTree: vi.fn(async () => []),
  getIndexStatus: vi.fn(async () => ({ syncing: false })), getNotes: vi.fn(async () => []),
  updateNote: vi.fn(), createNote: vi.fn(), deleteNote: vi.fn(), previewRename: vi.fn(async () => []),
  operationError: vi.fn(() => null), apiErrorHandler: vi.fn(), uploadFile: vi.fn(), renderBuffer: vi.fn(),
  getPluginHostCatalog: vi.fn(async () => ({ plugins: [] })), getPluginSettings: vi.fn(),
  putPluginSettings: vi.fn(), putPluginPolicy: vi.fn(), putPluginEnabled: vi.fn(),
  getPluginPermissions: vi.fn(), putPluginPermissions: vi.fn(), getPluginPermissionRequests: vi.fn(async () => []), decidePluginPermissionRequest: vi.fn(),
  invokePluginCommand: vi.fn(), postIdentitySetup: vi.fn(), postBrand: vi.fn(),
  getOwnAccount: vi.fn(), patchOwnAccount: vi.fn(), postAccountTotpEnrolment: vi.fn(),
  getIdentityAccess: vi.fn(), putIdentityAccess: vi.fn(),
  };
});
vi.mock("../themes.js", async () => {
  const { ref } = await import("vue");
  return { currentTheme: ref("system"), THEMES: [], themePreviews:()=>[{id:'system',label:'System',nowShowing:'Globnotes Light',pair:[]}], initTheme: vi.fn(), setTheme: vi.fn(), currentThemeLabel: ref("System"), resolvedTheme: ref({}) };
});
vi.mock("../brand.js", async importOriginal => ({ ...await importOriginal(), applyBrandToDocument: vi.fn() }));
const accountToken = "session-fixture-token";
const guestView = () => accountProjection({ guest: true, level: "view" });
const stubs = { SidebarPanel: true, SyncBanner: true, PrimeToast: true, QuickSwitcher: true, CommandPalette: true };
let wrapper, app;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/NoteA");
  getPluginHostCatalog.mockResolvedValue({ plugins: [] });
  getPluginPermissionRequests.mockResolvedValue([]);
  updateNote.mockResolvedValue({ path: "NoteA", content: "Seed\n" });
  getOwnAccount.mockResolvedValue({ login: "alice", credentialRevision: 1, totpEnabled: false, passwordChangeRequired: false });
  getIdentityAccess.mockResolvedValue({ vaultId: "fixture", revision: 1, signature: "acl1", everybody: "edit",
    grants: { alice: "admin" }, named: [{ id: "alice", login: "alice", level: "admin" }], declaredAdmin: { accountId: null, pinned: false } });
  putIdentityAccess.mockImplementation(async ({ updateId }) => ({ committed: true, updateId }));
});
async function mountApp({ projection = accountProjection(), path = "/NoteA" } = {}) {
  if (projection.principal.kind === "account") storeToken(accountToken, true);
  getConfig.mockImplementation(async () =>
    projection.principal.kind === "guest" || getStoredToken() === accountToken ? projection : guestView());
  const pinia = createPinia();
  setActivePinia(pinia);
  state.router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "home", component: { template: "<p>Home</p>" } },
    { path: "/_/login", name: "login", component: LogIn },
    { path: "/_/setup", name: "setup", component: Setup },
    { path: "/_/new", name: "new", component: NoteView },
    { path: "/_/search", name: "search", component: { template: "<p>Search</p>" } },
    { path: "/_/conflicts", name: "conflicts", component: { template: "<p>Conflicts</p>" } },
    { path: "/:path(.*)", name: "note", component: NoteView, props: true },
  ] });
  await state.router.push(path);
  await state.router.isReady();
  wrapper = mount(App, { attachTo: document.body, global: {
    plugins: [pinia, state.router], directives: { focus: { mounted: el => el.focus() } },
    stubs,
  } });
  app = wrapper.vm.$.provides[IDENTITY_APPLICATION];
  await flushPromises();
}
afterEach(async () => {
  wrapper?.unmount(); wrapper = null;
  if (app) (await app.dispose()).throwIfFailed();
  app = null;
  state.http = null;
  vi.unstubAllGlobals();
});
const visibleButton = (text, scope = document) => [...scope.querySelectorAll("button")].find(button => button.textContent.trim() === text && button.style.display !== "none");
const decisionButton = text => visibleButton(text, document.querySelector('[data-modal-top="true"]'));
async function openSettings(page) { dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page }); await flushPromises(); }
async function setInput(selector, value) {
  const field = document.querySelector(selector); expect(field).not.toBeNull();
  field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); await flushPromises();
}
async function saveGuestView() {
  const field = document.querySelector("#access-everybody"); expect(field).not.toBeNull();
  field.value = JSON.stringify("view"); field.dispatchEvent(new Event("change", { bubbles: true })); await flushPromises();
  visibleButton("Save access").click(); await flushPromises();
}
async function publishCatalog(catalog) {
  getPluginHostCatalog.mockResolvedValue(catalog);
  expect((await refreshPluginRuntimeCatalog()).status).toBe("accepted");
  await flushPromises();
}
const rootCatalog = () => ({ policy: { revision: 0, signature: "p0", effectiveAutoEnable: true }, plugins: [
  { id: "inventory", name: "Inventory", enabled: true, runtime: {}, pages: [], blocking: { actions: [] } },
] });
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
  it("optional guest sign-in open/dismiss preserves the same immediate dirty editor", async () => {
    await mountApp({ projection: accountProjection({ guest: true, level: "edit" }) });
    const content = await editImmediately();
    visibleButton("Sign in").click(); await flushPromises();
    expect(document.querySelector("#identity-login-name")).not.toBeNull();
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(content.textContent).toContain("immediate dirty marker");
    document.querySelector('[data-modal-top="true"] [aria-label="Close"]').click();
    await flushPromises();
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(hasUnsavedWork()).toBe(true);
  });

  it("a retained resumed draft is dirty before the display debounce", async () => {
    const projection = accountProjection();
    localStorage.setItem(scopedDraftKey(projection, "NoteA"), JSON.stringify({ value: "resumed draft\n", order: 0 }));
    await mountApp({ projection });
    visibleButton("Edit").click();
    await flushPromises();
    visibleButton("Resume Draft").click();
    await flushPromises();
    expect(document.querySelector(".cm-content").textContent).toContain("resumed draft");
    expect(hasUnsavedWork()).toBe(true);
  });

  it("Note teardown removes its participant rather than leaving stale dirty work", async () => {
    await mountApp();
    await editImmediately();
    expect(hasUnsavedWork()).toBe(true);
    wrapper.unmount();
    wrapper = null;
    expect(hasUnsavedWork()).toBe(false);
  });

  it.each(["Cancel", "Discard", "Save"])("Logout %s resolves immediate typing before clearing credentials", async choice => {
    await mountApp();
    expect(pluginCatalog.value).toEqual({ plugins: [] });
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
    const routeResults = [];
    const stop = state.router.afterEach((to, from, failure) => routeResults.push([from.name, to.name, isNavigationFailure(failure) && failure.type]));
    decisionButton(choice).click();
    await flushPromises();
    stop();
    if (choice === "Cancel") {
      expect(getStoredToken()).toBe("session-fixture-token");
      expect(document.querySelector(".cm-content")).toBe(content);
      expect(content.textContent).toContain("immediate dirty marker");
      expect(state.router.currentRoute.value.name).toBe("note");
    } else {
      expect(getStoredToken()).toBeNull();
      expect(routeResults).toEqual([["note", "login", false]]);
      expect(state.router.currentRoute.value.name).toBe("login");
    }
    expect(updateNote).toHaveBeenCalledTimes(choice === "Save" ? 1 : 0);
    expect(localStorage.getItem("unrelated-preference")).toBe("preserve-me");
  });

  it("blocked Logout Save keeps credentials, editor and Settings mounted", async () => {
    await mountApp();
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

  it("one Escape cancels the Note decision without dismissing the pending Access choices", async () => {
    await mountApp();
    const content = await editImmediately();
    await openSettings("core:access");
    await saveGuestView();
    expect(document.body.textContent).toContain("Save Changes");
    const prompt = document.querySelector('[data-modal-top="true"]');
    expect(prompt.closest("[inert]")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushPromises();
    expect(document.querySelector("#settings-modal-title")).not.toBeNull();
    expect(document.querySelector("#access-everybody").selectedOptions[0].textContent).toBe("View");
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(postIdentitySetup).not.toHaveBeenCalled();
    expect(putIdentityAccess).not.toHaveBeenCalled();
  });

  it("Logout cannot clear credentials while an already-admitted toolbar Save is unresolved", async () => {
    await mountApp();
    const content = await editImmediately();
    let acknowledge;
    updateNote.mockImplementation((_, path, text) => new Promise(resolve => { acknowledge = () => resolve({ path, content: text }); }));
    try {
      visibleButton("Save").click();
      await flushPromises();
      expect(updateNote).toHaveBeenCalledTimes(1);
      await openSettings("core:account");
      visibleButton("Log out").click();
      await flushPromises();
      // The write has neither succeeded nor failed yet. Revoking its current
      // credentials or destroying its buffer here cannot be a safe handoff.
      const liveEditor = document.querySelector(".cm-content");
      expect({ token: getStoredToken(), sameEditor: liveEditor === content, bufferVisible: liveEditor?.textContent.includes("immediate dirty marker") ?? false, route: state.router.currentRoute.value.name }).toEqual({ token: accountToken, sameEditor: true, bufferVisible: true, route: "note" });
    } finally { acknowledge?.(); await flushPromises(); }
  });

  it("stream retirement before the Save refusal still retries only that Save with its original base after sign-in", async () => {
    const original = accountProjection(), draft = scopedDraftKey(original, "NoteA"), restoredToken = "restored-token";
    const restored = accountProjection({ generation: "restored-session" });
    const refusal = { response: { status: 401, data: { code: "credentials_refused" } } };
    const wire = Promise.withResolvers(), wireEntered = Promise.withResolvers();
    const config = Promise.withResolvers(), configEntered = Promise.withResolvers();
    const stream = Promise.withResolvers(), opened = Promise.withResolvers(), closed = Promise.withResolvers();
    const saved = Promise.withResolvers(), writes = [], proofs = [];
    let revoked = false;
    // Keep Axios requests, authenticated SSE close, and all session/recovery
    // consumers real. Only model the server's response/stream boundaries.
    const { updateNote: sendSave } = await vi.importActual("../api.js");
    updateNote.mockImplementation(sendSave);
    state.http = async request => {
      const bearer = request.headers.get("Authorization");
      switch (`${request.method} ${request.url}`) {
        case "get config":
          if (bearer === `Bearer ${restoredToken}`) return { data: restored };
          if (!revoked && bearer === `Bearer ${accountToken}`) return { data: original };
          configEntered.resolve();
          return config.promise;
        case "get plugin-host": return { data: { plugins: [] } };
        case "get note-index": return { data: [{ path: "NoteA" }] };
        case "post token": {
          const proof = JSON.parse(request.data);
          proofs.push(proof);
          if (proof.password !== "valid") throw refusal;
          return { data: { access_token: restoredToken } };
        }
        case "patch notes/NoteA": {
          const body = JSON.parse(request.data);
          writes.push({ bearer, body, params: request.params });
          if (writes.length === 1) { wireEntered.resolve(); return wire.promise; }
          return { data: { path: body.newPath, content: body.newContent } };
        }
        default: throw Error(`Unexpected request: ${request.method} ${request.url}`);
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url, { headers }) => {
      if (revoked && headers.authorization === `Bearer ${accountToken}`) return new Response(null, { status: 401 });
      return new Response(new ReadableStream({
      start(controller) {
        if (url.startsWith("/_/api/changes?") && headers.authorization === `Bearer ${accountToken}`) stream.resolve(controller);
      },
      }), { headers: { "content-type": "text/event-stream" } });
    }));
    const stop = watch(reauthenticationRequest, request => (request ? opened : closed).resolve());
    const off = subscribe(TOPICS.NOTE_SAVE, saved.resolve);

    async function submit(password) {
      const form = document.querySelector("[data-reauthentication] form");
      expect(form).not.toBeNull();
      await setInput("#identity-login-name", original.principal.login);
      await setInput("#identity-login-password", password);
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await flushPromises();
    }
    try {
      await mountApp();
      const content = await editImmediately();
      const captured = { newPath: "NoteA", newContent: "immediate dirty marker\n", baseContent: "Seed\n" };
      const write = token => ({ bearer: `Bearer ${token}`, body: captured, params: { file_refs: "none" } });
      visibleButton("Save").click();
      await wireEntered.promise;
      expect(writes).toEqual([write(accountToken)]);
      revoked = true;
      (await stream.promise).close();
      await configEntered.promise;
      expect(app.session.key()).toBeNull();
      wire.reject(refusal);
      await flushPromises();
      expect(document.querySelector("[data-note-save-status]").textContent).toContain("Sign in to finish saving");
      config.reject(refusal);
      await opened.promise;
      await submit("wrong");
      expect({ proofs, departure: document.body.textContent.includes("Save Changes"), writes }).toEqual({
        proofs: [{ username: "alice", password: "wrong" }], departure: false, writes: [write(accountToken)],
      });
      expect(document.querySelector(".cm-content")).toBe(content);
      expect(content.textContent).toContain("immediate dirty marker");
      expect(JSON.parse(localStorage.getItem(draft))?.value).toBe("immediate dirty marker\n");
      expect(state.router.currentRoute.value.path).toBe("/NoteA");
      await submit("valid");
      expect(proofs).toEqual([{ username: "alice", password: "wrong" }, { username: "alice", password: "valid" }]);
      expect(getStoredToken()).toBe(restoredToken);
      await closed.promise; await flushPromises();
      expect(writes).toEqual([write(accountToken), write(restoredToken)]);
      expect(await saved.promise).toEqual({ path: "NoteA" });
      expect(document.querySelector("[data-reauthentication]")).toBeNull();
      expect(document.body.textContent).not.toContain("Save Changes");
      expect(document.querySelector(".cm-content")).toBe(content);
      expect(state.router.currentRoute.value.path).toBe("/NoteA");
      expect(hasUnsavedWork()).toBe(false);
      expect(localStorage.getItem(draft)).toBeNull();
    } finally {
      stop(); off();
      wire.resolve(); config.resolve();
      visibleButton("Cancel", document.querySelector("[data-reauthentication]") ?? document.createElement("div"))?.click();
    }
  });

  it("Logout waits for A/B and then asks about newer unsent D", async () => {
    await mountApp();
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
    await mountApp();
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
    await mountApp();
    await editImmediately(); updateNote.mockRejectedValue(new Error("transport lost"));
    visibleButton("Save").click(); await flushPromises();
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:account" }); await flushPromises(); visibleButton("Log out").click(); await flushPromises();
    expect(getStoredToken()).toBe("session-fixture-token"); expect(document.body.textContent).not.toContain("Save Changes"); expect(document.querySelector(".cm-content")).not.toBeNull();
  });

  it("Save access keeps the in-place update pending until the foreground Save succeeds", async () => {
    await mountApp();
    await editImmediately(); let acknowledge;
    updateNote.mockImplementation((path, target, text) => new Promise(resolve => { acknowledge = () => resolve({ path: target, content: text }); }));
    visibleButton("Save").click(); await flushPromises();
    await openSettings("core:access");
    await saveGuestView();
    expect(postIdentitySetup).not.toHaveBeenCalled();
    expect(putIdentityAccess).not.toHaveBeenCalled();
    acknowledge(); await flushPromises();
    expect(postIdentitySetup).not.toHaveBeenCalled();
    expect(putIdentityAccess).toHaveBeenCalledExactlyOnceWith({ revision: 1, signature: "acl1", everybody: "view",
      grants: { alice: "admin" }, updateId: expect.any(String) }, { token: accountToken });
    expect(document.body.textContent).toContain("Access saved.");
    expect(state.router.currentRoute.value.name).toBe("note");
  });
  it("direct editor action publication cannot save behind the real Settings dialog", async () => {
    await mountApp();
    const content=await editImmediately(); dispatchAction(TOPICS.APP_OPEN_SETTINGS,{page:'core:appearance'}); await flushPromises();
    publish(TOPICS.EDITOR_SAVE); await flushPromises();
    expect(updateNote).not.toHaveBeenCalled(); expect(document.querySelector('.cm-content')).toBe(content); expect(content.textContent).toContain('immediate dirty marker');
  });
  it("a confirmed change of authenticator signs out before config replies; the next sign-in follows the account challenge", async () => {
    await mountApp();
    localStorage.setItem("unrelated-preference", "retained");
    await openSettings("core:account");
    postAccountTotpEnrolment.mockResolvedValue({ key: "fixture-new-key", qr: "data:image/png;base64,test", secret: "fixture-secret" });
    visibleButton("Add authenticator").click(); await flushPromises();
    await setInput("#account-dialog-current-password", "current-password");
    await setInput("#account-new-code", "123456");
    document.querySelector('[data-modal-top="true"] form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    patchOwnAccount.mockImplementation(async ({ updateId }) => ({ requiresLogin: true, updateId }));
    let reply;
    const pendingConfig = new Promise(resolve => { reply = resolve; });
    getConfig.mockImplementation(() => pendingConfig);
    try {
      decisionButton("Change and log out").click(); await flushPromises();
      expect(patchOwnAccount).toHaveBeenCalledExactlyOnceWith({ revision: 1, updateId: expect.any(String), currentPassword: "current-password",
        totp: { enabled: true, key: "fixture-new-key", code: "123456" } }, { token: accountToken });
      expect(state.router.currentRoute.value.name).toBe("login"); expect(getStoredToken()).toBeNull();
      getToken.mockRejectedValueOnce({ response: { status: 401, data: { code: "authenticator_required" } } });
      await setInput("#identity-login-name", "alice"); await setInput("#identity-login-password", "current-password");
      visibleButton("Continue").click(); await flushPromises();
      expect(getToken).toHaveBeenCalledExactlyOnceWith("alice", "current-password", "");
      expect(document.querySelector("#identity-login-code")).not.toBeNull();
      expect(localStorage.getItem("unrelated-preference")).toBe("retained");
    } finally { reply(guestView()); await flushPromises(); }
  });
  it("review repairs: R13 an uncertain inventory response aborts real App Logout and preserves credentials after late success", async () => {
    await mountApp();
    vi.useFakeTimers(); let resolve;
    await publishCatalog(rootCatalog());
    putPluginEnabled.mockImplementation(() => new Promise(done => { resolve = done; }));
    try {
      dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:plugins" }); await flushPromises();
      document.querySelector('[data-plugin-inventory-id="inventory"] button').click(); await flushPromises();
      wrapper.findComponent(SettingsModal).vm.$emit("logout"); await vi.advanceTimersByTimeAsync(5001); await flushPromises();
      expect(getStoredToken()).toBe(accountToken); expect(state.router.currentRoute.value.name).toBe("note");
      expect(document.querySelector('#settings-modal-title')).not.toBeNull();
      resolve({ policy: { revision: 1, signature: "p1" } }); await flushPromises();
      expect(getStoredToken()).toBe(accountToken); expect(state.router.currentRoute.value.name).toBe("note");
      expect(putPluginEnabled).toHaveBeenCalledTimes(1);
    } finally { resolve?.({ policy: { revision: 1, signature: "p1" } }); vi.useRealTimers(); await flushPromises(); }
  });
  it("review repairs: R13 Access submission cannot overtake an inventory wire and late ACK does not resume its failed handoff", async () => {
    await mountApp();
    vi.useFakeTimers(); let resolve;
    await publishCatalog(rootCatalog());
    putPluginEnabled.mockImplementation(() => new Promise(done => { resolve = done; }));
    try {
      dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:plugins" }); await flushPromises();
      document.querySelector('[data-plugin-inventory-id="inventory"] button').click(); await flushPromises();
      expect(putPluginEnabled).toHaveBeenCalledTimes(1);
      // The current UI will not switch away from a held inventory write. Drive
      // the same App-owned Access intent directly to exercise its own fence.
      const { access } = wrapper.findComponent(SettingsModal).props("identityControllers");
      await access.load(); access.setEverybody("view");
      expect(access.state.canSave).toBe(true);
      const submission = access.requestCommit();
      await vi.advanceTimersByTimeAsync(5001); await flushPromises();
      expect(await submission).toBe(false); expect(putIdentityAccess).not.toHaveBeenCalled();
      resolve({ policy: { revision: 1, signature: "p1" } }); await flushPromises();
      expect(putIdentityAccess).not.toHaveBeenCalled();
      expect([access.state.dirty, access.state.everybody, getStoredToken(), state.router.currentRoute.value.name]).toEqual([true, "view", accountToken, "note"]);
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
    const catalog = { plugins: [{ id: "p", name: "Prompt plugin", enabled: true, runtime: { server: true }, permissions: view, pages: [] }] };
    return { request, view, catalog };
  }

  it("Escape defers one request, restores the underlying Settings focus and grants nothing", async () => {
    await mountApp();
    dispatchAction(TOPICS.APP_OPEN_SETTINGS, { page: "core:plugins" }); await flushPromises();
    const opener = document.activeElement;
    const { catalog } = permissionFixture();
    await publishCatalog(catalog);
    const prompt = document.querySelector('[data-modal-top="true"]');
    expect(prompt.textContent).toContain("Prompt plugin asks for network access");
    expect(prompt.contains(document.activeElement)).toBe(true);
    expect(document.querySelector('[data-app-shell]').hasAttribute("inert")).toBe(true);
    expect(document.querySelector('#settings-modal-title').closest('[data-modal-top]').hasAttribute("inert")).toBe(true);
    expect(prompt.textContent).toContain("<b>Escaped reason</b>");
    expect(prompt.querySelector("b")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('#settings-modal-title')).not.toBeNull();
    await publishCatalog(catalog);
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("Deny persists only the request decision and never selects master or grants", async () => {
    await mountApp();
    const { view, catalog } = permissionFixture(); await publishCatalog(catalog);
    decidePluginPermissionRequest.mockResolvedValue({ view: { ...view, revision: 3, signature: "v3", pendingRequests: [] } });
    getPluginPermissionRequests.mockResolvedValue([]);
    decisionButton("Deny").click(); await flushPromises();
    expect(decidePluginPermissionRequest).toHaveBeenCalledWith("p", "request-A", { revision: 2, signature: "v2", requestSourceKey: "source-A", requestSourceRevision: 1,
      decision: "deny", allowNetwork: false, approvedNetwork: [], approvedImports: [] });
    expect(document.querySelector('#permission-request-title')).toBeNull();
  });
  it('Needs attention opens a postponed request over an invalid plugin draft without page/tab departure', async () => {
    await mountApp();
    const { catalog } = permissionFixture();
    await publishCatalog(catalog);
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true})); await flushPromises();
    const definition=id=>({id,label:id,renderer:{kind:'declarative-v1',version:1},fields:[{key:'limit',label:'Limit',type:'number',min:1,default:5}]});
    getPluginSettings.mockResolvedValue({revision:0,values:{limit:5}});
    await publishCatalog({ plugins: [{ ...catalog.plugins[0], pages: [definition('settings'), definition('other')] }] });
    dispatchAction(TOPICS.APP_OPEN_SETTINGS,{page:'plugin:p:settings'}); await flushPromises();
    const input=document.querySelector('#settings-field-limit'); expect(input).not.toBeNull();
    input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); await flushPromises();
    const field=document.querySelector('#settings-field-limit'),tab=document.querySelector('[role=tab][aria-selected=true]'),url=location.href;
    expect(field.value).toBe('');
    const group=document.querySelector('[data-settings-attention]'); expect(group).not.toBeNull();
    expect(group.querySelector('h3').textContent).toBe('Needs attention (1)');
    const entry=group.querySelector('button'); expect(entry.hasAttribute('aria-current')).toBe(false); entry.click(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(document.querySelector('#settings-field-limit')).toBe(field); expect(field.value).toBe('');
    expect(document.querySelector('[role=tab][aria-selected=true]')).toBe(tab);
    expect(document.querySelector('[data-settings-content]').dataset.settingsCurrentPage).toBe('plugin:p:settings');
    expect(location.href).toBe(url); expect(document.body.textContent).not.toContain('Unsaved changes');
    expect(putPluginSettings).not.toHaveBeenCalled(); expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("source retirement closes an old prompt before any stale decision can be sent", async () => {
    await mountApp();
    const { view, catalog } = permissionFixture(); await publishCatalog(catalog);
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    const source = { ...view.source, key: "source-B", revision: 2, codeFingerprint: "code-B" };
    const replacement = { ...view, source, requestSourceKey: source.key, requestSourceRevision: 2, pendingRequests: [] };
    getPluginPermissions.mockResolvedValue(replacement); getPluginPermissionRequests.mockResolvedValue([]);
    await publishCatalog({ plugins: [{ ...catalog.plugins[0], permissions: replacement }] });
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("catalogue removal retires a prompt immediately even while pending-request refresh is unresolved", async () => {
    await mountApp();
    const { request, catalog } = permissionFixture(); await publishCatalog(catalog);
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(1);
    let reply;
    getPluginPermissionRequests.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    await publishCatalog({ plugins: [] });
    expect(document.querySelector('#permission-request-title')).toBeNull();
    reply([request]); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(1);
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("initial route readiness re-admits pending review after fencing a load from the previous route", async () => {
    await mountApp({ path: "/" });
    const { view, catalog } = permissionFixture();
    let resolve;
    const earlier = new Promise(done => { resolve = done; });
    getPluginPermissions.mockImplementationOnce(() => earlier).mockResolvedValue(view);
    try {
      await publishCatalog(catalog);
      expect(getPluginPermissions).toHaveBeenCalledTimes(1);
      await state.router.push('/NoteA'); await flushPromises();
      expect(document.querySelector('#permission-request-title')).not.toBeNull();
      expect(getPluginPermissions).toHaveBeenCalledTimes(2);
      expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    } finally { resolve(view); await flushPromises(); }
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(2);
  });

  it("mandatory setup keeps requests pending and a late request load cannot reopen after login teardown", async () => {
    const unconfigured = accountProjection({ guest: true, level: "none", setupRequired: true });
    await mountApp({ projection: unconfigured, path: "/_/setup" });
    const { view, catalog } = permissionFixture();
    expect(document.querySelector('#identity-setup-title')).not.toBeNull();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(getPluginHostCatalog).not.toHaveBeenCalled();
    expect(getPluginPermissionRequests).not.toHaveBeenCalled();
    expect(getPluginPermissions).not.toHaveBeenCalled();
    getPluginHostCatalog.mockResolvedValue(catalog);
    let resolve;
    getPluginPermissions.mockImplementation(() => new Promise(done => { resolve = done; }));
    postIdentitySetup.mockResolvedValue({ access_token: accountToken });
    getConfig.mockImplementation(async () => getStoredToken() === accountToken ? accountProjection() : unconfigured);
    await setInput("#setup-login", "alice"); await setInput("#setup-password", "setup-account-password");
    visibleButton("Finish setup").click(); await flushPromises();
    expect(state.router.currentRoute.value.name).toBe("home");
    expect(resolve).toBeTypeOf("function");
    await state.router.push({ name: "login" }); await flushPromises();
    resolve(view); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("a View guest only receives the reader plugin catalogue and cannot review or decide requests", async () => {
    const { catalog } = permissionFixture();
    const [plugin] = catalog.plugins;
    const reader = { id: plugin.id, name: plugin.name, enabled: true, runtime: { client: false } };
    getPluginHostCatalog.mockResolvedValue({ plugins: [reader] });
    await mountApp({ projection: guestView() });
    expect(pluginCatalog.value.plugins).toEqual([reader]);
    expect(document.querySelector('#permission-request-title')).toBeNull();
    await openSettings('core:plugins');
    expect(document.querySelector('[data-settings-attention]')).toBeNull();
    expect(visibleButton('Deny')).toBeUndefined();
    expect(visibleButton('Approve')).toBeUndefined();
    expect(document.querySelector('[data-settings-nav-id="core:plugins"], [data-plugin-trust-notice]')).toBeNull();
    expect(getPluginPermissionRequests).not.toHaveBeenCalled();
    expect(getPluginPermissions).not.toHaveBeenCalled();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("review repairs: R26 a late automatic load postpones behind Access and retries only after its dialog closes", async () => {
    await mountApp();
    await openSettings("core:access");
    let resolve; const held = new Promise(done => { resolve = done; });
    getPluginPermissions.mockImplementationOnce(() => held);
    const { view, catalog } = permissionFixture(); await publishCatalog(catalog);
    expect(getPluginPermissions).toHaveBeenCalledTimes(1);
    visibleButton("Add existing account").click(); await flushPromises();
    expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("Add existing account");
    resolve(view); await flushPromises();
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("Add existing account");
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    document.querySelector('[data-modal-top="true"] [aria-label="Close"]').click(); await flushPromises();
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(2); expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
  });

  it("review repairs: R26 a real unrelated confirmation owns focus across the held load without deferring the request", async () => {
    await mountApp();
    let resolve; const held = new Promise(done => { resolve = done; });
    getPluginPermissions.mockImplementationOnce(() => held);
    const { view, catalog } = permissionFixture(); await publishCatalog(catalog);
    // VTU installs a process-global VNode transformer at each mount. Keep the
    // same unrelated chrome stubs when mounting this real second dialog.
    const blocker = mount(ConfirmModal, { props: { modelValue: true, title: "Owned confirmation", message: "Keep this decision first" }, attachTo: document.body,
      global: { directives: { focus: { mounted: el => el.focus() } },
        stubs } });
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
    await mountApp();
    getPluginPermissions.mockRejectedValueOnce(Error("unavailable permission read"));
    const { catalog } = permissionFixture();
    await publishCatalog(catalog);
    expect(document.querySelector('#permission-request-title')).toBeNull();
    expect(decidePluginPermissionRequest).not.toHaveBeenCalled();
    await publishCatalog(catalog);
    expect(document.querySelector('#permission-request-title')).not.toBeNull();
    expect(getPluginPermissions).toHaveBeenCalledTimes(2);
  });
});
