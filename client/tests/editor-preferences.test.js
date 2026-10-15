import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return await import("../editorPreferences.js");
}

describe("editor preferences", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    [null, "markdown"],
    ["", "markdown"],
    ["markdown", "markdown"],
    ["wysiwyg", "wysiwyg"],
    ["preview", "preview"],
    ["legacy-mode", "legacy-mode"],
  ])("restores the existing stored value %s without rewriting it", async (stored, expected) => {
    if (stored !== null) localStorage.setItem("defaultEditorMode", stored);
    const store = await freshStore();
    expect(store.defaultEditorMode.value).toBe(expected);
    expect(localStorage.getItem("defaultEditorMode")).toBe(stored);
  });

  it.each(["markdown", "wysiwyg"])("persists %s for a fresh consumer", async mode => {
    const store = await freshStore();
    store.setDefaultEditorMode(mode);
    expect(store.defaultEditorMode.value).toBe(mode);
    expect(localStorage.getItem("defaultEditorMode")).toBe(mode);
    const restored = await freshStore();
    expect(restored.defaultEditorMode.value).toBe(mode);
    expect(localStorage.length).toBe(1);
  });

  it("does not store preview or erase the previously chosen editor", async () => {
    const store = await freshStore();
    store.setDefaultEditorMode("wysiwyg");
    store.setDefaultEditorMode("preview");
    expect(store.defaultEditorMode.value).toBe("wysiwyg");
    expect(localStorage.getItem("defaultEditorMode")).toBe("wysiwyg");
  });

  it("preview with no saved preference leaves storage untouched", async () => {
    const store = await freshStore();
    store.setDefaultEditorMode("preview");
    expect(store.defaultEditorMode.value).toBe("markdown");
    expect(localStorage.getItem("defaultEditorMode")).toBeNull();
  });

  it("does not announce an active editor transition when saving a preference", async () => {
    const store = await freshStore();
    const { subscribe, TOPICS } = await import("../bus/index.js");
    const events = [];
    const unsubscribe = subscribe(TOPICS.EDITOR_MODE_CHANGE, event => events.push(event));
    store.setDefaultEditorMode("wysiwyg");
    unsubscribe();
    expect(events).toEqual([]);
  });
});
