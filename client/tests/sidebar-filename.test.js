// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The tree entry carries a resolved display title — the sidebar must
// ignore it and show the filename (Obsidian's file explorer rule).
vi.mock("../api.js", () => ({
  getTree: vi.fn().mockResolvedValue({
    folders: [],
    notes: [{ path: "untitled-thing", title: "A Fancy H1 Title" }],
  }),
  getNoteIndex: vi.fn().mockResolvedValue([]),
  getNotes: vi.fn().mockResolvedValue([]),
}));

import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import SidebarPanel from "../components/SidebarPanel.vue";
import { setSidebarVisible } from "../sidebarPreferences.js";
import router from "../router";

describe("sidebar shows filenames", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("a title-bearing tree entry renders as its filename", async () => {
    const el = document.createElement("div");
    const app = createApp(SidebarPanel);
    app.use(createPinia());
    app.use(router);
    app.mount(el);
    setSidebarVisible(true);
    await nextTick();
    await new Promise((r) => setTimeout(r, 30));

    expect(el.textContent).toContain("untitled-thing");
    expect(el.textContent).not.toContain("A Fancy H1 Title");
    app.unmount();
  });
});
