// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The loader's fetch/enable selection logic, isolated from the network
// and localStorage (the import() itself is browser-cached and exercised
// by the e2e matrix).
vi.mock("../api.js", async importOriginal => ({
  ...await importOriginal(),
  getPlugins: vi.fn(),
}));
vi.mock("../pluginSettings.js", () => ({
  isPluginEnabled: vi.fn(),
}));
vi.mock("../bus/index.js", () => ({
  subscribe: vi.fn(),
  TOPICS: { PLUGIN_TOGGLE: "plugin:toggle" },
}));

import { getPlugins } from "../api.js";
import { isPluginEnabled } from "../pluginSettings.js";
import {
  loadClientPlugins,
} from "../pluginLoader.js";

describe("pluginLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when the plugin list fetch fails", async () => {
    getPlugins.mockRejectedValue(new Error("down"));
    await expect(loadClientPlugins()).resolves.toEqual([]);
  });

  it("returns [] when no plugin is dual-mode", async () => {
    getPlugins.mockResolvedValue([
      { id: "a", client: false },
      { id: "b" },
    ]);
    await expect(loadClientPlugins()).resolves.toEqual([]);
  });

  it("uses the vault-enabled listing despite disabled legacy preferences and isolates a broken client module", async () => {
    // Disabled vault plugins are absent from this compatibility endpoint.
    getPlugins.mockResolvedValue([{ id: "on", client: true }, { id: "server-only", client: false }]);
    isPluginEnabled.mockReturnValue(false);
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(loadClientPlugins()).resolves.toEqual([]);
      expect(isPluginEnabled).not.toHaveBeenCalled();
      const failures = diagnostics.mock.calls.filter(([message]) => String(message).includes("client module failed to load"));
      expect(failures).toHaveLength(1);
      expect(failures[0][0]).toBe("plugin 'on' client module failed to load");
    } finally { diagnostics.mockRestore(); }
  });
});
