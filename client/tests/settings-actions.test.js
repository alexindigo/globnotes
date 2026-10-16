// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import CtaButton from "../components/CtaButton.vue";
import CustomButton from "../components/CustomButton.vue";
import BrandingSettingsPage from "../components/BrandingSettingsPage.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import SettingsActions from "../components/SettingsActions.vue";

const wrappers = [];
const mounted = (...args) => { const wrapper = mount(...args); wrappers.push(wrapper); return wrapper; };
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); document.body.innerHTML = ""; });

describe("shared Settings action consumers", () => {
  it.each(["start", "end"])("composes a standalone %s action without supplying another zone or owning its callback", async zone => {
    const clicked = vi.fn();
    const wrapper = mounted(SettingsActions, { slots: { [zone]: () => h(CtaButton, { label: "Standalone action", type: "button", onClick: clicked }) } });
    expect(wrapper.findAll("button")).toHaveLength(1);
    expect(wrapper.text()).toBe("Standalone action");
    await wrapper.get("button").trigger("click");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("danger keeps semantic colors with the same prominent geometry as primary", () => {
    const primary = mounted(CtaButton, { props: { label: "Save" } }).get("button");
    const danger = mounted(CtaButton, { props: { label: "Discard", intent: "danger" } }).get("button");
    for (const button of [primary, danger]) {
      expect(button.classes()).toEqual(expect.arrayContaining(["w-full", "px-4", "py-2.5", "font-semibold"]));
    }
    expect(danger.classes()).toContain("text-theme-danger");
    expect(danger.classes()).toContain("border-theme-danger");
    expect(danger.classes()).not.toContain("bg-theme-brand");
    expect(primary.classes()).toContain("bg-theme-brand");
  });

  it("retains compact defaults and opt-in prominence for unrelated button variants", () => {
    const compact = mounted(CustomButton, { props: { label: "Navigation", variant: "danger" } }).get("button");
    expect(compact.classes()).toEqual(expect.arrayContaining(["px-2", "py-1"]));
    expect(compact.classes()).not.toContain("font-semibold");
    const prominent = mounted(CustomButton, { props: { label: "Action", variant: "danger", prominent: true } }).get("button");
    expect(prominent.classes()).toEqual(expect.arrayContaining(["px-4", "py-2.5", "font-semibold"]));
  });

  it("keeps callback, click attrs, disabled state and form submission owned by the consumer", async () => {
    const submit = vi.fn(), action = vi.fn(), clicked = vi.fn();
    const Form = defineComponent({ setup: () => () => h("form", { onSubmit: event => { event.preventDefault(); submit(); } }, [
      h(CtaButton, { label: "Save", callback: action, onClick: clicked, type: "submit", "aria-busy": "true", "aria-label": "Save settings" }),
      h(CtaButton, { label: "Cancel", type: "button" }),
    ]) });
    const wrapper = mounted(Form, { attachTo: document.body });
    wrapper.get("button[type=submit]").element.click();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(wrapper.get("button").attributes("aria-busy")).toBe("true");
    expect(wrapper.get("button").attributes("aria-label")).toBe("Save settings");
    wrapper.get("button[type=button]").element.click();
    expect(submit).toHaveBeenCalledTimes(1);
    const disabled = mounted(CtaButton, { props: { label: "Blocked", disabled: true, callback: action }, attachTo: document.body });
    disabled.get("button").element.click();
    expect(action).toHaveBeenCalledTimes(1);
    // Login relies on implicit submit; do not impose a button default.
    expect(mounted(CtaButton, { props: { label: "Log In" } }).get("button").attributes("type")).toBeUndefined();
  });

  it("preserves slot content and complete long accessible labels", () => {
    const label = "LongUnbrokenLabel".repeat(12);
    const wrapper = mounted(CtaButton, { props: { label }, slots: { default: '<span data-slot>Additional content</span>' } });
    expect(wrapper.get("button").text()).toContain(label);
    expect(wrapper.find("[data-slot]").exists()).toBe(true);
  });

  it("uses grouped confirmation only on request while retaining each decision and disabled save", async () => {
    const grouped = mounted(ConfirmModal, { props: { modelValue: true, actionLayout: "grouped", confirmDisabled: true, confirmButtonText: "Save / Retry", rejectButtonText: "Discard", cancelButtonText: "Keep editing" },
      attachTo: document.body, global: { directives: { focus: { mounted: el => el.focus() } } } });
    const decisions = [...document.querySelectorAll("button")];
    expect(decisions.every(button => button.type === "button")).toBe(true);
    expect(decisions.every(button => button.classList.contains("py-2.5"))).toBe(true);
    expect(decisions.find(button => button.textContent.trim() === "Save / Retry").disabled).toBe(true);
    decisions.find(button => button.textContent.trim() === "Keep editing").click();
    expect(grouped.emitted("cancel")).toHaveLength(1);
    const inline = mounted(ConfirmModal, { props: { modelValue: true }, global: { directives: { focus: {} } } });
    expect(inline.findComponent(CustomButton).props("variant")).toBe("subtle");
  });

  it("Branding footer preserves callback admission and writable newer drafts while pending", async () => {
    const onReset = vi.fn(), onSave = vi.fn(), onCancel = vi.fn(), onEdit = vi.fn();
    const snapshot = { writable: true, busy: false, hasBranding: true, dirty: true, unknown: false, name: "Brand", accent: "#123456", files: { logo: {}, icon: {} } };
    const wrapper = mounted(BrandingSettingsPage, { props: { snapshot, onReset, onSave, onCancel, onEdit } });
    const button = label => wrapper.findAll("button").find(button => button.text() === label);
    for (const label of ["Reset", "Save", "Cancel"]) {
      expect(button(label).attributes("type")).toBe("button");
      expect(button(label).classes()).toContain("py-2.5");
    }
    await button("Reset").trigger("click"); expect(onReset).toHaveBeenCalledTimes(1);
    await button("Save").trigger("click"); expect(onSave).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ snapshot: { ...snapshot, busy: true } });
    expect(button("Save").element.disabled).toBe(true);
    expect(button("Reset").element.disabled).toBe(true);
    expect(wrapper.get("#brand-name").element.readOnly).toBe(false);
    await wrapper.get("#brand-name").setValue("Newer brand");
    expect(onEdit).toHaveBeenCalledWith("name", "Newer brand");
    await button("Cancel").trigger("click"); expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
