// Layer store: localStorage persistence, Custom-layer overrides.
// Uses dynamic imports with module reset so each test sees fresh state.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TOPICS } from "../bus/topics.js";
import { LAYERS, LEGACY_LAYER_ID } from "../keybindings/layers.js";

async function freshStore() {
  vi.resetModules();
  return await import("../keybindings/store.js");
}

describe("keybinding store", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.removeItem("globnotes-keybindings");
    localStorage.removeItem("globnotes-keybindings-custom");
  });

  it("defaults to the legacy layer", async () => {
    const store = await freshStore();
    expect(store.currentLayerId.value).toBe(LEGACY_LAYER_ID);
    expect(store.effectiveBindings()).toEqual(LAYERS.legacy.bindings);
  });

  it("restores the persisted layer id", async () => {
    localStorage.setItem("globnotes-keybindings", "obsidian");
    const store = await freshStore();
    expect(store.currentLayerId.value).toBe("obsidian");
  });

  it("falls back to legacy for an unknown persisted id", async () => {
    localStorage.setItem("globnotes-keybindings", "vim");
    const store = await freshStore();
    expect(store.currentLayerId.value).toBe(LEGACY_LAYER_ID);
  });

  it("setLayer persists and publishes a change event", async () => {
    const store = await freshStore();
    const events = [];
    const { subscribe } = await import("../bus/index.js");
    const unsub = subscribe(TOPICS.KEYBINDINGS_CHANGE, (e) => events.push(e));
    store.setLayer("typora");
    unsub();
    expect(store.currentLayerId.value).toBe("typora");
    expect(localStorage.getItem("globnotes-keybindings")).toBe("typora");
    expect(events).toEqual([{ id: "typora" }]);
  });

  it("the custom layer merges overrides over the legacy base", async () => {
    const store = await freshStore();
    store.setLayer("custom");
    expect(store.effectiveBindings()).toEqual(LAYERS.legacy.bindings);
    const binding = { mac: "Cmd+Shift+1", other: "Ctrl+Shift+1" };
    store.setCustomBinding(TOPICS.EDITOR_SAVE, binding);
    expect(store.effectiveBindings()[TOPICS.EDITOR_SAVE]).toEqual(binding);
    // Untouched actions keep the base binding.
    expect(store.effectiveBindings()[TOPICS.APP_NEW_NOTE]).toEqual(
      LAYERS.legacy.bindings[TOPICS.APP_NEW_NOTE],
    );
  });

  it("custom overrides persist under globnotes-keybindings-custom", async () => {
    const store = await freshStore();
    store.setLayer("custom");
    store.setCustomBinding(TOPICS.EDITOR_SAVE, {
      mac: "Cmd+Shift+1",
      other: "Ctrl+Shift+1",
    });
    const stored = JSON.parse(
      localStorage.getItem("globnotes-keybindings-custom"),
    );
    expect(stored[TOPICS.EDITOR_SAVE]).toEqual({
      mac: "Cmd+Shift+1",
      other: "Ctrl+Shift+1",
    });

    // A fresh store instance restores the override.
    const again = await freshStore();
    expect(again.effectiveBindings()[TOPICS.EDITOR_SAVE]).toEqual({
      mac: "Cmd+Shift+1",
      other: "Ctrl+Shift+1",
    });
  });

  it("removeCustomBinding falls back to the base binding", async () => {
    const store = await freshStore();
    store.setLayer("custom");
    store.setCustomBinding(TOPICS.EDITOR_SAVE, { mac: "X", other: "X" });
    store.removeCustomBinding(TOPICS.EDITOR_SAVE);
    expect(store.effectiveBindings()[TOPICS.EDITOR_SAVE]).toEqual(
      LAYERS.legacy.bindings[TOPICS.EDITOR_SAVE],
    );
  });

  it("custom edits are ignored while a named layer is active", async () => {
    const store = await freshStore();
    store.setLayer("legacy");
    store.setCustomBinding(TOPICS.EDITOR_SAVE, { mac: "X", other: "X" });
    expect(localStorage.getItem("globnotes-keybindings-custom")).toBe(null);
  });

  it("corrupt custom overrides fall back to an empty map", async () => {
    localStorage.setItem("globnotes-keybindings", "custom");
    localStorage.setItem("globnotes-keybindings-custom", "{not json");
    const store = await freshStore();
    expect(store.customOverridesMap()).toEqual({});
    expect(store.effectiveBindings()).toEqual(LAYERS.legacy.bindings);
  });
});
