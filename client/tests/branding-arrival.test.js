import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { applyBrandToDocument } from "../brand.js";
import { initDocTitle, setDocTitleBase } from "../title.js";
import { publish, TOPICS } from "../bus/index.js";
import { setTheme } from "../themes.js";
import { useGlobalStore } from "../globalStore.js";
import Logo from "../components/Logo.vue";

let wrapper;
const brand = { name: "Arriving brand", accent: "#123456", files: [] };
beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  document.head.innerHTML = '<link rel="icon" sizes="16x16" href="/default-16.png"><link rel="shortcut icon" href="/default.ico"><link rel="mask-icon" href="/default-mask.svg" color="#38bdf8"><link rel="manifest" href="/default.webmanifest"><meta name="theme-color" content="#ffffff">';
  setTheme("globnotes-light"); applyBrandToDocument(null); initDocTitle(); setDocTitleBase();
});
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ""; });
it.each(["before", "after"])("composes the non-note title when branding arrives %s navigation", order => {
  if (order === "before") applyBrandToDocument(brand);
  setDocTitleBase(); if (order === "after") applyBrandToDocument(brand);
  expect(document.title).toBe("Arriving brand");
});
it("adopts branding before title initialization without duplicating subscriptions", () => {
  applyBrandToDocument(brand); initDocTitle(); initDocTitle(); expect(document.title).toBe("Arriving brand");
  publish(TOPICS.NOTE_TITLE_CHANGED, { title: "Current note" });
  applyBrandToDocument({ ...brand, name: "Changed brand" }); expect(document.title).toBe("Current note - Changed brand");
});
it("keeps the open note through late and live branding, then resets on navigation", () => {
  publish(TOPICS.NOTE_TITLE_CHANGED, { title: "Current note" }); applyBrandToDocument(brand);
  expect(document.title).toBe("Current note - Arriving brand");
  publish(TOPICS.BRAND_CHANGE, { ...brand, name: "Changed brand" }); expect(document.title).toBe("Current note - Changed brand");
  setDocTitleBase(); expect(document.title).toBe("Changed brand");
});
it("restores all original favicon attributes after successive overrides", () => {
  const icon = document.querySelector('link[rel="icon"]'), shortcut = document.querySelector('link[rel="shortcut icon"]'), mask = document.querySelector('link[rel="mask-icon"]');
  applyBrandToDocument({ ...brand, files: ["icon.svg"] }); expect(icon.getAttribute("href")).toMatch(/^\/_\/brand\/icon.svg\?v=\d+$/);
  applyBrandToDocument(brand); expect([icon.getAttribute("href").startsWith("data:image/svg+xml,"), icon.hasAttribute("sizes"), mask.getAttribute("color")]).toEqual([true, false, "#123456"]);
  applyBrandToDocument({ ...brand, files: ["favicon-16x16.png"] });
  expect([icon.getAttribute("href").split("?")[0], icon.getAttribute("sizes")]).toEqual(["/_/brand/favicon-16x16.png", "16x16"]);
  applyBrandToDocument(null);
  expect([icon.getAttribute("href"), icon.getAttribute("sizes"), shortcut.getAttribute("href"), mask.getAttribute("href"), mask.getAttribute("color")]).toEqual(["/default-16.png", "16x16", "/default.ico", "/default-mask.svg", "#38bdf8"]);
});
it("updates logo, artwork, accent and manifest consumers without remounting", async () => {
  const pinia = createPinia(); setActivePinia(pinia); const store = useGlobalStore(); store.config = {};
  wrapper = mount(Logo, { props: { responsive: true }, global: { plugins: [pinia] } });
  let previous;
  for (const [name, accent, rgb] of [["Arriving brand", "#123456", "18 52 86"], ["Changed brand", "#654321", "101 67 33"]]) {
    const next = { ...brand, name, accent, files: ["logo.svg", "icon.svg"] };
    store.config = { brand: next }; applyBrandToDocument(next); await nextTick();
    expect(wrapper.text()).toContain(name); expect(wrapper.findAll("img").map(image => image.attributes("alt"))).toEqual(["", ""]);
    const src = wrapper.find("img").attributes("src"); expect(src).toMatch(/^\/_\/brand\/logo.svg\?v=\d+$/); expect(src).not.toBe(previous); previous = src;
    expect([document.documentElement.style.getPropertyValue("--theme-brand"), document.querySelector('meta[name="theme-color"]').content, document.querySelector('link[rel="manifest"]').getAttribute("href")]).toEqual([rgb, accent, "/_/brand/site.webmanifest"]);
  }
  store.config = { brand: {} }; applyBrandToDocument(null); await nextTick(); expect(wrapper.findAll("img")).toHaveLength(0); expect(wrapper.text()).not.toContain("Changed brand");
});
