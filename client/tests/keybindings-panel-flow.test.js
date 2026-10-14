// Actual inline Settings rail/remapping, preserving every preference assertion.
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsModal from "../components/SettingsModal.vue";
import { TOPICS } from "../bus/topics.js";
import { effectiveBindings, setLayer } from "../keybindings/store.js";
vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));
let wrapper;
afterEach(()=>{wrapper?.unmount();wrapper=null;localStorage.clear();});

describe("keybindings panel flow", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());setLayer('legacy');localStorage.removeItem('globnotes-keybindings');
  });

  it("opens the panel, switches to Custom via the rail, remaps a binding", async () => {
    wrapper=mount(SettingsModal,{attachTo:document.body,props:{modelValue:true,writable:true}});
    await wrapper.vm.openSettings('core:keybindings');await flushPromises();
    const panel=document.querySelector('[data-keybindings-settings]');
    expect(panel, "keybindings panel").toBeTruthy();
    expect(localStorage.getItem("globnotes-keybindings")).toBe(null);

    // The rail lists all six layers as rows, in order.
    const railLabels = [
      "Legacy Flatnotes",
      "Obsidian",
      "Notion",
      "Typora",
      "VS Code-lite",
      "Custom",
    ];
    const railRows = Array.from(panel.querySelectorAll("button")).filter(
      (b) => railLabels.includes(b.textContent.trim()),
    );
    expect(
      railRows.map((b) => b.textContent.trim()),
      "rail rows",
    ).toEqual(railLabels);

    // Clicking a rail row switches the active layer.
    const notionRow = railRows.find((b) => b.textContent.trim() === "Notion");
    expect(notionRow, "notion rail row").toBeTruthy();
    notionRow.click();
    await flushPromises();
    expect(localStorage.getItem("globnotes-keybindings")).toBe("notion");

    // Switch to the Custom layer (last rail row).
    const customRow = railRows.find((b) => b.textContent.trim() === "Custom");
    expect(customRow, "custom rail row").toBeTruthy();
    customRow.click();
    await flushPromises();
    expect(localStorage.getItem("globnotes-keybindings")).toBe("custom");

    // Remap "Save note": click its binding button, press Ctrl+Shift+S.
    const saveButton = Array.from(panel.querySelectorAll("button")).find(
      (b) => (b.textContent || "").includes("Ctrl+Enter"),
    );
    expect(saveButton, "save binding button").toBeTruthy();
    saveButton.click();
    await flushPromises();
    expect(saveButton.textContent).toContain("Press a key");
    saveButton.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushPromises();

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

  }, 15000);
});
