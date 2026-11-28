// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { getIndexStatus, getNotes, getToken } from "../api.js";
import { refreshNoteIndex } from "../noteIndex.js";
import { createIdentityTokenStorage } from "../tokenStorage.js";
import { createIdentityApplication, IDENTITY_APPLICATION } from "../identityApplication.js";
import { accountProjection, identityFixtureIO } from "./helpers/account-projection.js";
import { useGlobalStore } from "../globalStore.js";
import Home from "../views/Home.vue";
import LogIn from "../views/LogIn.vue";
import NavBar from "../partials/NavBar.vue";
import SyncBanner from "../components/SyncBanner.vue";

const { toast } = vi.hoisted(() => ({ toast: { add: vi.fn() } }));
vi.mock("../api.js", async importOriginal => ({
  ...await importOriginal(),
  getNotes: vi.fn(), getTags: vi.fn().mockResolvedValue([]), getToken: vi.fn(),
  getIndexStatus: vi.fn(), apiErrorHandler: vi.fn(),
}));
vi.mock("../noteIndex.js", async importOriginal => ({ ...await importOriginal(), refreshNoteIndex: vi.fn() }));
vi.mock("primevue/usetoast", () => ({ useToast: () => toast }));

const wrappers = [];
const apps = [];
async function setup(Component, { path = "/", props } = {}) {
  const pinia = createPinia(); setActivePinia(pinia);
  const store = useGlobalStore();
  store.config = { ...accountProjection(), quickAccessLimit: 1, quickAccessSort: "lastModified", quickAccessTerm: "#inbox", quickAccessTitle: "Inbox" };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "home", component: { template: "<div/>" } },
    { path: "/_/search", name: "search", component: { template: "<div/>" } },
    { path: "/_/new", name: "new", component: { template: "<div/>" } },
    { path: "/:path(.*)", name: "note", component: { template: "<div/>" } },
  ] });
  await router.push(path); await router.isReady();
  const provide = {};
  let tokens;
  if (Component === LogIn) {
    store.config = accountProjection({ guest: true, level: "view" });
    tokens = createIdentityTokenStorage({ setCookie() {} });
    const app = createIdentityApplication({ config: () => store.config, setConfig: value => { store.config = value; },
      tokens, toast, store, navigate: target => router.push(target), applyBrand() {},
      transport: identityFixtureIO({ getToken, getConfig: async () => accountProjection(),
        getPluginHostCatalog: async () => ({ plugins: [] }), getNoteIndex: async () => [] }),
    });
    provide[IDENTITY_APPLICATION] = app;
    apps.push(app);
  }
  const wrapper = mount(Component, { props, global: { plugins: [pinia, router], provide } });
  wrappers.push(wrapper); await flushPromises();
  return { wrapper, router, store, tokens };
}

describe("I14 view wiring", () => {
  beforeEach(() => { vi.clearAllMocks(); getToken.mockReset(); getNotes.mockResolvedValue([]); });
  afterEach(async () => {
    wrappers.splice(0).forEach(w => w.unmount());
    for (const app of apps.splice(0)) (await app.dispose()).throwIfFailed();
    localStorage.clear(); sessionStorage.clear(); vi.useRealTimers();
  });

  it("renders quick-access rows, truncates the extra row and routes Show more", async () => {
    getNotes.mockResolvedValueOnce([{ path: "One" }, { path: "Two" }]);
    const { wrapper } = await setup(Home);
    expect(wrapper.text()).toContain("Inbox");
    expect(wrapper.find('a[href="/One"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/Two"]').exists()).toBe(false);
    expect(wrapper.get('a[title="Show more"]').attributes("href")).toBe("/_/search?term=%23inbox&sortBy=2");
  });

  it("shows the Home load-failure surface", async () => {
    getNotes.mockRejectedValueOnce(new Error("offline"));
    const { wrapper } = await setup(Home);
    expect(wrapper.text()).toContain("Loading Failed");
    expect(wrapper.text()).not.toContain("No notes yet");
  });

  it("submits the actual login form, persists Remember Me and follows redirect", async () => {
    getToken.mockResolvedValueOnce("access");
    const { wrapper, router, tokens } = await setup(LogIn, { props: { redirect: "/folder/note" } });
    expect(wrapper.findAll("form button").map(button => [button.attributes("type"), button.attributes("aria-label") ?? button.text()])).toEqual([
      ["button", "Show password"], ["submit", "Continue"],
    ]);
    expect(wrapper.get("#identity-login-password").attributes("type")).toBe("password");
    await wrapper.get("#identity-login-name").setValue("alice");
    await wrapper.get("#identity-login-password").setValue("secret");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(getToken).toHaveBeenCalledExactlyOnceWith("alice", "secret", "");
    expect([tokens.getStoredToken(), localStorage.getItem(tokens.scope.key)]).toEqual(["access", "access"]);
    expect(router.currentRoute.value.path).toBe("/folder/note");
  });

  it("clears a failed authenticator code and erases the password on Use another account, retaining Remember Me", async () => {
    getToken.mockRejectedValueOnce({ response: { status: 401, data: { code: "authenticator_required" } } })
      .mockRejectedValueOnce({ response: { status: 401 } });
    const { wrapper, tokens } = await setup(LogIn);
    await wrapper.get("#identity-login-name").setValue("alice");
    await wrapper.get("#identity-login-password").setValue("secret");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(wrapper.find("#identity-login-password").exists()).toBe(false);
    await wrapper.get("#identity-login-code").setValue("123456");
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(getToken.mock.calls).toEqual([["alice", "secret", ""], ["alice", "secret", "123456"]]);
    expect(wrapper.get("#identity-login-code").element.value).toBe("");
    expect(tokens.getStoredToken()).toBeNull();
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Login Failed" }));
    await wrapper.get('button[type="button"]').trigger("click");
    for (const id of ["identity-login-name", "identity-login-password"]) expect(wrapper.get(`#${id}`).element.value).toBe("");
    expect(wrapper.get('input[type="checkbox"]').element.checked).toBe(true);
  });

  it.each([
    ["/folder/note", "/_/new?folder=folder"],
    ["/_/search?folder=deep%2Ffolder", "/_/new?folder=deep/folder"],
  ])("keeps NavBar creation in context %s and reacts to read-only permission", async (path, target) => {
    const { wrapper, store } = await setup(NavBar, { path });
    expect(wrapper.get('[title="New note"]').element.closest("a").getAttribute("href")).toBe(target);
    store.config = accountProjection({ level: "view" }); await flushPromises();
    expect(wrapper.find('[title="New note"]').exists()).toBe(false);
  });

  it("renders polled progress, hides on completion and refreshes the consumer index", async () => {
    vi.useFakeTimers();
    getIndexStatus.mockResolvedValueOnce({ syncing: true, done: 2, total: 10 })
      .mockResolvedValueOnce({ syncing: false, done: 10, total: 10 });
    const { wrapper } = await setup(SyncBanner);
    expect(wrapper.text()).toContain("Indexing notes");
    expect(wrapper.text()).toContain("(2/10)");
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(wrapper.text()).toBe("");
    expect(refreshNoteIndex).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains an initial status failure at the mounted banner without fabricating progress", async () => {
    const error = new Error("initial read failed");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getIndexStatus.mockRejectedValueOnce(error);
      const { wrapper } = await setup(SyncBanner);
      expect(wrapper.text()).toBe("");
      expect(refreshNoteIndex).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[indexStatus] poll failed", error);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("retains the rendered banner through a rejected timer read and hides only on actual completion", async () => {
    vi.useFakeTimers();
    const error = new Error("interval read failed");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getIndexStatus.mockResolvedValueOnce({ syncing: true, done: 3, total: 9 })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ syncing: false, done: 9, total: 9 });
      const { wrapper } = await setup(SyncBanner);
      await vi.advanceTimersByTimeAsync(3000); await flushPromises();
      expect(wrapper.text()).toContain("(3/9)");
      expect(refreshNoteIndex).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[indexStatus] poll failed", error);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(3000); await flushPromises();
      expect(wrapper.text()).toBe("");
      expect(refreshNoteIndex).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      diagnostic.mockRestore();
    }
  });
});
