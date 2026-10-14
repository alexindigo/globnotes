import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  invokePluginCommand: vi.fn(),
  getPluginSettings: vi.fn(),
  getPluginHostCatalog: vi.fn(),
  openPluginHostEvents: vi.fn(),
}));
vi.mock("../keybindings/dispatcher.js", () => ({
  dispatchAction: vi.fn(),
}));
vi.mock("../keybindings/layers.js", () => ({
  ACTIONS: {
    "app:new-note": { label: "New note", group: "Note", binding: "app" },
  },
}));
vi.mock("../keybindings/store.js", () => ({ effectiveBindings: () => ({}) }));
vi.mock("../keybindings/keys.js", () => ({ platformKey: (b) => b?.key ?? "" }));

import { invokePluginCommand } from "../api.js";
import { dispatchAction } from "../keybindings/dispatcher.js";
import { registerModal } from "../modalState.js";
import {
  commandRegistry,
  hasCommand,
  registerPluginCommand,
  removeCommandOwner,
  runCommand,
} from "../commands.js";

describe("command registry", () => {
  beforeEach(() => {
    removeCommandOwner("alpha");
    removeCommandOwner("beta");
    vi.clearAllMocks();
  });

  it("seeds built-ins from ACTIONS metadata", () => {
    expect(commandRegistry.value.some((c) => c.id === "app:new-note")).toBe(true);
    expect(hasCommand("app:new-note")).toBe(true);
  });

  it("plugin commands are namespaced and cannot collide", () => {
    const dispose = registerPluginCommand(
      "alpha",
      { id: "backup", label: "Backup now", target: "browser" },
      () => "done",
    );
    expect(hasCommand("plugin:alpha:backup")).toBe(true);
    expect(() =>
      registerPluginCommand(
        "alpha",
        { id: "backup", label: "Dup", target: "browser" },
        () => {},
      ),
    ).toThrow("duplicate");
    expect(() =>
      registerPluginCommand(
        "beta",
        { id: "../alpha:backup", label: "X", target: "browser" },
        () => {},
      ),
    ).not.toThrow(); // namespacing isolates owners
    removeCommandOwner("beta");
    dispose();
    expect(hasCommand("plugin:alpha:backup")).toBe(false);
  });

  it("browser commands run their handler; server commands dispatch via POST", async () => {
    registerPluginCommand(
      "alpha",
      { id: "local", label: "Local", target: "browser" },
      (payload) => ({ got: payload }),
    );
    const local = await runCommand("plugin:alpha:local", { n: 1 });
    expect(local.result).toEqual({ got: { n: 1 } });

    invokePluginCommand.mockResolvedValue({ answer: 42 });
    registerPluginCommand("alpha", { id: "remote", label: "Remote", target: "server" });
    const remote = await runCommand("plugin:alpha:remote", { q: "x" });
    expect(invokePluginCommand).toHaveBeenCalledWith("alpha", "remote", { q: "x" });
    expect(remote.result).toEqual({ answer: 42 });
  });

  it("public palette/remapping entries carry the IDs that execute their real consumers", async () => {
    const consumer = vi.fn(payload => ({ received: payload }));
    registerPluginCommand("alpha", { id: "local", label: "Registry-selected local", target: "browser" }, consumer);
    registerPluginCommand("alpha", { id: "remote", label: "Registry-selected remote", target: "server" });
    const entries = commandRegistry.value.filter(entry => entry.owner === "alpha");
    expect(entries.map(entry => entry.id)).toEqual(["plugin:alpha:local", "plugin:alpha:remote"]);
    const local = await runCommand(entries.find(entry => entry.target === "browser").id, { message: "from registry" });
    expect(local.result).toEqual({ received: { message: "from registry" } });
    expect(consumer).toHaveBeenCalledWith({ message: "from registry" });
    invokePluginCommand.mockResolvedValue({ persisted: "server consumer" });
    const remote = await runCommand(entries.find(entry => entry.target === "server").id, { value: 7 });
    expect(remote.result).toEqual({ persisted: "server consumer" });
    expect(invokePluginCommand).toHaveBeenCalledWith("alpha", "remote", { value: 7 });
  });

  it("built-ins dispatch through the action channel (admission)", async () => {
    const result = await runCommand("app:new-note", {});
    expect(dispatchAction).toHaveBeenCalledWith("app:new-note", {});
    expect(result.admitted).toBe(true);
  });

  it("disabled owners disappear from availability", () => {
    registerPluginCommand("alpha", { id: "x", label: "X", target: "browser" }, () => {});
    removeCommandOwner("alpha");
    expect(hasCommand("plugin:alpha:x")).toBe(false);
    expect(commandRegistry.value.some((c) => c.id === "plugin:alpha:x")).toBe(false);
  });

  it("browser commands require a handler", () => {
    expect(() =>
      registerPluginCommand("alpha", { id: "bad", label: "Bad", target: "browser" }),
    ).toThrow("handler");
  });
  it("browser UI command entry cannot run behind a dialog that owns the input", async () => {
    const consumer=vi.fn(); registerPluginCommand('alpha',{id:'local',label:'Local',target:'browser'},consumer);
    const dialog=registerModal({name:'settings'});
    try { expect(await runCommand('plugin:alpha:local')).toEqual({admitted:false}); expect(consumer).not.toHaveBeenCalled(); }
    finally { dialog.dispose(); }
  });
});
