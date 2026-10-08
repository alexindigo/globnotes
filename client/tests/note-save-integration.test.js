import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../App.vue";
import NoteView from "../views/Note.vue";
import { useGlobalStore } from "../globalStore.js";
import { getConfig, getNote, deleteNote, updateNote, createNote, previewRename, renderBuffer, apiErrorHandler } from "../api.js";
import { hasUnsavedWork } from "../sessionActions.js";
import { Note } from "../classes.js";
import { dispatchAction } from "../keybindings/dispatcher.js";
import { TOPICS } from "../bus/index.js";

const holder = vi.hoisted(() => ({ router: null }));
const deferredWys = vi.hoisted(() => ({ ready: false, content: "" }));
const toastConsumer = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../components/WysiwygEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup(_, { expose }) {
    expose({ getSnapshot: () => deferredWys.ready ? { ready: true, content: deferredWys.content } : { ready: false }, getMarkdown: () => "", isWysiwygMode: () => true });
    return () => h("div", { class: "deferred-wys" });
  } }) };
});
vi.mock("../router.js", () => ({ default: {
  get currentRoute() { return holder.router.currentRoute; },
  get options() { return holder.router.options; },
  push(...args) { return holder.router.push(...args); },
  replace(...args) { return holder.router.replace(...args); },
} }));
vi.mock("primevue/usetoast", () => ({ useToast: () => toastConsumer }));
vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  const pluginCatalog = ref(null);
  return { pluginCatalog, startPluginRuntime: vi.fn(), stopPluginRuntime: vi.fn(),
    refreshPluginRuntimeCatalog: vi.fn(async () => ({ status: "accepted", catalog: pluginCatalog.value })),
    capturePluginCatalogOwnership: vi.fn(() => ({ current: () => true })), acknowledgePluginPolicy: vi.fn(() => true) };
});
vi.mock("../api.js", async importOriginal => ({
  getConfig: vi.fn(), getNote: vi.fn(async path => ({ path, content: "Seed\n" })),
  getNoteIndex: vi.fn(async () => [{ path: "NoteA" }]), getPlugins: vi.fn(async () => []),
  getRenderedHtml: vi.fn(async () => "<p>Seed</p>"), getTree: vi.fn(async () => []),
  getIndexStatus: vi.fn(async () => ({ syncing: false })), getNotes: vi.fn(async () => []),
  updateNote: vi.fn(), createNote: vi.fn(), deleteNote: vi.fn(), previewRename: vi.fn(async () => []),
  operationError: (await importOriginal()).operationError, apiErrorHandler: vi.fn(), uploadFile: vi.fn(), renderBuffer: vi.fn(async text => `<p>${text}</p>`),
  getPluginHostCatalog: vi.fn(async () => ({ plugins: [] })), getPluginSettings: vi.fn(),
  putPluginSettings: vi.fn(), putPluginPolicy: vi.fn(), putPluginEnabled: vi.fn(),
  getPluginPermissions: vi.fn(), putPluginPermissions: vi.fn(), getPluginPermissionRequests: vi.fn(async () => []), decidePluginPermissionRequest: vi.fn(),
  invokePluginCommand: vi.fn(), postSetup: vi.fn(), resetSetup: vi.fn(), postTotpEnrolment: vi.fn(), postBrand: vi.fn(),
  getAccessSettings: vi.fn(), putAccessSettings: vi.fn(), postAccessTotpEnrolment: vi.fn(),
}));
vi.mock("../themes.js", async () => {
  const { ref } = await import("vue");
  return { currentTheme: ref("system"), THEMES: [], initTheme: vi.fn(), setTheme: vi.fn(), currentThemeLabel: ref("System"), resolvedTheme: ref({}) };
});
vi.mock("../brand.js", () => ({ applyBrandToDocument: vi.fn(), currentBrandName: () => "globnotes", brandRevision: { value: 0 } }));

let wrapper;
let pending;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = "";
  window.history.replaceState(null, "", "/NoteA");
  window.onbeforeunload = null;
  pending = [];
  deferredWys.ready = false; deferredWys.content = "";
  vi.clearAllMocks();
  getConfig.mockResolvedValue({ authType: "none", setupRequired: false, brand: {} });
  previewRename.mockResolvedValue([]);
  deleteNote.mockResolvedValue({});
  for (const transport of [updateNote, createNote]) transport.mockImplementation((...args) => {
    const request = deferred(); pending.push({ ...request, args, transport }); return request.promise;
  });
  const pinia = createPinia(); setActivePinia(pinia);
  holder.router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "home", component: { template: "<p>Home</p>" } },
    { path: "/_/new", name: "new", component: NoteView },
    { path: "/_/login", name: "login", component: { template: "<p>Login</p>" } },
    { path: "/:path(.*)", name: "note", component: NoteView, props: true },
  ] });
  await holder.router.push("/NoteA"); await holder.router.isReady();
  wrapper = mount(App, { attachTo: document.body, global: {
    plugins: [pinia, holder.router], directives: { focus: { mounted: el => el.focus() } },
    stubs: { NavBar: true, SidebarPanel: true, SyncBanner: true, PrimeToast: true, QuickSwitcher: true, CommandPalette: true },
  } });
  await flushPromises();
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });
function button(label, scope = document) { return [...scope.querySelectorAll("button")].find(el => el.textContent.trim() === label && el.style.display !== "none"); }
async function enter() { button("Edit").click(); await flushPromises(); }
async function content(text) {
  const editor = wrapper.findComponent({ name: "MarkdownEditor" });
  editor.vm.setMarkdown(text); editor.vm.$emit("change"); await flushPromises();
}
async function clickSave() { button("Save").click(); await flushPromises(); }
async function acknowledge(index, path, text) { pending[index].resolve({ path, content: text }); await flushPromises(); }
const live = () => document.querySelector(".cm-content")?.textContent;

describe("foreground FIFO through the real Note", () => {
  it("query-only push and history preserve the exact A/B/C owner, editor and unsent D", async () => {
    await enter(); await content("A"); await clickSave();
    await content("B"); await clickSave(); await content("C"); await clickSave(); await content("D");
    const editor = document.querySelector(".cm-content");
    const noteOwner = wrapper.findComponent(NoteView).vm.$;
    const reads = getNote.mock.calls.length;
    await holder.router.push("/NoteA?folder=x&path=ignored#source"); await flushPromises();
    expect({ sameOwner: wrapper.findComponent(NoteView).vm.$ === noteOwner, sameEditor: document.querySelector(".cm-content") === editor, buffer: live(), reads: getNote.mock.calls.length, writes: pending.length, dirty: hasUnsavedWork() }).toEqual({ sameOwner: true, sameEditor: true, buffer: "D", reads, writes: 1, dirty: true });
    holder.router.back(); await flushPromises();
    holder.router.forward(); await flushPromises();
    expect(document.querySelector(".cm-content")).toBe(editor); expect(getNote).toHaveBeenCalledTimes(reads);
    await acknowledge(0, "NoteA", "A"); await acknowledge(1, "NoteA", "B"); await acknowledge(2, "NoteA", "C");
    expect(pending.map(request => request.args[2])).toEqual(["A", "B", "C"]); expect(live()).toBe("D");
    expect(hasUnsavedWork()).toBe(true); expect(window.onbeforeunload).toBeTypeOf("function");
  });

  it.each(["idle", "known", "unknown"])("query-only navigation preserves %s dirty ownership", async status => {
    await enter(); await content("D");
    if (status !== "idle") {
      await clickSave(); pending[0].reject(status === "known" ? { response: { data: { code: "plugin_cancelled" } } } : new Error("transport lost")); await flushPromises();
    }
    const editor = document.querySelector(".cm-content"), reads = getNote.mock.calls.length;
    await holder.router.push("/NoteA?folder=ignored#source"); await flushPromises();
    expect(document.querySelector(".cm-content")).toBe(editor); expect(live()).toBe("D"); expect(getNote).toHaveBeenCalledTimes(reads); expect(hasUnsavedWork()).toBe(true);
    if (status !== "idle") expect(document.body.textContent).toContain("paused");
  });

  it("fresh view Delete reaches ordinary confirmation, cancel preserves, confirmation deletes", async () => {
    expect(hasUnsavedWork()).toBe(false); expect(window.onbeforeunload).toBeNull();
    button("Delete").click(); await flushPromises();
    expect(document.body.textContent).toContain("Confirm Deletion"); expect(document.body.textContent).not.toContain("Save Changes");
    button("Cancel", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(deleteNote).not.toHaveBeenCalled(); expect(holder.router.currentRoute.value.params.path).toBe("NoteA");
    button("Delete").click(); await flushPromises(); button("Delete", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(deleteNote).toHaveBeenCalledExactlyOnceWith("NoteA"); expect(holder.router.currentRoute.value.name).toBe("home"); expect(updateNote).not.toHaveBeenCalled(); expect(createNote).not.toHaveBeenCalled();
  });

  it.each([
    ["plugin_cancelled", 409, "Blocked by plugin", "Native Delete protection (plugin: native-guard)"],
    ["plugin_guard_failed", 503, "Plugin guard failed", "Native Delete protection (plugin: native-guard)"],
    ["operation_conflict", 409, "Conflict", "Native Delete protection"],
    ["operation_partial", 500, "Partial failure", "Native Delete protection"],
  ])("rejected Delete %s reaches the structured toast consumer without replacing Note work", async (code, status, title, detail) => {
    await enter();
    const editor = document.querySelector(".cm-content"), owner = wrapper.findComponent(NoteView).vm.$;
    const buffer = live(), url = holder.router.currentRoute.value.fullPath;
    const error = { response: { status, data: { code, detail: "Native Delete protection", pluginId: "native-guard", action: "delete", operationId: "delete-consumer" } } };
    deleteNote.mockRejectedValueOnce(error);
    toastConsumer.add.mockClear();
    button("Delete").click(); await flushPromises();
    button("Delete", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(deleteNote).toHaveBeenCalledExactlyOnceWith("NoteA");
    expect(toastConsumer.add).toHaveBeenCalledWith(expect.objectContaining({ summary: title, detail, severity: "error" }));
    expect(apiErrorHandler).not.toHaveBeenCalled();
    expect(wrapper.findComponent(NoteView).vm.$).toBe(owner);
    expect(document.querySelector(".cm-content")).toBe(editor);
    expect(live()).toBe(buffer); expect(holder.router.currentRoute.value.fullPath).toBe(url);
    expect(updateNote).not.toHaveBeenCalled(); expect(createNote).not.toHaveBeenCalled();
  });

  it("unstructured Delete failure keeps work and reaches the existing fallback", async () => {
    await enter();
    const editor = document.querySelector(".cm-content"), buffer = live(), url = holder.router.currentRoute.value.fullPath;
    const error = new Error("Owned delete transport failure");
    deleteNote.mockRejectedValueOnce(error);
    button("Delete").click(); await flushPromises();
    button("Delete", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(apiErrorHandler).toHaveBeenCalledWith(error, toastConsumer);
    expect(document.querySelector(".cm-content")).toBe(editor);
    expect(live()).toBe(buffer); expect(holder.router.currentRoute.value.fullPath).toBe(url);
  });

  it("preview resolving after preparation timeout cannot open a prompt or replace its failure", async () => {
    vi.useFakeTimers();
    try {
      const preview = deferred(); previewRename.mockImplementation(() => preview.promise);
      await enter(); await content("A"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("folder"); await clickSave();
      await vi.advanceTimersByTimeAsync(60_000);
      const failure = document.querySelector('[data-note-save-status]').textContent;
      preview.resolve([{ url: "obsolete.png", kind: "image" }]); await flushPromises();
      expect(document.querySelector("#rename-assets-title")).toBeNull(); expect(pending).toHaveLength(0); expect(document.querySelector('[data-note-save-status]').textContent).toBe(failure);
    } finally { vi.useRealTimers(); }
  });

  it.each(["discard", "re-entry"])("late preview after %s cannot replace a newer prompt or its correct transport", async replacement => {
    vi.useFakeTimers();
    try {
      const oldPreview = deferred(), newPreview = deferred();
      previewRename.mockImplementationOnce(() => oldPreview.promise).mockImplementationOnce(() => newPreview.promise);
      await enter(); await content("old snapshot"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("old-folder"); await clickSave();
      await vi.advanceTimersByTimeAsync(60_000);
      button("Edit").click(); await flushPromises();
      button("Discard", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
      if (replacement === "re-entry") {
        await holder.router.push("/Other"); await flushPromises();
        await holder.router.push("/NoteA"); await flushPromises();
      }
      await enter(); await content("new snapshot"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("new-folder"); await clickSave();
      newPreview.resolve([{ url: "current.png", kind: "image" }]); await flushPromises();
      const prompt = wrapper.findComponent({ name: "RenameAssetsModal" });
      const callbacks = prompt.emitted("confirm");
      expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("current.png");
      oldPreview.resolve([{ url: "obsolete.png", kind: "image" }]); await flushPromises();
      expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("current.png");
      expect(document.querySelector('[data-modal-top="true"]').textContent).not.toContain("obsolete.png");
      expect(prompt.emitted("confirm")).toBe(callbacks);
      [...document.querySelectorAll('[data-modal-top="true"] button')].find(el => el.textContent.includes("Move files with the note")).click(); await flushPromises();
      expect(pending).toHaveLength(1); expect(pending[0].args).toEqual(["NoteA", "new-folder/NoteA", "new snapshot", "move"]);
    } finally { vi.useRealTimers(); }
  });

  it("an open preparation prompt closes immediately on observation timeout and stale callbacks send nothing", async () => {
    vi.useFakeTimers();
    try {
      previewRename.mockResolvedValue([{ url: "current.png", kind: "image" }]);
      await enter(); await content("A"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("folder"); await clickSave();
      const modal = wrapper.findComponent({ name: "RenameAssetsModal" });
      const identity = modal.props("promptIdentity") ?? modal.props("jobId");
      expect(document.querySelector("#rename-assets-title")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      const failure = document.querySelector('[data-note-save-status]').textContent;
      expect(document.querySelector("#rename-assets-title")).toBeNull();
      modal.vm.$emit("confirm", "move", identity); modal.vm.$emit("cancel", identity); await flushPromises();
      expect(pending).toHaveLength(0); expect(document.querySelector('[data-note-save-status]').textContent).toBe(failure);
    } finally { vi.useRealTimers(); }
  });

  it("callbacks from a revoked prompt cannot close or resolve a different session's prompt", async () => {
    vi.useFakeTimers();
    try {
      previewRename.mockResolvedValue([{ url: "old.png", kind: "image" }]);
      await enter(); await content("old snapshot"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("old-folder"); await clickSave();
      const modal = wrapper.findComponent({ name: "RenameAssetsModal" });
      const oldIdentity = modal.props("promptIdentity");
      await vi.advanceTimersByTimeAsync(60_000);
      button("Edit").click(); await flushPromises(); button("Discard", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
      previewRename.mockResolvedValue([{ url: "new.png", kind: "image" }]);
      await enter(); await content("new snapshot"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("new-folder"); await clickSave();
      const currentIdentity = modal.props("promptIdentity"); expect(currentIdentity).not.toBe(oldIdentity);
      modal.vm.$emit("confirm", "none", oldIdentity); modal.vm.$emit("cancel", oldIdentity); await flushPromises();
      expect(modal.props("promptIdentity")).toBe(currentIdentity); expect(document.querySelector('[data-modal-top="true"]').textContent).toContain("new.png"); expect(pending).toHaveLength(0);
      [...document.querySelectorAll('[data-modal-top="true"] button')].find(el => el.textContent.includes("Move files with the note")).click(); await flushPromises();
      expect(pending).toHaveLength(1); expect(pending[0].args).toEqual(["NoteA", "new-folder/NoteA", "new snapshot", "move"]);
    } finally { vi.useRealTimers(); }
  });

  it("new-note prefill resource changes require Cancel or explicit Discard", async () => {
    await holder.router.push("/_/new?path=First"); await flushPromises(); await content("draft");
    const editor = document.querySelector(".cm-content");
    await holder.router.push("/_/new?path=Second&folder=target"); await flushPromises();
    expect(holder.router.currentRoute.value.query.path).toBe("First"); expect(live()).toBe("draft");
    button("Cancel", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(document.querySelector(".cm-content")).toBe(editor);
    await holder.router.push("/_/new?path=Second&folder=target"); await flushPromises();
    button("Discard", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(holder.router.currentRoute.value.query.path).toBe("Second"); expect(wrapper.find('input[placeholder="Title"]').element.value).toBe("Second"); expect(live()).toBe("");
  });

  it("an obsolete authorized getNote completion cannot replace a later resource", async () => {
    const oldRead = deferred();
    getNote.mockImplementationOnce(() => oldRead.promise);
    await holder.router.push("/Slow"); await flushPromises();
    await holder.router.push("/Latest"); await flushPromises();
    oldRead.resolve({ path: "Slow", content: "obsolete" }); await flushPromises();
    expect(holder.router.currentRoute.value.params.path).toBe("Latest");
    expect(document.querySelector('span[title="Latest"]')).not.toBeNull(); expect(document.querySelector('span[title="Slow"]')).toBeNull();
  });

  it("Delete confirmation revalidates protected work admitted after it opened", async () => {
    await enter(); button("Delete").click(); await flushPromises();
    expect(document.body.textContent).toContain("Confirm Deletion");
    await content("newer work");
    button("Delete", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(deleteNote).not.toHaveBeenCalled(); expect(live()).toBe("newer work"); expect(hasUnsavedWork()).toBe(true);
  });

  it("holds B/C in click order while A is unresolved and preserves newer D", async () => {
    await enter(); await content("A"); await clickSave();
    await content("B"); await clickSave();
    await content("C"); await clickSave(); await content("D");
    expect(pending).toHaveLength(1);
    expect(pending[0].args).toEqual(["NoteA", "NoteA", "A", "none"]);
    await acknowledge(0, "NoteA", "A");
    expect(live()).toBe("D"); expect(pending).toHaveLength(2);
    expect(pending[1].args[2]).toBe("B");
    await acknowledge(1, "NoteA", "B");
    expect(pending).toHaveLength(3); expect(pending[2].args[2]).toBe("C");
    await acknowledge(2, "NoteA", "C"); expect(live()).toBe("D");
  });

  it("a late A acknowledgement never overwrites unsent D", async () => {
    await enter(); await content("A"); await clickSave(); await content("D");
    await acknowledge(0, "NoteA", "A");
    expect(live()).toBe("D");
  });

  it("equal-content Save clicks remain distinct foreground jobs", async () => {
    await enter(); await content("Seed\n"); await clickSave(); await clickSave();
    expect(pending).toHaveLength(1);
    await acknowledge(0, "NoteA", "Seed\n"); expect(pending).toHaveLength(2);
  });

  it("a failed A retains B and further Save clicks without dispatching", async () => {
    await enter(); await content("A"); await clickSave(); await content("B"); await clickSave();
    pending[0].reject({ response: { status: 409, data: { code: "plugin_cancelled", detail: "guard" } } });
    await flushPromises(); await content("D"); await clickSave();
    expect(pending).toHaveLength(1); expect(live()).toBe("D");
    expect(document.body.textContent).toContain("paused");
  });

  it("new-note B uses A's acknowledged identity without a second POST or buffer reset", async () => {
    await holder.router.push("/_/new"); await flushPromises();
    await content("A"); await clickSave(); await content("B"); await clickSave();
    const firstPath = pending[0].args[0];
    expect(createNote).toHaveBeenCalledTimes(1);
    await acknowledge(0, firstPath, "A");
    expect(createNote).toHaveBeenCalledTimes(1); expect(updateNote).toHaveBeenCalledTimes(1);
    expect(pending[1].args).toEqual([firstPath, firstPath, "B", "none"]);
    expect(live()).toBe("B");
  });

  it("Save stays clickable and the editor stays mounted while the activity glyph is shown", async () => {
    await enter(); await content("A"); const editor = document.querySelector(".cm-content");
    await clickSave();
    expect(button("Save").disabled).toBe(false);
    expect(button("Save").getAttribute("aria-busy")).toBe("true");
    expect(button("Save").querySelector(".animate-spin")).not.toBeNull();
    expect(document.querySelector(".cm-content")).toBe(editor);
  });

  it("rename lineage inherits A's canonical target but preserves a deliberate rename back", async () => {
    await enter(); await content("A");
    await wrapper.find('input[placeholder="Title"]').setValue("Q"); await clickSave();
    await content("B"); await clickSave();
    await wrapper.find('input[placeholder="Title"]').setValue("NoteA"); await content("C"); await clickSave();
    await acknowledge(0, "Q", "A");
    expect(pending[1].args).toEqual(["Q", "Q", "B", "none"]);
    expect(wrapper.find('input[placeholder="Title"]').element.value).toBe("NoteA");
    await acknowledge(1, "Q", "B");
    expect(pending[2].args).toEqual(["Q", "NoteA", "C", "none"]);
    expect(live()).toBe("C");
  });

  it("normalization stores actual A without rewriting B's bytes or newer D", async () => {
    await enter(); await content("A literal"); await clickSave();
    await content("B literal"); await clickSave(); await content("D literal");
    await acknowledge(0, "NoteA", "A normalized");
    expect(pending[1].args[2]).toBe("B literal"); expect(live()).toBe("D literal");
  });

  it("a rename preview rejection pauses before mutation rather than choosing none", async () => {
    await enter(); await content("A");
    await wrapper.find('input[placeholder="Folder (root)"]').setValue("folder");
    previewRename.mockRejectedValue(new Error("preview failed")); await clickSave();
    expect(pending).toHaveLength(0); expect(document.body.textContent).toContain("paused");
  });

  it("an attachment choice is job-owned and uses A's original content", async () => {
    const preview = deferred(); previewRename.mockImplementation(() => preview.promise);
    await enter(); await content("A"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("folder"); await clickSave();
    await content("B"); await clickSave();
    preview.resolve([{ url: "image.png", kind: "image" }]); await flushPromises();
    const choice = [...document.querySelectorAll('[data-modal-top="true"] button')].find(el => el.textContent.includes("Move files with the note"));
    choice.click(); await flushPromises();
    expect(pending).toHaveLength(1); expect(pending[0].args).toEqual(["NoteA", "folder/NoteA", "A", "move"]);
  });

  it("Escape cancels attachment preparation, retains B, and settles without a write", async () => {
    const preview = deferred(); previewRename.mockImplementation(() => preview.promise);
    await enter(); await content("A"); await wrapper.find('input[placeholder="Folder (root)"]').setValue("folder"); await clickSave();
    await content("B"); await clickSave(); preview.resolve([{ url: "image.png", kind: "image" }]); await flushPromises();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); await flushPromises();
    expect(pending).toHaveLength(0); expect(live()).toBe("B"); expect(document.body.textContent).toContain("paused");
  });

  it("acknowledgement failure after server success pauses B without replaying A", async () => {
    await enter(); await content("A"); await clickSave(); await content("B"); await clickSave();
    const replace = vi.spyOn(holder.router, "replace").mockRejectedValueOnce(new Error("route failure"));
    await acknowledge(0, "Q", "A");
    expect(pending).toHaveLength(1); expect(live()).toBe("B"); expect(document.body.textContent).toContain("paused");
    replace.mockRestore();
  });

  it("an older acknowledgement does not delete a newer owned draft", async () => {
    vi.useFakeTimers();
    try {
      await enter(); await content("A"); await clickSave(); await content("D");
      await vi.advanceTimersByTimeAsync(1000);
      const before = sessionStorage.getItem("NoteA"); expect(before).toBe("D");
      await acknowledge(0, "NoteA", "A");
      expect(sessionStorage.getItem("NoteA")).toBe("D"); expect(live()).toBe("D");
    } finally { vi.useRealTimers(); }
  });

  it("immediate Save during WYSIWYG factory creation uses the retained Source buffer", async () => {
    await enter(); await content("retained work"); button("WYSIWYG").click(); await flushPromises();
    await clickSave(); expect(pending[0].args[2]).toBe("retained work");
  });
  it("a ready genuinely empty WYSIWYG document remains an empty snapshot", async () => {
    await enter(); await content("older work"); button("WYSIWYG").click(); await flushPromises();
    deferredWys.ready = true; deferredWys.content = "";
    await clickSave(); expect(pending[0].args[2]).toBe("");
  });
  it("Preview Save captures retained text without a mounted editor", async () => {
    await enter(); await content("preview work"); button("Preview").click(); await flushPromises();
    expect(document.querySelector(".cm-content")).toBeNull(); await clickSave();
    expect(pending[0].args[2]).toBe("preview work");
  });
  it("an invalid filename click is rejected without changing A's admitted request", async () => {
    await enter(); await content("A"); await clickSave();
    await wrapper.find('input[placeholder="Title"]').setValue("bad?"); await content("D"); await clickSave();
    expect(pending).toHaveLength(1); await acknowledge(0, "NoteA", "A"); expect(pending).toHaveLength(1); expect(live()).toBe("D");
  });
  it("Note preserves movedFiles acknowledged metadata", () => {
    const movedFiles = [{ oldPath: "old.png", newPath: "folder/new.png" }];
    expect(new Note({ path: "P", content: "A", movedFiles }).movedFiles).toEqual(movedFiles);
  });

  it("real navigation is aborted while A is pending and resumes only after clean acknowledgement", async () => {
    await enter(); await content("A"); await clickSave();
    await holder.router.push("/Other"); await flushPromises();
    expect(holder.router.currentRoute.value.params.path).toBe("NoteA"); expect(live()).toBe("A");
    await acknowledge(0, "NoteA", "A");
    expect(holder.router.currentRoute.value.params.path).toBe("Other");
  });
  it("user navigation with unsent D keeps the URL and presents a fresh decision after A", async () => {
    await enter(); await content("A"); await clickSave(); await content("D");
    await holder.router.push("/Other"); await flushPromises(); await acknowledge(0, "NoteA", "A");
    expect(holder.router.currentRoute.value.params.path).toBe("NoteA"); expect(document.body.textContent).toContain("Save Changes"); expect(live()).toBe("D");
    button("Cancel", document.querySelector('[data-modal-top="true"]')).click(); await flushPromises();
    expect(holder.router.currentRoute.value.params.path).toBe("NoteA");
  });
  it("Save-close A cannot close over queued B and unsent D", async () => {
    await enter(); await content("A"); dispatchAction(TOPICS.EDITOR_SAVE_CLOSE); await flushPromises();
    await content("B"); await clickSave(); await content("D");
    await acknowledge(0, "NoteA", "A"); expect(live()).toBe("D"); await acknowledge(1, "NoteA", "B");
    expect(document.body.textContent).toContain("Save Changes"); expect(live()).toBe("D");
  });
  it("Delete waits for the owned Save rather than opening or mutating over it", async () => {
    await enter(); await content("A"); await clickSave(); button("Delete").click(); await flushPromises();
    expect(document.body.textContent).not.toContain("Confirm Deletion");
    await acknowledge(0, "NoteA", "A"); expect(document.body.textContent).toContain("Confirm Deletion");
  });
  it("an uncertain Save avoids the legacy toast instructing a blind retry", async () => {
    await enter(); await content("A"); await clickSave(); pending[0].reject(new Error("transport lost")); await flushPromises();
    expect(apiErrorHandler).not.toHaveBeenCalled();
    expect(document.querySelector('[data-note-save-status]').textContent).toContain("unknown");
  });
});
