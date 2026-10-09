// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";

import Logo from "../components/Logo.vue";
import { useGlobalStore } from "../globalStore.js";

// Rendered branding here; responsive geometry is checked in a real browser.
describe("Logo branding", () => {
  let app;
  afterEach(() => {
    app?.unmount();
    document.body.innerHTML = "";
  });

  function mountLogo() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useGlobalStore();
    store.config = {
      brand: { name: "my notes", accent: "#53c729", files: [] },
    };
    const el = document.createElement("div");
    document.body.appendChild(el);
    app = createApp(() => h(Logo, { responsive: true }));
    app.use(pinia).mount(el);
    return el;
  }

  it("renders the configured wordmark alongside its artwork", () => {
    const el = mountLogo();
    expect(el.textContent).toContain("my notes");
    expect(el.querySelector("svg")).not.toBeNull();
  });
});
