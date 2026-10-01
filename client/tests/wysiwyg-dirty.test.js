// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { editorViewCtx, prosePluginsCtx } from "@milkdown/core";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";

import WysiwygEditorInner from "../components/WysiwygEditorInner.vue";

const milkdown = vi.hoisted(() => ({
  editor: null,
  ready: null,
  destroyed: null,
}));

// Keep the real editor, schema, plugins, replaceAll, and debounced listener.
// Only replace Vue's provider plumbing so the test owns the editor lifetime.
vi.mock("@milkdown/vue", async () => {
  const { onMounted, onBeforeUnmount } = await import("vue");
  return {
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
vi.mock("../pluginLoader.js", () => ({
  loadClientPlugins: () => Promise.resolve([]),
}));
vi.mock("../keybindings/editor-keymap.js", async () => {
  const { Plugin } = await import("prosemirror-state");
  return { milkdownLayerKeymap: () => new Plugin({}) };
});

describe("WysiwygEditorInner dirty notifications", () => {
  let wrapper, view, onChange;

  beforeEach(async () => {
    milkdown.editor = milkdown.ready = milkdown.destroyed = null;
    onChange = vi.fn();
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
    vi.advanceTimersByTime(250);
    expect(wrapper.emitted("change")).toEqual([[]]);
  });
});
