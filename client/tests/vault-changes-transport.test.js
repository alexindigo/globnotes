import { afterEach, expect, it, vi } from "vitest";
vi.mock("../router.js", () => ({ default: {} }));
vi.mock("../tokenStorage.js", () => ({ getStoredToken: () => "fixture-token" }));
import { openVaultChanges } from "../api.js";

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
