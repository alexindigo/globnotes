// Real Settings entry → inline Appearance → actual CSS preference consumer.
import { afterEach, describe, it, expect, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsModal from "../components/SettingsModal.vue";
import { THEMES } from "../themes.js";
vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));
let wrapper;
afterEach(()=>{wrapper?.unmount();wrapper=null;document.documentElement.removeAttribute('style');});

describe("theme picker flow", () => {
  it("opens picker from menu and applies a theme", async () => {
    setActivePinia(createPinia()); window.matchMedia=vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){}}));
    wrapper=mount(SettingsModal,{attachTo:document.body,props:{modelValue:true,writable:true}});
    await wrapper.vm.openSettings('core:appearance');await flushPromises();
    const pickerPanel=document.querySelector('[data-appearance-settings]');
    expect(pickerPanel, "picker panel open").toBeTruthy();

    const tokyo = Array.from(pickerPanel.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Tokyo Night"),
    );
    expect(tokyo, "tokyo button").toBeTruthy();
    tokyo.click();
    await flushPromises();
    expect(localStorage.getItem('globnotes-theme')).toBe(THEMES.find(theme=>theme.label.includes('Tokyo Night')).id);

    expect(
      document.documentElement.style.getPropertyValue("--theme-brand").trim(),
    ).not.toBe("");

  }, THEMES.length && 10000);
});
