// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

import Home from "../views/Home.vue";
import { useGlobalStore } from "../globalStore.js";

vi.mock("../api.js", () => ({
  getNotes: vi.fn().mockResolvedValue([]),
  apiErrorHandler: vi.fn(),
}));
vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", name: "home", component: { template: "<div/>" } },
    { path: "/_/new", name: "new", component: { template: "<div/>" } },
  ],
});

describe("Home empty vault", () => {
  it("shows the greeting WITH a rendered create CTA", async () => {
    setActivePinia(createPinia());
    const store = useGlobalStore();
    store.config = {
      authType: "none",
      notesPath: "/vault",
      quickAccessLimit: 4,
      quickAccessSort: "lastModified",
      quickAccessTerm: "*",
    };
    const wrapper = mount(Home, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("No notes yet");
    expect(wrapper.text()).toContain("/vault");
    // The CTA must be a real rendered button — an unresolved component
    // renders nothing (regression guard for missing imports).
    const btn = wrapper.find("button");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain("Create new note");
    expect(btn.classes()).toContain("bg-theme-brand");
  });

  it("hides the CTA in read-only vaults", async () => {
    setActivePinia(createPinia());
    const store = useGlobalStore();
    store.config = {
      authType: "read_only",
      notesPath: "/vault",
      quickAccessLimit: 4,
      quickAccessSort: "lastModified",
      quickAccessTerm: "*",
    };
    const wrapper = mount(Home, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("No notes yet");
    expect(wrapper.text()).not.toContain("Create new note");
  });
});
