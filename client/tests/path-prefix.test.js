import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { readPathPrefix } from "../pathPrefix.js";
import { storeToken, clearStoredToken } from "../tokenStorage.js";

vi.mock("../api.js", () => ({ getPluginHostCatalog: vi.fn(), openPluginHostEvents: vi.fn(), invokePluginCommand: vi.fn(), getPluginSettings: vi.fn() }));

let wrapper, adapter, runtime;
afterEach(() => {
  wrapper?.unmount(); wrapper = null;
  adapter?.dispose(); adapter = null;
  runtime?.stop(); runtime = null;
  document.querySelectorAll('meta[name="globnotes-prefix"]').forEach(node => node.remove());
  sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals();
});
function prefix(value) {
  const meta = document.createElement("meta");
  meta.name = "globnotes-prefix"; meta.content = value; document.head.appendChild(meta);
  return meta;
}

describe("shared path-prefix reader", () => {
  it("defaults absent/empty metadata to the root prefix", () => {
    expect(readPathPrefix()).toBe(""); prefix(""); expect(readPathPrefix()).toBe("");
  });
  it("reads at each caller boundary and preserves the published prefix literally", () => {
    const meta = prefix("/notes"); expect(readPathPrefix()).toBe("/notes");
    meta.content = "/nested notes/"; expect(readPathPrefix()).toBe("/nested notes/");
  });
  it("retains cookie root fallback and reads a changed prefix at token operations", () => {
    const cookie = vi.spyOn(document, "cookie", "set");
    try {
      storeToken("root"); expect(cookie).toHaveBeenLastCalledWith("token=root; Path=/; SameSite=Strict");
      prefix("/notes"); storeToken("nested", true);
      expect(cookie).toHaveBeenLastCalledWith("token=nested; Path=/notes; SameSite=Strict");
      expect(localStorage.getItem("token")).toBe("nested");
      clearStoredToken(); expect(cookie.mock.calls.at(-1)[0]).toContain("Path=/notes; SameSite=Strict; expires=");
    } finally { cookie.mockRestore(); }
  });
  it("Logo and branding adapters produce the same prefixed custom-asset consumer URLs", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    prefix("/notes"); setActivePinia(createPinia());
    const { useGlobalStore } = await import("../globalStore.js");
    const brand = { name: "Vault", files: ["logo.svg", "icon.png"] };
    useGlobalStore().config = { brand };
    const { default: Logo } = await import("../components/Logo.vue");
    const { createCoreSettingsAdapters } = await import("../coreSettingsAdapters.js");
    wrapper = mount(Logo, { props: { responsive: true } });
    adapter = createCoreSettingsAdapters({ getBrand: () => brand, applyBrand() {}, writable: () => true });
    expect(wrapper.findAll("img").map(node => node.attributes("src"))).toEqual([
      expect.stringMatching(/^\/notes\/_\/brand\/logo.svg\?v=/), expect.stringMatching(/^\/notes\/_\/brand\/icon.png\?v=/),
    ]);
    expect(adapter.brandSnapshot().files.logo.preview).toBe("/notes/_/brand/logo.svg?v=0");
  });
  it("runtime default prefix retains module-load capture for actual module imports", async () => {
    vi.resetModules(); const meta = prefix("/notes");
    const { createPluginRuntime } = await import("../pluginRuntime.js");
    meta.content = "/changed-after-import";
    const importModule = vi.fn(async () => ({ activate() {} }));
    runtime = createPluginRuntime({
      readCatalog: async () => ({ plugins: [{ id: "a plugin", enabled: true, runtime: { client: true } }] }),
      openEvents: async () => () => {}, getSession: () => "fixture", importModule, createSdk: () => ({}), removeOwner() {},
    });
    await runtime.start();
    expect(importModule).toHaveBeenCalledWith(expect.stringMatching(/^\/notes\/_\/plugins\/a%20plugin\/app.js\?v=/));
  });
});
