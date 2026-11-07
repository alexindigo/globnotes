import { afterEach, expect, it, vi } from "vitest";
vi.mock("../api.js", () => ({ openVaultChanges: vi.fn(), getPluginHostCatalog: vi.fn(), openPluginHostEvents: vi.fn(), getPluginSettings: vi.fn(), invokePluginCommand: vi.fn() }));
vi.mock("../keybindings/dispatcher.js", () => ({ dispatchAction: vi.fn() }));
import { createConnectionLifetime, HIDDEN_GRACE_MS } from "../connectionLifetime.js";
import { createVaultChanges } from "../vaultChanges.js";
import { createPluginRuntime } from "../pluginRuntime.js";
import { hasCommand, runCommand } from "../commands.js";

afterEach(() => vi.useRealTimers());
it("one timer suspends both owners, fences retired events, resumes the cursor and reactivates fresh contributions", async () => {
  vi.useFakeTimers();
  const lifetime = createConnectionLifetime(), vaultCalls = [], pluginCalls = [], publish = vi.fn();
  const readCatalog = vi.fn(async () => ({ plugins: [{ id: "visibility", enabled: true, runtime: { client: true } }] }));
  let generation = 0;
  const vault = createVaultChanges({ lifetime, publish, open: async options => { vaultCalls.push(options); return vi.fn(); } });
  const plugin = createPluginRuntime({ lifetime, readCatalog, openEvents: async options => { pluginCalls.push(options); return vi.fn(); },
    importModule: async () => ({ activate(ctx) { const own = ++generation; ctx.commands.register({ id: "live", label: "Visibility witness" }, () => own); } }) });
  const release = vault.acquire(); await plugin.start();
  try {
    vaultCalls[0].onEvent({ event: "change", data: { seq: 7, path: "a.md" } });
    expect(await runCommand("plugin:visibility:live")).toEqual({ result: 1 });
    lifetime.setVisible(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS - 1);
    lifetime.setVisible(true);
    expect(pluginCalls).toHaveLength(1); expect(vaultCalls).toHaveLength(1);
    lifetime.setVisible(false); await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS);
    expect(vaultCalls[0].signal.aborted).toBe(true); expect(pluginCalls[0].signal.aborted).toBe(true);
    expect(hasCommand("plugin:visibility:live")).toBe(false);
    vaultCalls[0].onEvent({ event: "change", data: { seq: 99 } });
    pluginCalls[0].onEvent({ event: "invalidate" }); pluginCalls[0].onClose("ended"); vaultCalls[0].onClose("ended");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readCatalog).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledTimes(1);
    lifetime.suspendDocument(); lifetime.setVisible(true); await vi.advanceTimersByTimeAsync(0);
    expect(pluginCalls).toHaveLength(1); // Visibility cannot override pagehide.
    lifetime.resumeDocument(); await vi.advanceTimersByTimeAsync(0);
    expect(vaultCalls).toHaveLength(2); expect(vaultCalls[1].since).toBe(7);
    expect(pluginCalls).toHaveLength(2); expect(readCatalog).toHaveBeenCalledTimes(2);
    expect(await runCommand("plugin:visibility:live")).toEqual({ result: 2 });
  } finally { release(); plugin.stop(); }
});
