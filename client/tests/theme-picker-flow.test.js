// Click-through test for the theme picker flow:
// menu button → "Theme: …" item → picker panel → pick Tokyo Night → CSS vars applied.
import { describe, it, expect } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import NavBar from "../partials/NavBar.vue";
import router from "../router";
import { THEMES } from "../themes.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("theme picker flow", () => {
  it("opens picker from menu and applies a theme", async () => {
    const overlayHost = document.createElement("div");
    overlayHost.id = "overlay-host";
    document.body.appendChild(overlayHost);
    const mountEl = document.createElement("div");
    document.body.appendChild(mountEl);
    const app = createApp(NavBar);
    app.use(createPinia());
    app.use(router);
    app.use(PrimeVue);
    app.mount(mountEl);
    await nextTick();

    const menuButton = document.querySelector('[title="Menu"]');
    expect(menuButton, "menu button").toBeTruthy();
    menuButton.click();
    await sleep(80);

    const themeItem = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent.includes("Theme:"),
    );
    expect(themeItem, "theme item").toBeTruthy();
    themeItem.click();
    await sleep(80);

    const pickerPanel = Array.from(document.querySelectorAll("div")).find(
      (d) =>
        d.textContent.includes("Light") &&
        d.textContent.includes("System (follows OS)"),
    );
    expect(pickerPanel, "picker panel open").toBeTruthy();

    const tokyo = Array.from(pickerPanel.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Tokyo Night"),
    );
    expect(tokyo, "tokyo button").toBeTruthy();
    tokyo.click();
    await sleep(30);

    expect(
      document.documentElement.style.getPropertyValue("--theme-brand").trim(),
    ).not.toBe("");

    // cleanup between runs within the same process
    app.unmount();
    mountEl.remove();
    overlayHost.remove();
    document.documentElement.removeAttribute("style");
  }, THEMES.length && 10000);
});
