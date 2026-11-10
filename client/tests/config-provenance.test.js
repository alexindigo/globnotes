// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createCoreSettingsAdapters } from "../coreSettingsAdapters.js";
import { settingsFieldPresentation } from "../declarativeSettings.js";
import BrandingSettingsPage from "../components/BrandingSettingsPage.vue";
import { createPluginInventoryController } from "../pluginInventoryController.js";

let adapter;
beforeEach(() => { window.matchMedia = vi.fn(() => ({ matches:false, addEventListener(){}, removeEventListener(){} })); });
afterEach(() => adapter?.dispose());
describe("configuration provenance consumers", () => {
  for (const source of ["toml", "environment"]) it(`explains ${source} plugin field pins`, () => {
    expect(settingsFieldPresentation({ type:"text" }, "value", { source, readonly:true }).pin).toBe("Set by the server configuration");
    expect(settingsFieldPresentation({ type:"text" }, "value", { source, readonly:false }).pin).toBe("");
  });
  for (const source of ["toml", "environment"]) it(`rejects ${source} auto-enable intent at the controller`, async () => {
    const writePolicy = vi.fn();
    const inventory = createPluginInventoryController({ getCatalog:()=>({policy:{revision:0,signature:"current",autoEnableSource:source}}), getSession:()=>"session", writable:()=>true, writePolicy });
    expect(await inventory.setAutoEnable(false)).toBe(false);
    expect(writePolicy).not.toHaveBeenCalled(); expect(inventory.hasWork()).toBe(false); inventory.dispose();
  });
  it("disables only the pinned name and omits it from save/reset payloads", async () => {
    let brand = { name:"Deployment", accent:"#aabbcc", files:[], fields:{ name:{source:"environment",readonly:true}, accent:{source:"toml",readonly:false} } };
    const writeBrand = vi.fn(async form => ({ ...brand, accent:form.get("accent") || null }));
    adapter = createCoreSettingsAdapters({ getBrand:()=>brand, applyBrand:fresh=>{brand=fresh;}, writable:()=>true, writeBrand, readBrand:async()=>brand });
    adapter.loadBrand();
    const wrapper = mount(BrandingSettingsPage, { props:{ snapshot:adapter.brandSnapshot() } });
    expect(wrapper.get('#brand-name').element.disabled).toBe(true);
    expect(wrapper.get('#brand-accent').element.disabled).toBe(false);
    expect(wrapper.text()).toContain("Set by the server configuration");
    adapter.editBrand("name", "Forbidden"); expect(adapter.brandSnapshot().name).toBe("Deployment");
    adapter.editBrand("accent", "#112233"); expect(await adapter.saveBrand()).toBe(true);
    expect(writeBrand.mock.calls[0][0].has("name")).toBe(false);
    expect(writeBrand.mock.calls[0][0].get("accent")).toBe("#112233");
    expect(adapter.resetMessage()).toContain("Pinned settings remain unchanged");
    expect(adapter.resetMessage()).not.toContain('name "Deployment"');
    expect(await adapter.saveBrand(true)).toBe(true);
    expect(writeBrand.mock.calls[1][0].has("name")).toBe(false);
    expect(writeBrand.mock.calls[1][0].get("accent")).toBe("");
    expect(adapter.brandSnapshot().name).toBe("Deployment");
    wrapper.unmount();
  });
  it("retains a draft if a refreshed pin makes it unwritable", async () => {
    let brand = {name:"old",accent:null,files:[]}; const writeBrand = vi.fn();
    adapter = createCoreSettingsAdapters({ getBrand:()=>brand, applyBrand:()=>{}, writable:()=>true, writeBrand, readBrand:async()=>brand });
    adapter.loadBrand(); adapter.editBrand("name","draft");
    brand = {...brand, fields:{name:{source:"environment",readonly:true}}};
    expect(adapter.brandSnapshot().canSave).toBe(false);
    expect(await adapter.saveBrand()).toBe(false);
    expect(adapter.brandSnapshot().name).toBe("draft"); expect(adapter.hasWork()).toBe(true);
    expect(writeBrand).not.toHaveBeenCalled();
  });
});
