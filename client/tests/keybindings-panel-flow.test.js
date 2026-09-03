// Click-through test for the keybindings panel flow:
// menu button → "Keybindings:" item → cheat-sheet panel → Custom layer →
// remap a binding → override persisted under globnotes-keybindings-custom.
import { describe, it, expect, beforeEach } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";
import NavBar from "../partials/NavBar.vue";
import router from "../router";
import { TOPICS } from "../bus/topics.js";
import { effectiveBindings } from "../keybindings/store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("keybindings panel flow", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens the panel, switches to Custom, remaps a binding", async () => {
    const overlayHost = document.createElement("div");
    overlayHost.id = "overlay-host";
    document.body.appendChild(overlayHost);
    const mountEl = document.createElement("div");
    document.body.appendChild(mountEl);
    const app = createApp(NavBar);
    app.use(createPinia());
    app.use(router);
    app.use(PrimeVue);
    app.use(ToastService);
    app.mount(mountEl);
    await nextTick();

    // Menu → Keybindings item → panel opens with the layer picker.
    document.querySelector('[title="Menu"]').click();
    await sleep(80);
    const keybindingItem = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent.includes("Keybindings:"),
    );
    expect(keybindingItem, "keybindings menu item").toBeTruthy();
    keybindingItem.click();
    await sleep(80);

    const panel = Array.from(document.querySelectorAll("div")).find((d) =>
      d.textContent.includes("Layer") &&
      d.textContent.includes("Save note"),
    );
    expect(panel, "keybindings panel").toBeTruthy();
    expect(localStorage.getItem("globnotes-keybindings")).toBe(null);

    // Switch to the Custom layer.
    const customChip = Array.from(panel.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === "Custom",
    );
    expect(customChip, "custom chip").toBeTruthy();
    customChip.click();
    await sleep(80);
    expect(localStorage.getItem("globnotes-keybindings")).toBe("custom");

    // Remap "Save note": click its binding button, press Ctrl+Shift+S.
    const saveButton = Array.from(panel.querySelectorAll("button")).find(
      (b) => (b.textContent || "").includes("Ctrl+Enter"),
    );
    expect(saveButton, "save binding button").toBeTruthy();
    saveButton.click();
    await sleep(30);
    expect(saveButton.textContent).toContain("Press a key");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(30);

    // The override persisted and the effective bindings use it.
    const stored = JSON.parse(
      localStorage.getItem("globnotes-keybindings-custom"),
    );
    expect(stored[TOPICS.EDITOR_SAVE]).toEqual({
      mac: "Ctrl+Shift+S",
      other: "Ctrl+Shift+S",
    });
    expect(effectiveBindings()[TOPICS.EDITOR_SAVE]).toEqual({
      mac: "Ctrl+Shift+S",
      other: "Ctrl+Shift+S",
    });

    // Untouched rows keep the base binding.
    expect(effectiveBindings()[TOPICS.EDITOR_TOGGLE_EDIT]).toEqual({
      mac: "E",
      other: "E",
    });

    app.unmount();
    mountEl.remove();
    overlayHost.remove();
    localStorage.clear();
  }, 15000);
});
