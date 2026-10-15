import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return await import("../sidebarPreferences.js");
}

describe("sidebar preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to closed, unpinned, no Recent or expansion without storing defaults", async () => {
    const store = await freshStore();
    expect(store.sidebarVisible.value).toBe(false);
    expect(store.sidebarPinned.value).toBe(false);
    expect(store.sidebarRecent.value).toBe(false);
    expect([...store.expandedFolders.value]).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it.each(["true", "false", "TRUE", "", "1"])(
    "keeps exact true-string semantics for stored sidebar flags: %s",
    async stored => {
      for (const key of ["sidebarVisible", "sidebarPinned", "sidebarRecent"]) {
        localStorage.setItem(key, stored);
      }
      const store = await freshStore();
      for (const key of ["sidebarVisible", "sidebarPinned", "sidebarRecent"]) {
        expect(store[key].value).toBe(stored === "true");
        expect(localStorage.getItem(key)).toBe(stored);
      }
    },
  );

  it("restores existing expanded folders with Set order and deduplication", async () => {
    const saved = JSON.stringify(["Alex/sub", "旅行", "Alex/sub", "Alex"]);
    localStorage.setItem("expandedFolders", saved);
    const store = await freshStore();
    expect([...store.expandedFolders.value]).toEqual(["Alex/sub", "旅行", "Alex"]);
    expect(localStorage.getItem("expandedFolders")).toBe(saved);
  });

  it("does not silently discard malformed saved expansion data", async () => {
    localStorage.setItem("expandedFolders", "{not json");
    await expect(freshStore()).rejects.toThrow(SyntaxError);
    expect(localStorage.getItem("expandedFolders")).toBe("{not json");
  });

  it("persists expansion in the same JSON array format and supports collapse all", async () => {
    const store = await freshStore();
    const paths = new Set(["Alex", "Alex/sub"]);
    store.setExpandedFolders(paths);
    paths.add("not-adopted");
    expect([...store.expandedFolders.value]).toEqual(["Alex", "Alex/sub"]);
    expect(localStorage.getItem("expandedFolders")).toBe('["Alex","Alex/sub"]');
    const restored = await freshStore();
    expect([...restored.expandedFolders.value]).toEqual(["Alex", "Alex/sub"]);
    restored.setExpandedFolders([]);
    expect(restored.expandedFolders.value.size).toBe(0);
    expect(localStorage.getItem("expandedFolders")).toBe("[]");
  });

  it("persists visibility before delivering close and preserves silent opening", async () => {
    const store = await freshStore();
    const { subscribe, TOPICS } = await import("../bus/index.js");
    const events = [];
    const open = subscribe(TOPICS.SIDEPANEL_OPEN, event => events.push(["open", event]));
    const close = subscribe(TOPICS.SIDEPANEL_CLOSE, event => events.push([
      "close", event, store.sidebarVisible.value, localStorage.getItem("sidebarVisible"),
    ]));
    store.setSidebarVisible(true);
    expect(store.sidebarVisible.value).toBe(true);
    expect(localStorage.getItem("sidebarVisible")).toBe("true");
    expect(events).toEqual([]);
    store.setSidebarVisible(false);
    store.setSidebarVisible(false);
    open(); close();
    expect(events).toEqual([["close", {}, false, "false"], ["close", {}, false, "false"]]);
  });

  it("persists Recent before publishing the existing section facts", async () => {
    const store = await freshStore();
    const { subscribe, TOPICS } = await import("../bus/index.js");
    const events = [];
    const observe = type => event => events.push([
      type, event, store.sidebarRecent.value, localStorage.getItem("sidebarRecent"),
    ]);
    const show = subscribe(TOPICS.SIDEPANEL_SECTION_SHOW, observe("show"));
    const hide = subscribe(TOPICS.SIDEPANEL_SECTION_HIDE, observe("hide"));
    store.setSidebarRecent(true);
    store.setSidebarRecent(false);
    show(); hide();
    expect(events).toEqual([
      ["show", { section: "recent" }, true, "true"],
      ["hide", { section: "recent" }, false, "false"],
    ]);
  });

  it("restores all four written preferences for a fresh consumer", async () => {
    const store = await freshStore();
    store.setExpandedFolders(["Alex/sub"]);
    store.setSidebarVisible(true);
    store.setSidebarPinned(true);
    store.setSidebarRecent(true);
    const restored = await freshStore();
    expect([...restored.expandedFolders.value]).toEqual(["Alex/sub"]);
    expect(restored.sidebarVisible.value).toBe(true);
    expect(restored.sidebarPinned.value).toBe(true);
    expect(restored.sidebarRecent.value).toBe(true);
    expect(localStorage.getItem("sidebarPinned")).toBe("true");
    restored.setSidebarPinned(false);
    expect(restored.sidebarPinned.value).toBe(false);
    expect(localStorage.getItem("sidebarPinned")).toBe("false");
    expect(localStorage.length).toBe(4);
  });
});
