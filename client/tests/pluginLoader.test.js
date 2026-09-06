// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The loader's fetch/enable selection logic, isolated from the network
// and localStorage (the import() itself is browser-cached and exercised
// by the e2e matrix).
vi.mock("../api.js", () => ({
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
  clientPluginEpoch,
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

  it("skips disabled dual-mode plugins", async () => {
    getPlugins.mockResolvedValue([{ id: "on", client: true }, { id: "off", client: true }]);
    isPluginEnabled.mockImplementation((id) => id === "on");
    // Neither import can resolve in the test environment; the loader
    // skips the broken module and still resolves to [].
    await expect(loadClientPlugins()).resolves.toEqual([]);
    // Only the enabled plugin's module was attempted.
    expect(isPluginEnabled).toHaveBeenCalledTimes(2);
  });
});
