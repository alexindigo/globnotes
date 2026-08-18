// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  getTree: vi
    .fn()
    .mockResolvedValue({ folders: [], notes: [] }),
  getNoteIndex: vi.fn().mockResolvedValue([]),
}));

import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import { getTree } from "../api.js";
import SidebarPanel from "../components/SidebarPanel.vue";
import { useGlobalStore } from "../globalStore.js";
import router from "../router";

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
    const app = createApp(SidebarPanel);
    app.use(pinia);
    app.use(router);
    const store = useGlobalStore();
    app.mount(document.createElement("div"));
    store.sidebarVisible = true;
    await nextTick();
    await new Promise((r) => setTimeout(r, 20));

    expect(getTree).toHaveBeenCalledWith("Alex");
    expect(getTree).toHaveBeenCalledWith("Alex/sub");
    app.unmount();
  });
});
