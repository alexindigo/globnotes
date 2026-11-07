import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../api.js", () => ({ openVaultChanges: vi.fn() }));
import { acquireVaultChanges, createVaultChanges, HIDDEN_GRACE_MS, MAX_DELAY_MS, STABLE_MS, STREAM_RETRY_MS,
  TERMINAL_STATUSES } from "../vaultChanges.js";
import { openVaultChanges } from "../api.js";
import { TOPICS } from "../bus/index.js";

afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);
describe("vault change owner", () => {
  it("suspends document-owned wires and resumes once from the accepted cursor", async () => {
    vi.useFakeTimers();
    const calls = [], disposers = [], publish = vi.fn();
    const owner = createVaultChanges({ publish, open: async options => {
      calls.push(options); const close = vi.fn(); disposers.push(close); return close;
    } });
    const first = owner.acquire(); await flush();
    calls[0].onEvent({ event: "change", data: { seq: 7, path: "note.md" } });
    owner.suspendDocument();
    expect(calls[0].signal.aborted).toBe(true); expect(disposers[0]).toHaveBeenCalledTimes(1);
    const second = owner.acquire();
    calls[0].onEvent({ event: "change", data: { seq: 99 } }); calls[0].onClose("ended");
    await vi.advanceTimersByTimeAsync(60_000); expect(calls).toHaveLength(1); expect(owner.state().seq).toBe(7);
    owner.resumeDocument(); await flush(); owner.resumeDocument(); await flush();
    expect(calls).toHaveLength(2); expect(calls[1].since).toBe(7);
    first(); second(); expect(disposers[1]).toHaveBeenCalledTimes(1);
  });
  it("the app singleton releases pagehide streams and reconnects after pageshow", async () => {
    vi.useFakeTimers(); const closes = [], calls = [];
    openVaultChanges.mockImplementation(async options => { calls.push(options); const close = vi.fn(); closes.push(close); return close; });
    const release = acquireVaultChanges(); await flush();
    try {
      window.dispatchEvent(new Event("pagehide"));
      expect(calls[0].signal.aborted).toBe(true); expect(closes[0]).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event("pageshow")); await flush();
      expect(calls).toHaveLength(2);
    } finally { release(); window.dispatchEvent(new Event("pageshow")); }
  });
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
  // One lifecycle rule (PR #30 round 1): every outcome except a definitive
  // auth/unsupported answer reconnects, with a delay that stays bounded and
  // recovers once a connection proves healthy.
  function harness(outcome) {
    let clock = 0; const calls = [], disposers = [];
    const owner = createVaultChanges({ now: () => clock, open: async options => {
      calls.push(options);
      const result = outcome(calls.length, options);
      if (result instanceof Error) throw result;
      const dispose = vi.fn(); disposers.push(dispose); return dispose;
    } });
    return { owner, calls, disposers, advance: async ms => { clock += ms; await vi.advanceTimersByTimeAsync(ms); } };
  }
  const status = code => Object.assign(new Error(`status ${code}`), { status: code });
  async function delaysUntil(h, count) {
    const delays = [];
    while (h.calls.length < count) {
      const before = h.calls.length; let waited = 0;
      while (h.calls.length === before) { await h.advance(100); waited += 100; if (waited > MAX_DELAY_MS + 1000) throw Error("no reconnect"); }
      delays.push(waited);
    }
    return delays;
  }
  it("a transient 503 (or network failure, 429, 502) retries with bounded backoff and recovers", async () => {
    vi.useFakeTimers();
    for (const failure of [status(503), new TypeError("network"), status(429), status(502)]) {
      const h = harness(n => n <= 9 ? failure : undefined);
      const release = h.owner.acquire(); await flush();
      const delays = await delaysUntil(h, 10);
      expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, MAX_DELAY_MS, MAX_DELAY_MS, MAX_DELAY_MS]);
      expect(h.owner.state().connected).toBe(true);
      release();
    }
  });
  it("only definitive auth or unsupported answers stop reconnecting", async () => {
    vi.useFakeTimers();
    expect([...TERMINAL_STATUSES].sort()).toEqual([400, 401, 403, 404, 405, 410, 501]);
    for (const code of TERMINAL_STATUSES) {
      const h = harness(() => status(code));
      const release = h.owner.acquire(); await flush();
      await h.advance(10 * MAX_DELAY_MS);
      expect(h.calls).toHaveLength(1);
      release();
    }
  });
  it("a stream that stayed open resets the backoff; short-lived ones keep growing it", async () => {
    vi.useFakeTimers();
    const h = harness(() => undefined);
    const release = h.owner.acquire(); await flush();
    // Streams the server ends at once (a misbehaving proxy): the delay grows.
    for (let i = 0; i < 4; i++) {
      h.calls.at(-1).onClose("ended");
      expect(await delaysUntil(h, h.calls.length + 1)).toEqual([500 * 2 ** i]);
    }
    // A quiet vault behind a proxy idle timeout: open past STABLE_MS, then a
    // clean end. The next reconnect starts over instead of waiting 8 s+.
    await h.advance(STABLE_MS);
    h.calls.at(-1).onClose("ended");
    expect(await delaysUntil(h, h.calls.length + 1)).toEqual([500]);
    // So does a stream that broke after being healthy (now polling).
    await h.advance(STABLE_MS);
    h.calls.at(-1).onClose(new TypeError("network changed"));
    expect(await delaysUntil(h, h.calls.length + 1)).toEqual([500]);
    expect(h.calls.at(-1).poll).toBe(true);
    release();
  });
  it("polling after a stream failure is temporary: the stream is tried again", async () => {
    vi.useFakeTimers();
    const h = harness(() => undefined);
    const release = h.owner.acquire(); await flush();
    h.calls[0].onClose(new TypeError("read failed")); await delaysUntil(h, 2);
    expect(h.calls[1].poll).toBe(true);
    // Polls complete once a second; a completed poll keeps the backoff at zero.
    while (h.calls.at(-1).poll) {
      await h.advance(1000); h.calls.at(-1).onClose("poll"); await flush();
      expect(h.owner.state().attempts).toBe(0);
      if (h.calls.length > STREAM_RETRY_MS / 1000 + 5) throw Error("still polling");
    }
    expect(h.calls.at(-1).poll).toBe(false);
    expect(h.owner.state().polling).toBe(false);
    release();
  });
  it("hidden tabs release the stream after the grace period and catch up when shown", async () => {
    vi.useFakeTimers();
    const h = harness(() => undefined);
    const release = h.owner.acquire(); await flush();
    h.calls[0].onEvent({ event: "change", data: { seq: 7, path: "a.md" } });
    // A short switch away keeps the connection.
    h.owner.setVisible(false); await h.advance(HIDDEN_GRACE_MS - 1); h.owner.setVisible(true); await flush();
    expect(h.calls).toHaveLength(1); expect(h.calls[0].signal.aborted).toBe(false);
    h.owner.setVisible(false); await h.advance(HIDDEN_GRACE_MS);
    expect(h.calls[0].signal.aborted).toBe(true); expect(h.disposers[0]).toHaveBeenCalledTimes(1);
    expect(h.owner.state()).toMatchObject({ visible: false, connected: false });
    // Nothing reconnects while hidden, whatever the old wire reports.
    h.calls[0].onClose("ended"); await h.advance(10 * MAX_DELAY_MS);
    expect(h.calls).toHaveLength(1);
    // A second owner while hidden does not open a stream either.
    const other = h.owner.acquire(); await flush(); expect(h.calls).toHaveLength(1);
    h.owner.setVisible(true); await flush();
    expect(h.calls).toHaveLength(2); expect(h.calls[1].since).toBe(7);
    other(); release();
  });
  it("the app singleton follows document visibility", async () => {
    vi.useFakeTimers(); const calls = [];
    openVaultChanges.mockImplementation(async options => { calls.push(options); return vi.fn(); });
    let state = "visible";
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    const release = acquireVaultChanges(); await flush();
    try {
      state = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS);
      expect(calls[0].signal.aborted).toBe(true);
      state = "visible"; document.dispatchEvent(new Event("visibilitychange")); await flush();
      expect(calls).toHaveLength(2); expect(calls[1].signal.aborted).toBe(false);
    } finally {
      release(); delete document.visibilityState;
      if (descriptor) Object.defineProperty(Document.prototype, "visibilityState", descriptor);
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  it("poll cursors advance even when hidden paths produce no public entries", async () => {
    vi.useFakeTimers(); let options;
    const owner = createVaultChanges({ open: async value => { options = value; return () => {}; } });
    const release = owner.acquire(); await flush();
    options.onEvent({ event: "cursor", data: { next: 123 } });
    expect(owner.state().seq).toBe(123); release();
  });
  it("metadata revisions are independent, fenced and invalidated on every reconnect including a server reset", async () => {
    vi.useFakeTimers(); const calls = [], publish = vi.fn();
    const owner = createVaultChanges({ publish, open: async value => { calls.push(value); return () => {}; } });
    const release = owner.acquire(); await flush();
    const metadata = (index, revision) => calls[index].onEvent({event: "conflicts", data: {revision}});
    metadata(0, 12); metadata(0, 12); metadata(0, 11);
    expect(publish.mock.calls).toEqual([
      [TOPICS.VAULT_CONFLICTS, {revision: 12}], [TOPICS.VAULT_CONFLICTS, {revision: 11}],
    ]);
    expect(owner.state().seq).toBe(0);
    calls[0].onEvent({event: "change", data: {seq: 2, path: "a.md"}});
    expect(owner.state().seq).toBe(2);
    owner.suspendDocument(); owner.resumeDocument(); await flush();
    metadata(0, 99); metadata(1, 0); metadata(1, 1);
    expect(publish.mock.calls.filter(([topic]) => topic === TOPICS.VAULT_CONFLICTS)).toEqual([
      [TOPICS.VAULT_CONFLICTS, {revision: 12}], [TOPICS.VAULT_CONFLICTS, {revision: 11}],
      [TOPICS.VAULT_CONFLICTS, {revision: 0}], [TOPICS.VAULT_CONFLICTS, {revision: 1}],
    ]);
    expect(owner.state().seq).toBe(2);
    for (const revision of [-1, 1.5, "2", null]) expect(() => metadata(1, revision)).toThrow("Invalid conflict revision");
    release();
  });
  it("deduplicates completed polls but refreshes after failures, stream retries and owner restarts", async () => {
    vi.useFakeTimers(); const calls = [], publish = vi.fn();
    const owner = createVaultChanges({ publish, open: async value => { calls.push(value); return () => {}; } });
    let release = owner.acquire(); await flush();
    const metadata = revision => calls.at(-1).onEvent({ event: "conflicts", data: { revision } });
    const published = () => publish.mock.calls.filter(([topic]) => topic === TOPICS.VAULT_CONFLICTS).map(([, data]) => data.revision);
    metadata(12); calls.at(-1).onClose(new Error("stream broke")); await vi.advanceTimersByTimeAsync(500);
    expect(calls.at(-1).poll).toBe(true); metadata(12);
    for (let i = 0; i < 3; i++) { calls.at(-1).onClose("poll"); await flush(); metadata(12); }
    expect(published()).toEqual([12, 12]);
    metadata(0); metadata(0); expect(published()).toEqual([12, 12, 0]);
    calls.at(-1).onClose(new Error("poll broke")); await vi.advanceTimersByTimeAsync(500); metadata(0);
    expect(published()).toEqual([12, 12, 0, 0]);
    owner.restart(); await flush(); metadata(0);
    release(); release = owner.acquire(); await flush(); metadata(0);
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS); calls.at(-1).onClose("poll"); await flush();
    expect(calls.at(-1).poll).toBe(false); metadata(0);
    expect(published()).toEqual([12, 12, 0, 0, 0, 0, 0]);
    release();
  });
  it("treats a JSON stream response as poll continuation and refreshes after actual page lifetime boundaries", async () => {
    vi.useFakeTimers(); const calls = [], publish = vi.fn();
    const owner = createVaultChanges({ publish, open: async value => { calls.push(value); return () => {}; } });
    const release = owner.acquire(); await flush();
    const metadata = () => calls.at(-1).onEvent({ event: "conflicts", data: { revision: 7 } });
    metadata(); calls.at(-1).onClose("poll"); await flush();
    expect(calls.at(-1).poll).toBe(true); metadata();
    expect(publish).toHaveBeenCalledTimes(1);
    owner.setVisible(false); await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS - 1); owner.setVisible(true); metadata();
    expect(publish).toHaveBeenCalledTimes(1);
    owner.setVisible(false); await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS);
    const retired = calls.at(-1); owner.setVisible(true); await flush(); metadata();
    retired.onEvent({ event: "conflicts", data: { revision: 99 } });
    owner.suspendDocument(); owner.resumeDocument(); await flush(); metadata();
    expect(publish.mock.calls).toEqual(Array.from({ length: 3 }, () => [TOPICS.VAULT_CONFLICTS, { revision: 7 }]));
    release();
  });
  it("driver metadata shares the transport but not file/conflict cursors or reconnect memory", async () => {
    vi.useFakeTimers(); const calls=[], publish=vi.fn();
    const owner=createVaultChanges({publish,open:async value=>{calls.push(value);return ()=>{};}});
    const release=owner.acquire();await flush();
    const event=(name,revision,index=calls.length-1)=>calls[index].onEvent({event:name,data:{revision}});
    event("drivers",7);event("drivers",7);event("conflicts",7);event("drivers",1);
    expect(publish.mock.calls).toEqual([[TOPICS.VAULT_DRIVERS,{revision:7}],[TOPICS.VAULT_CONFLICTS,{revision:7}],[TOPICS.VAULT_DRIVERS,{revision:1}]]);
    expect(owner.state().seq).toBe(0);calls[0].onClose("poll");await flush();event("drivers",1);expect(publish).toHaveBeenCalledTimes(3);
    owner.suspendDocument();owner.resumeDocument();await flush();event("drivers",99,0);event("drivers",1);
    expect(publish).toHaveBeenLastCalledWith(TOPICS.VAULT_DRIVERS,{revision:1});expect(publish).toHaveBeenCalledTimes(4);
    for(const value of [-1,1.5,"2",null])expect(()=>event("drivers",value)).toThrow("Invalid driver revision");release();
  });
});
