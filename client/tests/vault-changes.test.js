import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../api.js", () => ({ openVaultChanges: vi.fn() }));
import { createVaultChanges } from "../vaultChanges.js";
import { TOPICS } from "../bus/index.js";

afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);
describe("vault change owner", () => {
  it("shares one connection, publishes once, resumes the cursor, and fences retired delivery", async () => {
    vi.useFakeTimers();
    const calls = [], disposers = [], publish = vi.fn();
    const owner = createVaultChanges({ publish, open: async options => {
      calls.push(options); const dispose = vi.fn(); disposers.push(dispose); return dispose;
    } });
    const a = owner.acquire(), b = owner.acquire(); await flush();
    expect(calls).toHaveLength(1);
    calls[0].onEvent({ event: "change", data: { seq: 5, path: "note.md", kind: "modified", hash: "v" } });
    calls[0].onEvent({ event: "change", data: { seq: 5, path: "note.md" } });
    expect(publish).toHaveBeenCalledExactlyOnceWith(TOPICS.VAULT_CHANGE, expect.objectContaining({ seq: 5 }));
    calls[0].onClose("ended"); await vi.advanceTimersByTimeAsync(500);
    expect(calls[1].since).toBe(5);
    calls[0].onEvent({ event: "change", data: { seq: 99 } });
    expect(owner.state().seq).toBe(5);
    calls[1].onEvent({ event: "reset", data: { next: 40 } });
    expect(publish).toHaveBeenLastCalledWith(TOPICS.VAULT_RESET, { next: 40 });
    a(); expect(disposers[1]).not.toHaveBeenCalled(); b(); b();
    expect(disposers[1]).toHaveBeenCalledTimes(1);
    calls[1].onClose("ended"); await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
  });
  it("switches to polling after a stream failure and fences a late open", async () => {
    vi.useFakeTimers(); let resolve; const close = vi.fn(), calls = [];
    const owner = createVaultChanges({ open: vi.fn(options => {
      calls.push(options); if (calls.length === 1) return Promise.reject(new Error("proxy"));
      return new Promise(yes => { resolve = yes; });
    }) });
    const release = owner.acquire(); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(calls[1].poll).toBe(true);
    release(); resolve(close); await flush(); expect(close).toHaveBeenCalledTimes(1);
  });
  it("poll cursors advance even when hidden paths produce no public entries", async () => {
    vi.useFakeTimers(); let options;
    const owner = createVaultChanges({ open: async value => { options = value; return () => {}; } });
    const release = owner.acquire(); await flush();
    options.onEvent({ event: "cursor", data: { next: 123 } });
    expect(owner.state().seq).toBe(123); release();
  });
});
