import { afterEach, expect, it, vi } from "vitest";
vi.mock("../router.js", () => ({ default: {} }));
vi.mock("../tokenStorage.js", () => ({ getStoredToken: () => "fixture-token" }));
import { openVaultChanges } from "../api.js";
import { createVaultChanges } from "../vaultChanges.js";
import { createConflictInbox } from "../conflictInbox.js";
import { createConflictResolutionController } from "../conflictResolutionController.js";
import { createConnectionLifetime } from "../connectionLifetime.js";
import { publish, subscribe } from "../bus/index.js";
import { CHANGE_STREAM_HEARTBEAT_MS, CHANGE_STREAM_STALL_MS } from "../../shared/vault_changes.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("stream transport carries bearer authority and parses split UTF-8 change/reset frames", async () => {
  let stream;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } })));
  const onEvent = vi.fn(), onClose = vi.fn();
  const close = await openVaultChanges({ since: 7, onEvent, onClose });
  expect(fetch.mock.calls[0][0]).toContain("/changes?since=7");
  expect(fetch.mock.calls[0][1].headers).toEqual({ accept: "text/event-stream", authorization: "Bearer fixture-token" });
  const bytes = new TextEncoder().encode('id: 8\nevent: change\ndata: {"seq":8,"path":"é.md"}\n\nevent: reset\ndata: {"next":9}\n\n');
  const split = bytes.indexOf(0xc3) + 1;
  stream.enqueue(bytes.slice(0, split)); stream.enqueue(bytes.slice(split));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(onEvent.mock.calls.map(([value]) => value)).toEqual([
    { event: "change", data: { seq: 8, path: "é.md" } }, { event: "reset", data: { next: 9 } },
  ]);
  close(); await Promise.resolve(); expect(onClose).not.toHaveBeenCalled();
});
it("polling delivers gap/cursor and disposal retires its completion timer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ gap: true, next: 30 })));
  const onEvent = vi.fn(), onClose = vi.fn();
  const close = await openVaultChanges({ since: 1, poll: true, onEvent, onClose });
  expect(fetch.mock.calls[0][0]).toContain("since=1&poll=1");
  expect(onEvent.mock.calls.map(([value]) => value)).toEqual([
    { event: "reset", data: { next: 30 } }, { event: "cursor", data: { next: 30 } },
  ]);
  close(); await vi.advanceTimersByTimeAsync(2000); expect(onClose).not.toHaveBeenCalled();
});
it("unauthorized transport rejects without publishing a change", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
  const onEvent = vi.fn();
  await expect(openVaultChanges({ onEvent })).rejects.toMatchObject({ status: 401 });
  expect(onEvent).not.toHaveBeenCalled();
});

// PR #30 round 2: a request that stalls silently (half-open TCP, a buffering
// proxy) must fail within CHANGE_STREAM_STALL_MS so the owner reconnects.
const sse = () => {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }),
    { headers: { "content-type": "text/event-stream" } });
  return { response, push: text => controller.enqueue(new TextEncoder().encode(text)) };
};
const hanging = () => vi.fn((url, init) => new Promise((_, reject) => {
  init.signal.addEventListener("abort", () => reject(init.signal.reason));
}));
it("the stall bound is a bounded multiple of the server heartbeat", () => {
  expect(CHANGE_STREAM_STALL_MS).toBe(3 * CHANGE_STREAM_HEARTBEAT_MS);
});
it("heartbeats keep a quiet stream alive; silence past the bound closes it as a failure", async () => {
  vi.useFakeTimers();
  const wire = sse();
  vi.stubGlobal("fetch", vi.fn(async () => wire.response));
  const onClose = vi.fn();
  const close = await openVaultChanges({ onEvent: vi.fn(), onClose });
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(CHANGE_STREAM_HEARTBEAT_MS);
    wire.push(": heartbeat\n\n");
  }
  expect(onClose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(CHANGE_STREAM_STALL_MS - 1);
  expect(onClose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose.mock.calls[0][0]).toMatchObject({ stalled: true });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  close();
});
it("a request that never answers (stream or poll) rejects after the bound", async () => {
  vi.useFakeTimers();
  for (const poll of [false, true]) {
    vi.stubGlobal("fetch", hanging());
    const opened = openVaultChanges({ poll, onEvent: vi.fn(), onClose: vi.fn() });
    const outcome = expect(opened).rejects.toMatchObject({ stalled: true });
    await vi.advanceTimersByTimeAsync(CHANGE_STREAM_STALL_MS);
    await outcome;
  }
});
it("a stream abandoned by its owner reports nothing and leaves no watchdog", async () => {
  vi.useFakeTimers();
  const wire = sse(), owner = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async () => wire.response));
  const onClose = vi.fn();
  const close = await openVaultChanges({ onEvent: vi.fn(), onClose, signal: owner.signal });
  owner.abort(); close();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2 * CHANGE_STREAM_STALL_MS);
  expect(onClose).not.toHaveBeenCalled();
});
it("the owner reconnects a stalled stream through its backoff, falling back to polling", async () => {
  vi.useFakeTimers();
  const wire = sse();
  vi.stubGlobal("fetch", vi.fn(async url => url.includes("poll=1")
    ? Response.json({ entries: [], next: 0 }) : wire.response));
  const owner = createVaultChanges();
  const release = owner.acquire();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(CHANGE_STREAM_STALL_MS);
  expect(owner.state().polling).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toContain("poll=1");
  release();
});

// PR #30 round 3: poll bodies are read chunk by chunk through the same rule,
// so a large poll on a slow link keeps the watchdog alive while it progresses.
const slowJson = (value, parts, gapMs) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)), size = Math.ceil(bytes.length / parts);
  let controller, sent = 0;
  const pushNext = () => {
    controller.enqueue(bytes.slice(sent * size, (sent + 1) * size));
    if (++sent < parts) setTimeout(pushNext, gapMs); else controller.close();
  };
  return new Response(new ReadableStream({ start(value) { controller = value; setTimeout(pushNext, gapMs); } }),
    { headers: { "content-type": "application/json" } });
};
it("a slow multi-chunk poll that takes longer than the stall limit succeeds", async () => {
  vi.useFakeTimers();
  const entries = Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, path: `n${i}.md`, kind: "modified" }));
  const gap = CHANGE_STREAM_HEARTBEAT_MS + 5_000, parts = 6;
  expect(gap * parts).toBeGreaterThan(CHANGE_STREAM_STALL_MS);
  vi.stubGlobal("fetch", vi.fn(async () => slowJson({ entries, next: 2000 }, parts, gap)));
  const onEvent = vi.fn();
  const opened = openVaultChanges({ poll: true, onEvent, onClose: vi.fn() });
  let settled = false; opened.finally(() => { settled = true; }).catch(() => {});
  await vi.advanceTimersByTimeAsync(gap * parts);
  expect(settled).toBe(true);
  const close = await opened;
  expect(onEvent).toHaveBeenCalledTimes(entries.length + 1);
  expect(onEvent).toHaveBeenLastCalledWith({ event: "cursor", data: { next: 2000 } });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
  close();
});
it("a poll body that stops arriving stalls after the limit", async () => {
  vi.useFakeTimers();
  let controller;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(value) {
    controller = value; value.enqueue(new TextEncoder().encode('{"entries":[')); } }),
  { headers: { "content-type": "application/json" } })));
  const opened = openVaultChanges({ poll: true, onEvent: vi.fn(), onClose: vi.fn() });
  const outcome = expect(opened).rejects.toMatchObject({ stalled: true });
  await vi.advanceTimersByTimeAsync(CHANGE_STREAM_STALL_MS);
  await outcome;
  expect(controller).toBeDefined();
});
it("without a body reader a poll falls back to the whole-body read", async () => {
  const json = vi.fn(async () => ({ entries: [{ seq: 4, path: "a.md" }], next: 4 }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), body: null, json })));
  const onEvent = vi.fn();
  const close = await openVaultChanges({ poll: true, onEvent, onClose: vi.fn() });
  expect(json).toHaveBeenCalledTimes(1);
  expect(onEvent.mock.calls.map(([value]) => value)).toEqual([
    { event: "change", data: { seq: 4, path: "a.md" } }, { event: "cursor", data: { next: 4 } },
  ]);
  close();
});
it("poll metadata-only and gap packets use the same independent event as SSE", async () => {
  for (const gap of [false, true]) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({entries: [], next: 7, conflictRevision: 9, ...(gap ? {gap: true} : {})})));
    const onEvent = vi.fn();
    const close = await openVaultChanges({since: 7, poll: true, onEvent});
    expect(onEvent).toHaveBeenLastCalledWith({event: "conflicts", data: {revision: 9}});
    expect(onEvent.mock.calls.map(([value]) => value.event)).toEqual(gap ? ["reset", "cursor", "conflicts"] : ["cursor", "conflicts"]);
    close();
  }
});

it("unchanged real poll packets leave healthy consumers quiet while failed list/detail reads retry", async () => {
  vi.useFakeTimers();
  const snapshot = { revision: 7, total: 1, conflicts: [{ id: "a", path: "A.md", copyPath: "B.md", reason: "overlapping-edits", createdAt: "2026-11-01T12:00:00Z" }] };
  const pair = { id: "a", revision: 1, state: "open", original: { path: "A.md", version: "a", preview: "text", content: "original" }, copy: { path: "B.md", version: "b", preview: "text", content: "copy" } };
  vi.stubGlobal("fetch", vi.fn(async url => {
    if (!url.includes("poll=1")) throw new TypeError("SSE unavailable");
    return Response.json({ entries: [], next: 0, conflictRevision: 7 });
  }));
  const lifetime = createConnectionLifetime();
  const changes = createVaultChanges({ publish, lifetime });
  const listRead = vi.fn(async () => snapshot), detailRead = vi.fn(async () => pair);
  const inbox = createConflictInbox({ read: listRead, subscribe, acquireChanges: () => changes.acquire(), lifetime });
  inbox.setContext({ active: true, key: "poll-fixture" });
  const release = inbox.acquire();
  const controller = createConflictResolutionController({ read: detailRead, inbox, subscribe, lifetime,
    drafts: { load: () => null, release: () => {} }, registerParticipant: () => () => {}, unload: { set() {}, dispose() {} } });
  try {
    await controller.mount("a"); await vi.advanceTimersByTimeAsync(500);
    const healthy = { list: listRead.mock.calls.length, detail: detailRead.mock.calls.length };
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch.mock.calls.filter(([url]) => url.includes("poll=1")).length).toBeGreaterThanOrEqual(4);
    expect({ list: listRead.mock.calls.length, detail: detailRead.mock.calls.length }).toEqual(healthy);
    listRead.mockRejectedValueOnce(Error("temporary list failure"));
    detailRead.mockRejectedValueOnce(Error("temporary comparison failure"));
    await inbox.refresh(); await controller.refresh();
    expect(inbox.state.error).toBe("Could not load conflicts."); expect(controller.state.error).toBe("Could not load comparison.");
    changes.suspendDocument(); await vi.advanceTimersByTimeAsync(4000);
    expect(listRead).toHaveBeenCalledTimes(healthy.list + 1); expect(detailRead).toHaveBeenCalledTimes(healthy.detail + 1);
    changes.resumeDocument(); await vi.advanceTimersByTimeAsync(4000);
    expect(inbox.state.error).toBe(""); expect(controller.state.error).toBe("");
    expect(inbox.state.total).toBe(1); expect(controller.state.pair.original.content).toBe("original");
    const recovered = { list: listRead.mock.calls.length, detail: detailRead.mock.calls.length };
    await vi.advanceTimersByTimeAsync(4000);
    expect({ list: listRead.mock.calls.length, detail: detailRead.mock.calls.length }).toEqual(recovered);
    listRead.mockRejectedValueOnce(Error("retry without revision change")); detailRead.mockRejectedValueOnce(Error("retry without revision change"));
    await inbox.refresh(); await controller.refresh(); await vi.advanceTimersByTimeAsync(1000);
    expect(inbox.state.error).toBe(""); expect(controller.state.error).toBe("");
  } finally { controller.dispose(); release(); inbox.dispose(); }
});
