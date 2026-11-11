// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import CtaButton from "../components/CtaButton.vue";
import CustomButton from "../components/CustomButton.vue";
import BrandingSettingsPage from "../components/BrandingSettingsPage.vue";
import ConfirmModal from "../components/ConfirmModal.vue";
import SettingsActions from "../components/SettingsActions.vue";
import { assertSettingsHeaderGeometry } from './e2e/settings-frame-native.mjs';

const wrappers = [];
const settingsViews = import.meta.glob(['../components/*Settings*.vue','../components/settings/*.vue'], {eager:true,query:'?raw',import:'default'});
const mounted = (...args) => { const wrapper = mount(...args); wrappers.push(wrapper); return wrapper; };
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); document.body.innerHTML = ""; });

describe("shared Settings action consumers", () => {
  it('accepts the pre-change header/close geometry and rejects enlarged text-action chrome', async () => {
    const observation={textScale:1,closeContained:true,header:{height:53},close:{width:20,height:28,variant:'text'}};
    const session={read:vi.fn(async()=>observation)};
    expect(await assertSettingsHeaderGeometry(session)).toEqual({height:53,close:observation.close});
    for(const changed of [{header:{height:69}},{close:{width:49.5,height:44,variant:'secondary'}}]){
      session.read.mockResolvedValueOnce({...observation,...changed});
      await expect(assertSettingsHeaderGeometry(session)).rejects.toThrow('Settings header geometry');
    }
  });
  it('scales compact chrome with text size while retaining containment and default-size guards', async () => {
    const observation={textScale:2,closeContained:true,header:{height:137},close:{width:40,height:56,variant:'text'}};
    const session={read:vi.fn(async()=>observation)};
    expect(await assertSettingsHeaderGeometry(session)).toEqual({height:137,close:observation.close});
    for(const changed of [{closeContained:false},{close:{width:20,height:28,variant:'text'}}]){
      session.read.mockResolvedValueOnce({...observation,...changed});
      await expect(assertSettingsHeaderGeometry(session)).rejects.toThrow('Settings header geometry');
    }
  });
  it('does not let labelled Settings action owners select text-only variants', () => {
    for(const [path,source] of Object.entries(settingsViews))for(const tag of source.matchAll(/<CustomButton\b[^>]*>/g)){
      if(/\s:?(?:label)=/.test(tag[0]))expect(tag[0],path).not.toMatch(/variant=["'][^"']*(?:danger-text|\btext\b)/);
    }
  });
  it('keeps icon-only Settings controls compact rather than applying the text-action size', () => {
    const close=settingsViews['../components/SettingsModal.vue'].match(/<CustomButton\b[^>]*aria-label="Close settings"[^>]*>/)[0];
    expect(close).toContain('variant="text"');
    expect(close).toContain('text-tone="normal"');
    expect(close).not.toMatch(/\ssize=/);
    for(const [path,source] of Object.entries(settingsViews))for(const tag of source.matchAll(/<CustomButton\b[^>]*>/g)){
      if(/:icon-path=/.test(tag[0])&&!/\s:?(?:label)=/.test(tag[0]))expect(tag[0],path).not.toContain('size="settings"');
    }
  });
  it('uses one outlined Settings size for every Branding action and keeps file status/help in its row', () => {
    const snapshot={writable:true,name:'Brand',accent:'#123456',canSave:true,canCancel:true,canReset:true,slots:[{id:'logo',label:'Logo',help:'SVG, PNG'}],files:{logo:{}}};
    const wrapper=mounted(BrandingSettingsPage,{props:{snapshot}});
    for(const button of wrapper.findAllComponents(CustomButton)){
      expect(button.props('size')).toBe('settings');
      expect(['secondary','danger','cta']).toContain(button.props('variant'));
      expect(button.classes()).toEqual(expect.arrayContaining(['settings-text','px-4','py-2.5','font-semibold']));
    }
    const row=wrapper.findAll('.setting-row').find(row=>row.text().includes('No custom logo.'));
    expect(row.get('.setting-row-copy p').text()).toBe('SVG, PNG');
    expect(row.get('.setting-row-control .text-theme-text-muted').text()).toBe('No custom logo.');
  });
  it.each(["start", "end"])("composes a standalone %s action without supplying another zone or owning its callback", async zone => {
    const clicked = vi.fn();
    const wrapper = mounted(SettingsActions, { slots: { [zone]: () => h(CtaButton, { label: "Standalone action", type: "button", onClick: clicked }) } });
    expect(wrapper.findAll("button")).toHaveLength(1);
    expect(wrapper.text()).toBe("Standalone action");
    await wrapper.get("button").trigger("click");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("restores main-app danger borders and retains the full-width submit wrapper geometry", () => {
    const primary = mounted(CtaButton, { props: { label: "Save" } }).get("button");
    const danger = mounted(CustomButton, { props: { label: "Discard", variant: "danger", prominent: true }, attrs: { class: 'w-full' } }).get("button");
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
    expect(decisions.find(button=>button.textContent.trim()==='Keep editing').classList.contains('bg-theme-brand')).toBe(false);
    expect(decisions.find(button=>button.textContent.trim()==='Discard').classList.contains('text-theme-danger')).toBe(true);
    expect(decisions.find(button=>button.textContent.trim()==='Discard').closest('[data-settings-actions-start]')).not.toBeNull();
    expect(decisions.find(button=>button.textContent.trim()==='Save / Retry').closest('[data-settings-actions-end]')).not.toBeNull();
    expect(decisions.filter(button=>button.classList.contains('bg-theme-brand'))).toHaveLength(1);
    expect(grouped.find('h2').text()).toBe('Confirmation');
    expect(decisions.find(button => button.textContent.trim() === "Save / Retry").disabled).toBe(true);
    decisions.find(button => button.textContent.trim() === "Keep editing").click();
    expect(grouped.emitted("cancel")).toHaveLength(1);
    const inline = mounted(ConfirmModal, { props: { modelValue: true }, global: { directives: { focus: {} } } });
    expect(inline.findComponent(CustomButton).props("variant")).toBe("subtle");
  });

  it("Branding footer preserves callback admission and writable newer drafts while pending", async () => {
    const onReset = vi.fn(), onSave = vi.fn(), onCancel = vi.fn(), onEdit = vi.fn();
    const snapshot = { writable: true, busy: false, canCancel:true, canSave:true, canReset:true, slots:[], hasBranding: true, dirty: true, unknown: false, name: "Brand", accent: "#123456", files: { logo: {}, icon: {} } };
    const wrapper = mounted(BrandingSettingsPage, { props: { snapshot, onReset, onSave, onCancel, onEdit } });
    const button = label => wrapper.findAll("button").find(button => button.text() === label);
    for (const label of ["Reset branding…", "Save branding", "Cancel changes"]) {
      expect(button(label).attributes("type")).toBe("button");
      expect(button(label).classes()).toContain('focus-ring');
    }
    await button("Reset branding…").trigger("click"); expect(onReset).toHaveBeenCalledTimes(1);
    await button("Save branding").trigger("click"); expect(onSave).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ snapshot: { ...snapshot, busy: true,canSave:false,canReset:false } });
    expect(button("Save branding")).toBeUndefined();
    expect(button("Reset branding…")).toBeUndefined();
    expect(wrapper.get("#brand-name").element.readOnly).toBe(false);
    await wrapper.get("#brand-name").setValue("Newer brand");
    expect(onEdit).toHaveBeenCalledWith("name", "Newer brand");
    await button("Cancel changes").trigger("click"); expect(onCancel).toHaveBeenCalledTimes(1);
    await wrapper.setProps({snapshot:{...snapshot,busy:true,canSave:false,canReset:false,canCancel:false}});
    expect(button('Cancel changes')).toBeUndefined();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
