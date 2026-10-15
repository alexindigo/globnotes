// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  getTree: vi
    .fn()
    .mockResolvedValue({ folders: [], notes: [] }),
  getNoteIndex: vi.fn().mockResolvedValue([]),
  getNotes: vi.fn().mockResolvedValue([{ path: "Alex/Recent", lastModified: 1 }]),
}));

import { createApp, nextTick } from "vue";
import { flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { getTree, getNotes } from "../api.js";

describe("sidebar expansion hydration", () => {
  beforeEach(() => {
    vi.resetModules();
    getTree.mockClear();
    getNotes.mockClear();
    localStorage.clear();
  });

  it("loads levels for all persisted expanded folders on mount", async () => {
    localStorage.setItem(
      "expandedFolders",
      JSON.stringify(["Alex", "Alex/sub"]),
    );
    const { default: SidebarPanel } = await import("../components/SidebarPanel.vue");
    const { setSidebarVisible } = await import("../sidebarPreferences.js");
    const pinia = createPinia();
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/:path(.*)", name: "note", component: { template: "<p>Opened note</p>" } },
      { path: "/_/search", name: "search", component: { template: "<p>Folder search</p>" } },
    ] });
    await router.push("/"); await router.isReady();
    const levels = {
      "": { folders: [{ name: "Alex", path: "Alex" }], notes: [] },
      Alex: { folders: [{ name: "sub", path: "Alex/sub" }], notes: ["Alex/Parent"] },
      "Alex/sub": { folders: [], notes: ["Alex/sub/Restored"] },
    };
    getTree.mockImplementation(async path => levels[path]);
    const app = createApp(SidebarPanel);
    app.use(pinia);
    app.use(router);
    const element = document.createElement("div"); document.body.append(element);
    app.mount(element);
    setSidebarVisible(true);
    await nextTick();
    await flushPromises();

    const restored = element.querySelector('a[href="/Alex/sub/Restored"]');
    expect(restored?.textContent).toContain("Restored");
    expect(element.querySelector('a[href="/Alex/Parent"]')?.textContent).toContain("Parent");
    restored.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await flushPromises();
    expect(router.currentRoute.value.params.path).toBe("Alex/sub/Restored");
    app.unmount();
    element.remove();
  });

  it("wires filter, folder, section and preference intents to rendered controller state", async () => {
    const { default: SidebarPanel } = await import("../components/SidebarPanel.vue");
    const { useGlobalStore } = await import("../globalStore.js");
    const pinia = createPinia();
    useGlobalStore(pinia).notePaths = ["Alex/Match", "Alex/Other", "Root"];
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/:path(.*)", name: "note", component: { template: "<p>Note</p>" } },
      { path: "/_/search", name: "search", component: { template: "<p>Search</p>" } },
    ] });
    await router.push("/Root"); await router.isReady();
    getTree.mockImplementation(async path => path
      ? { folders: [], notes: ["Alex/Match", "Alex/Other"] }
      : { folders: [{ path: "Alex", name: "Alex" }], notes: ["Root"] });
    const app = createApp(SidebarPanel);
    app.use(pinia); app.use(router);
    // This test observes input wiring; focusing is owned by the app directive.
    app.directive("focus", {});
    const element = document.createElement("div"); document.body.append(element);
    app.mount(element);
    const click = async title => {
      element.querySelector(`[title="${title}"]`).click();
      await nextTick(); await flushPromises();
    };
    await click("Open sidebar");
    expect(element.querySelector('a[href="/Root"]').className).toContain("bg-theme-background-elevated");
    const folderButton = () => [...element.querySelectorAll("button")].find(button => button.textContent.includes("Alex"));
    folderButton().click(); await flushPromises();
    expect(element.querySelector('a[href="/Alex/Other"]')).not.toBe(null);
    await click("Collapse all");
    expect(element.querySelector('a[href="/Alex/Other"]')).toBe(null);
    await click("Filter");
    const input = element.querySelector('input[placeholder="Filter..."]');
    input.value = "match"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(element.querySelector('a[href="/Alex/Match"]')?.textContent).toContain("Match");
    expect(element.querySelector('a[href="/Alex/Other"]')).toBe(null);
    folderButton().click(); await nextTick();
    expect(element.querySelector('a[href="/Alex/Match"]')).toBe(null);
    await click("Reset filter");
    expect(input.value).toBe("");
    await click("Filter");
    expect(element.querySelector('input[placeholder="Filter..."]')).toBe(null);
    await click("Recent notes");
    expect(element.querySelector('a[href="/Alex/Recent"]')?.textContent).toContain("Recent");
    expect(localStorage.getItem("sidebarRecent")).toBe("true");
    await click("Pin sidebar");
    expect(element.querySelector("aside").className).toContain("border-r");
    expect(localStorage.getItem("sidebarPinned")).toBe("true");
    await router.push("/Alex/Match"); await flushPromises();
    expect(element.querySelector('a[href="/Alex/Match"]').className).toContain("bg-theme-background-elevated");
    await click("Close sidebar");
    expect(element.querySelector('[title="Open sidebar"]')).not.toBe(null);
    expect(localStorage.getItem("sidebarVisible")).toBe("false");
    app.unmount(); element.remove();
  });
});
