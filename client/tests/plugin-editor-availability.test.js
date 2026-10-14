import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({ getPlugins: vi.fn(async () => []) }));
vi.mock("../pluginRuntime.js", async () => {
  const { ref } = await import("vue");
  return { pluginCatalog: ref(null) };
});
vi.mock("../pluginSettings.js", () => ({ isPluginEnabled: vi.fn(() => false) }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe("vault-owned editor participation", () => {
  it("retires and restores editor factories from catalog policy without legacy preference events", async () => {
    const { nextTick } = await import("vue");
    const { pluginCatalog } = await import("../pluginRuntime.js");
    pluginCatalog.value = { plugins: [
      { id: "properties", client: true, enabled: true },
      { id: "commands", client: false, enabled: true, runtime: { client: true } },
    ] };
    const { clientPluginEpoch } = await import("../pluginLoader.js");
    await nextTick();
    const initial = clientPluginEpoch.value;
    pluginCatalog.value = { plugins: [
      { id: "properties", client: true, enabled: false },
      { id: "commands", client: false, enabled: true, runtime: { client: true } },
    ] };
    await nextTick();
    expect(clientPluginEpoch.value).toBe(initial + 1);
    pluginCatalog.value = { plugins: [
      { id: "properties", client: true, enabled: true },
      { id: "commands", client: false, enabled: true, runtime: { client: true } },
    ] };
    await nextTick();
    expect(clientPluginEpoch.value).toBe(initial + 2);
    pluginCatalog.value = { plugins: [
      { id: "properties", client: true, enabled: true },
      { id: "commands", client: false, enabled: false, runtime: { client: true } },
    ] };
    await nextTick();
    expect(clientPluginEpoch.value).toBe(initial + 2);
  });

  it("does not remount for catalog reordering or unrelated permission/settings metadata", async () => {
    const { nextTick } = await import("vue");
    const { pluginCatalog } = await import("../pluginRuntime.js");
    pluginCatalog.value = { plugins: [
      { id: "one", client: true, enabled: true },
      { id: "two", client: true, enabled: true },
    ] };
    const { clientPluginEpoch } = await import("../pluginLoader.js");
    await nextTick();
    const initial = clientPluginEpoch.value;
    pluginCatalog.value = { plugins: [
      { id: "two", client: true, enabled: true, permissions: { revision: 8 } },
      { id: "one", client: true, enabled: true, pages: [{ id: "prefs" }] },
    ] };
    await nextTick();
    expect(clientPluginEpoch.value).toBe(initial);
    pluginCatalog.value = { plugins: [{ id: "one", client: true, enabled: true }] };
    await nextTick();
    expect(clientPluginEpoch.value).toBe(initial + 1);
  });

  it("does not use old browser switches as an editor activation authority", async () => {
    const { getPlugins } = await import("../api.js");
    const { isPluginEnabled } = await import("../pluginSettings.js");
    getPlugins.mockResolvedValue([{ id: "editor-fixture", client: true }]);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { loadClientPlugins } = await import("../pluginLoader.js");
      // A DOM-shim has no backend module URL. Native coverage observes the
      // real factory; here we prove the legacy switch never gates admission.
      await loadClientPlugins();
      expect(isPluginEnabled).not.toHaveBeenCalled();
    } finally { diagnostic.mockRestore(); }
  });
});
