// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { editorViewCtx, prosePluginsCtx } from "@milkdown/core";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../App.vue";
import NoteView from "../views/Note.vue";
import { getConfig, updateNote } from "../api.js";
import { hasUnsavedWork } from "../sessionActions.js";

import WysiwygEditorInner from "../components/WysiwygEditorInner.vue";

const milkdown = vi.hoisted(() => ({
  editor: null,
  ready: null,
  destroyed: null,
}));
const routeHolder = vi.hoisted(() => ({ router: null }));
vi.mock("../router.js", () => ({ default: {
  get currentRoute() { return routeHolder.router.currentRoute; },
  get options() { return routeHolder.router.options; },
  push(...args) { return routeHolder.router.push(...args); },
  replace(...args) { return routeHolder.router.replace(...args); },
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
  getConfig: vi.fn(), getNote: vi.fn(async path => ({ path, content: "Original" })),
  getNoteIndex: vi.fn(async () => [{ path: "NoteA" }]), getPlugins: vi.fn(async () => []),
  getRenderedHtml: vi.fn(async () => "<p>Original</p>"), getTree: vi.fn(async () => []),
  getIndexStatus: vi.fn(async () => ({ syncing: false })), getNotes: vi.fn(async () => []),
  updateNote: vi.fn(), createNote: vi.fn(), deleteNote: vi.fn(), previewRename: vi.fn(async () => []),
  operationError: vi.fn(() => null), apiErrorHandler: vi.fn(), uploadFile: vi.fn(), renderBuffer: vi.fn(),
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

// Keep the real editor, schema, plugins, replaceAll, and debounced listener.
// Only replace Vue's provider plumbing so the test owns the editor lifetime.
vi.mock("@milkdown/vue", async () => {
  const { onMounted, onBeforeUnmount } = await import("vue");
  return {
    MilkdownProvider: { render() { return this.$slots.default?.(); } },
    Milkdown: { render: () => null },
    useEditor: (factory) => {
      onMounted(() => {
        milkdown.editor = factory(document.createElement("div"));
        milkdown.ready = milkdown.editor.create();
      });
      onBeforeUnmount(() => {
        milkdown.destroyed = milkdown.editor?.destroy();
      });
      return { get: () => milkdown.editor };
    },
  };
});

describe("real App/Note/Milkdown immediate dirty consumer", () => {
  let app, view;
  const button = label => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === label && el.style.display !== "none");
  beforeEach(async () => {
    localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = "";
    window.history.replaceState(null, "", "/NoteA");
    milkdown.editor = milkdown.ready = milkdown.destroyed = null;
    getConfig.mockResolvedValue({ authType: "none", setupRequired: false, brand: {} });
    updateNote.mockImplementation(async (_, path, content) => ({ path, content }));
    const pinia = createPinia(); setActivePinia(pinia);
    routeHolder.router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", name: "home", component: { template: "<p>Home</p>" } },
      { path: "/:path(.*)", name: "note", component: NoteView, props: true },
    ] });
    await routeHolder.router.push("/NoteA"); await routeHolder.router.isReady();
    app = mount(App, { attachTo: document.body, global: { plugins: [pinia, routeHolder.router], directives: { focus: { mounted: el => el.focus() } }, stubs: { NavBar: true, SidebarPanel: true, SyncBanner: true, PrimeToast: true, QuickSwitcher: true, CommandPalette: true } } });
    await flushPromises(); button("Edit").click(); await flushPromises(); button("WYSIWYG").click(); await flushPromises(); await milkdown.ready; await flushPromises();
    view = milkdown.editor.action(ctx => ctx.get(editorViewCtx));
    button("Save").click(); await flushPromises();
    expect(hasUnsavedWork()).toBe(false); expect(window.onbeforeunload).toBeNull();
    vi.useFakeTimers();
  });
  afterEach(async () => { app?.unmount(); await milkdown.destroyed; vi.useRealTimers(); });
  it.each(["edit", "paste"])("first %s after clean ACK protects the committed buffer before debounce", kind => {
    const tr = view.state.tr.insertText(`${kind} `, 1);
    if (kind === "paste") tr.setMeta("paste", true).setMeta("uiEvent", "paste");
    view.dispatch(tr);
    expect(app.findComponent({ name: "WysiwygEditor" }).vm.getSnapshot()).toEqual({ ready: true, content: `${kind} Original\n` });
    expect({ unsaved: hasUnsavedWork(), unload: typeof window.onbeforeunload }).toEqual({ unsaved: true, unload: "function" });
    expect(sessionStorage.getItem("NoteA")).toBeNull();
  });
});
vi.mock("../pluginLoader.js", async () => {
  const { ref } = await import("vue");
  return { loadClientPlugins: () => Promise.resolve([]), clientPluginEpoch: ref(0) };
});
vi.mock("../keybindings/editor-keymap.js", async () => {
  const { Plugin } = await import("prosemirror-state");
  const actual = await vi.importActual("../keybindings/editor-keymap.js");
  return { ...actual, milkdownLayerKeymap: () => new Plugin({}) };
});

describe("WysiwygEditorInner dirty notifications", () => {
  let wrapper, view, onChange;

  beforeEach(async () => {
    milkdown.editor = milkdown.ready = milkdown.destroyed = null;
    onChange = vi.fn(() => ({ snapshot: wrapper.vm.getSnapshot(), markdown: wrapper.vm.getMarkdown() }));
    wrapper = mount(WysiwygEditorInner, {
      props: { initialValue: "Original", onChange },
    });
    await milkdown.ready;
    await flushPromises();
    view = milkdown.editor.action((ctx) => ctx.get(editorViewCtx));
    expect(view.state).toBeInstanceOf(EditorState);
    expect(milkdown.editor.action((ctx) => ctx.get(prosePluginsCtx))).toEqual(
      expect.arrayContaining([expect.any(Plugin)]),
    );
    vi.useFakeTimers();
  });

  afterEach(async () => {
    wrapper?.unmount();
    await milkdown.destroyed;
    vi.useRealTimers();
  });

  it("does not dirty the initial document", () => {
    expect(wrapper.vm.getMarkdown().trim()).toBe("Original");
    expect(wrapper.emitted("change")).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it.each(["edit", "paste"])(
    "emits synchronously for a document %s",
    (kind) => {
      const modelSchema = view.state.schema;
      const tr =
        kind === "edit"
          ? view.state.tr.insertText("edited ", 1)
          : view.state.tr
              .replaceSelectionWith(modelSchema.text("pasted "))
              .setMeta("paste", true)
              .setMeta("uiEvent", "paste");
      expect(tr.docChanged).toBe(true);
      view.dispatch(tr);
      expect(onChange.mock.results[0].value).toEqual({ snapshot: { ready: true, content: `${kind === "edit" ? "edited" : "pasted"} Original\n` }, markdown: `${kind === "edit" ? "edited" : "pasted"} Original\n` });
      expect(view.state.doc.textContent).toBe(
        `${kind === "edit" ? "edited" : "pasted"} Original`,
      );
      expect(wrapper.emitted("change")).toEqual([[]]);
      vi.advanceTimersByTime(250);
      expect(wrapper.emitted("change")).toEqual([[]]);
    },
  );

  it.each(["edit", "paste"])(
    "notifies before immediate unmount after a document %s",
    async (kind) => {
      const modelSchema = view.state.schema;
      const tr =
        kind === "edit"
          ? view.state.tr.insertText("edited ", 1)
          : view.state.tr
              .replaceSelectionWith(modelSchema.text("pasted "))
              .setMeta("paste", true)
              .setMeta("uiEvent", "paste");
      view.dispatch(tr);
      const changesBeforeUnmount = wrapper.emitted("change")?.length ?? 0;
      wrapper.unmount();
      await milkdown.destroyed;
      vi.advanceTimersByTime(250);
      expect(changesBeforeUnmount).toBe(1);
      // test-utils clears emitted() on unmount; the consumer still records
      // whether the synchronous notification arrived before teardown.
      expect(onChange).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("does not dirty a selection-only transaction", () => {
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 3),
    );
    expect(tr.docChanged).toBe(false);
    view.dispatch(tr);
    expect(view.state.selection.from).toBe(3);
    expect(wrapper.emitted("activeChange")).toBeTruthy();
    expect(wrapper.emitted("change")).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("does not dirty stored marks without a document change", () => {
    const mark = view.state.schema.marks.strong.create();
    const tr = view.state.tr.setStoredMarks([mark]);
    expect(tr.storedMarksSet).toBe(true);
    expect(tr.docChanged).toBe(false);
    view.dispatch(tr);
    expect(view.state.storedMarks).toEqual([mark]);
    expect(wrapper.emitted("change")).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("does not dirty an addToHistory:false document update", () => {
    const tr = view.state.tr
      .insertText("synced ", 1)
      .setMeta("addToHistory", false);
    expect(tr.docChanged).toBe(true);
    view.dispatch(tr);
    expect(view.state.doc.textContent).toBe("synced Original");
    expect(wrapper.emitted("change")).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("does not dirty a docChanged transaction whose final document is identical", () => {
    const before = view.state.doc;
    const tr = view.state.tr.insertText("temporary", 1).delete(1, 10);
    expect(tr.docChanged).toBe(true);
    expect(tr.doc.eq(before)).toBe(true);
    view.dispatch(tr);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(wrapper.emitted("change")).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("does not dirty a programmatic setMarkdown replacement, including after debounce", () => {
    const before = view.state.doc;
    wrapper.vm.setMarkdown("Transferred document");
    expect(view.state.doc.eq(before)).toBe(false);
    expect(wrapper.vm.getMarkdown().trim()).toBe("Transferred document");
    expect(wrapper.emitted("change")).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("notifies synchronously for the first user edit after setMarkdown", () => {
    wrapper.vm.setMarkdown("Transferred document");
    expect(wrapper.emitted("change")).toBeUndefined();
    view.dispatch(view.state.tr.insertText("edited ", 1));
    expect(wrapper.vm.getMarkdown().trim()).toBe("edited Transferred document");
    expect(wrapper.emitted("change")).toEqual([[]]);
    expect(onChange.mock.results[0].value.snapshot.content).toBe("edited Transferred document\n");
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toEqual([[]]);
  });

  it("speculative state application never notifies a committed-view consumer", () => {
    const before = view.state;
    const speculative = before.apply(before.tr.insertText("speculative ", 1));
    expect(speculative.doc.textContent).toBe("speculative Original"); expect(view.state).toBe(before); expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["selection", "no-history", "return-original"])("appended %s transactions retain qualifying changes only for a different final document", kind => {
    const append = new Plugin({ appendTransaction: (transactions, oldState, newState) => {
      if (!transactions.some(tr => tr.getMeta("owner-test"))) return null;
      if (kind === "selection") return newState.tr.setSelection(TextSelection.create(newState.doc, 2));
      if (kind === "no-history") return newState.tr.insertText("appended ", 1).setMeta("addToHistory", false);
      return newState.tr.replaceWith(0, newState.doc.content.size, oldState.doc.content).setMeta("addToHistory", false);
    } });
    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, append] }));
    view.dispatch(view.state.tr.insertText("edited ", 1).setMeta("owner-test", true));
    if (kind === "return-original") {
      expect(view.state.doc.textContent).toBe("Original"); expect(onChange).not.toHaveBeenCalled();
    } else {
      const expected = kind === "selection" ? "edited Original" : "appended edited Original";
      expect(onChange).toHaveBeenCalledTimes(1); expect(onChange.mock.results[0].value.snapshot.content).toBe(expected + "\n");
    }
  });
});
