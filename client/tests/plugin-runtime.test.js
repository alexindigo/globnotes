import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  getPluginSettings: vi.fn(),
  invokePluginCommand: vi.fn(),
}));
vi.mock("../bus/index.js", () => ({
  subscribe: vi.fn(() => vi.fn()),
  TOPICS: {},
}));
vi.mock("../keybindings/dispatcher.js", () => ({ dispatchAction: vi.fn() }));
vi.mock("../commands.js", () => ({ registerPluginCommand: vi.fn(() => vi.fn()) }));

import { getPluginSettings } from "../api.js";
import { subscribe } from "../bus/index.js";
import { dispatchAction } from "../keybindings/dispatcher.js";
import { registerPluginCommand } from "../commands.js";
import { createPluginSdk } from "../pluginSdk.js";

describe("pluginSdk facade", () => {
  let disposers;
  const own = (fn) => {
    disposers.add(fn);
    return () => {
      disposers.delete(fn);
      fn();
    };
  };

  beforeEach(() => {
    disposers = new Set();
    vi.clearAllMocks();
  });

  it("exposes only the narrow surface — no stores, auth or editor refs", () => {
    const sdk = createPluginSdk({ pluginId: "p", snapshot: { a: 1 }, own });
    expect(Object.keys(sdk).sort()).toEqual([
      "actions",
      "commands",
      "events",
      "pluginId",
      "register",
      "settings",
      "snapshot",
      "timers",
    ]);
    expect(sdk.snapshot.a).toBe(1);
    expect(Object.isFrozen(sdk.snapshot)).toBe(true);
  });

  it("managed event subscriptions isolate handler failures and dispose", () => {
    const sdk = createPluginSdk({ pluginId: "p", snapshot: {}, own });
    const unsubscribe = vi.fn();
    subscribe.mockReturnValue(unsubscribe);
    const release = sdk.events.on("note:save", () => {
      throw new Error("plugin bug");
    });
    const wrapped = subscribe.mock.calls[0][1];
    expect(() => wrapped({ path: "x" })).not.toThrow();
    expect(disposers.size).toBe(1);
    release();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("actions.dispatch funnels through the common action channel", () => {
    const sdk = createPluginSdk({ pluginId: "p", snapshot: {}, own });
    sdk.actions.dispatch("app:open-settings", { page: "plugins" });
    expect(dispatchAction).toHaveBeenCalledWith("app:open-settings", {
      page: "plugins",
    });
  });

  it("commands.register owns the registration", () => {
    const sdk = createPluginSdk({ pluginId: "p", snapshot: {}, own });
    sdk.commands.register({ id: "c", label: "C" }, () => {});
    expect(registerPluginCommand).toHaveBeenCalledWith(
      "p",
      { id: "c", label: "C", target: "browser" },
      expect.any(Function),
    );
  });

  it("settings.read scopes to the owning plugin", async () => {
    getPluginSettings.mockResolvedValue({ values: { n: 1 }, revision: 2 });
    const sdk = createPluginSdk({ pluginId: "p", snapshot: {}, own });
    const result = await sdk.settings.read("preferences");
    expect(getPluginSettings).toHaveBeenCalledWith("p", "preferences");
    expect(result.values.n).toBe(1);
  });

  it("timers are owned and cleaned up", async () => {
    vi.useFakeTimers();
    const sdk = createPluginSdk({ pluginId: "p", snapshot: {}, own });
    const fn = vi.fn();
    const release = sdk.timers.setTimeout(fn, 100);
    vi.advanceTimersByTime(150);
    await Promise.resolve(); // the handler body runs in a microtask
    expect(fn).toHaveBeenCalledTimes(1);
    expect(disposers.size).toBe(0); // one-shot released itself after firing
    release();
    vi.useRealTimers();
  });
});
