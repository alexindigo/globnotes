// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../api.js", async importOriginal => ({
  ...await importOriginal(),
  postBrand: vi.fn(() =>
    Promise.resolve({ name: null, accent: null, files: [] }),
  ),
}));

import SettingsModal from "../components/SettingsModal.vue";
import { postBrand } from "../api.js";
import { useGlobalStore } from "../globalStore.js";
vi.mock("primevue/usetoast", () => ({ useToast: () => ({ add: vi.fn() }) }));
let wrapper;

// Pin: the branding Reset button (danger) wipes name + accent + uploaded
// files. It must ASK first via ConfirmModal — no POST until confirm, and
// cancel leaves the Branding dialog intact. The wipe-without-warning
// behavior is pinned so it can't regress.

const SAMPLE = {
  name: "my notes",
  accent: "#53c729",
  files: ["logo.svg", "icon.svg"],
};

describe("BrandingSettings reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const pinia = createPinia();
    setActivePinia(pinia);
    window.matchMedia=vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  });
  afterEach(() => {
    wrapper?.unmount();wrapper=null;
    document.body.innerHTML = "";
  });

  async function openBranding() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useGlobalStore();
    store.config = { authType:'none', brand: { ...SAMPLE } };
    wrapper=mount(SettingsModal,{attachTo:document.body,props:{modelValue:true,writable:true},global:{directives:{focus:{mounted:el=>el.focus()}}}});
    await wrapper.vm.openSettings('core:branding');await flushPromises();
    return { app: {unmount:()=>{wrapper.unmount();wrapper=null;}}, store };
  }

  function findButton(label) {
    return [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === label,
    );
  }

  it("opens the confirmation on Reset and does NOT post yet", async () => {
    const { app } = await openBranding();
    const reset = findButton("Reset");
    expect(reset, "Reset button").toBeTruthy();
    reset.click();
    await nextTick();
    // The confirm dialog names exactly what will be lost.
    const modal = [...document.querySelectorAll("div")].find((d) =>
      d.textContent?.includes("Reset branding?"),
    );
    expect(modal).toBeTruthy();
    const modalText = modal.textContent;
    expect(modalText).toContain('name "my notes"');
    expect(modalText).toContain("accent #53c729");
    expect(modalText).toContain("logo.svg, icon.svg");
    // NO POST fired.
    expect(postBrand).not.toHaveBeenCalled();
    app.unmount();
  });

  it("confirm runs the reset POST with the clear payload", async () => {
    const { app } = await openBranding();
    findButton("Reset").click();
    await nextTick();
    // The nested ConfirmModal's confirm button — find the dialog that
    // carries the "Reset branding?" title, then its Reset button.
    // The nested ConfirmModal's confirm button — it renders after the
    // Branding dialog's own buttons, so it's the LAST Reset on screen.
    const confirm = [...document.querySelectorAll("button")]
      .filter((b) => b.textContent.trim() === "Reset")
      .at(-1);
    expect(confirm, "confirm dialog Reset").toBeTruthy();
    confirm.click();
    await flushPromises();
    expect(postBrand).toHaveBeenCalledTimes(1);
    const form = postBrand.mock.calls[0][0];
    expect(form.get("name")).toBe("");
    expect(form.get("accent")).toBe("");
    expect(form.get("removeLogo")).toBe("true");
    expect(form.get("removeIcon")).toBe("true");
    app.unmount();
  });

  it("cancel posts nothing and leaves the Branding dialog intact", async () => {
    const { app } = await openBranding();
    findButton("Reset").click();
    await nextTick();
    // Cancel lives in the nested ConfirmModal.
    const cancel = [...document.querySelectorAll("button")]
      .filter((b) => b.textContent.trim() === "Cancel")
      .at(-1);
    expect(cancel, "confirm dialog Cancel").toBeTruthy();
    cancel.click();
    await nextTick();
    expect(postBrand).not.toHaveBeenCalled();
    // The Branding dialog is still open (Reset still present).
    expect(findButton("Reset")).toBeTruthy();
    app.unmount();
  });
});
