// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  getTree: vi
    .fn()
    .mockResolvedValue({ folders: [], notes: [] }),
  getNoteIndex: vi.fn().mockResolvedValue([]),
}));

import { createApp, nextTick } from "vue";
import { flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { getTree } from "../api.js";
import SidebarPanel from "../components/SidebarPanel.vue";
import { useGlobalStore } from "../globalStore.js";

describe("sidebar expansion hydration", () => {
  beforeEach(() => {
    getTree.mockClear();
    localStorage.clear();
  });

  it("loads levels for all persisted expanded folders on mount", async () => {
    localStorage.setItem(
      "expandedFolders",
      JSON.stringify(["Alex", "Alex/sub"]),
    );
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
    const store = useGlobalStore();
    const element = document.createElement("div"); document.body.append(element);
    app.mount(element);
    store.sidebarVisible = true;
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
});
