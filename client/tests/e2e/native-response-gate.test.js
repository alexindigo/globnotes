import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNoteResponseGate } from "./native-response-gate.mjs";
let gate;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await gate?.close(); gate = null; expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const request = { method: "PATCH", url: "http://globnotes.test/_/api/notes/NoteA", postData: '{"newContent":"A"}' };
async function fixture(options) {
  const listeners = new Set();
  const send = vi.fn(async method => method === "Fetch.getResponseBody" ? { body: '{"content":"A"}', base64Encoded: false } : {});
  const session = { send, page: { onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); } } };
  gate = await createNoteResponseGate(session, options);
  const emit = (method, params) => { for (const listener of listeners) listener({ method, params }); };
  const start = () => emit("Network.requestWillBeSent", { requestId: "wire-A", request });
  const response = () => emit("Fetch.requestPaused", { requestId: "response-A", networkId: "wire-A", request, responseStatusCode: 200 });
  return { send, emit, start, response, listeners };
}
it("does not impose another RPC clock while a real backend operation is pending", async () => {
  const f = await fixture(); f.start();
  await vi.advanceTimersByTimeAsync(10000);
  expect(gate.records).toHaveLength(1); expect(gate.responses).toHaveLength(0);
  expect(gate.error).toBeUndefined(); expect(gate.records[0].backendStatus).toBeUndefined();
  expect(f.send.mock.calls.map(row => row[0])).toEqual(["Fetch.enable"]);
  f.response(); await flush();
  expect(gate.responses).toHaveLength(1); expect(gate.responses[0]).toMatchObject({ body: { newContent: "A" }, backendStatus: 200, backendResult: { content: "A" } });
  await gate.responses[0].release(); await gate.responses[0].release();
  expect(f.send.mock.calls.filter(row => row[0] === "Fetch.continueRequest")).toHaveLength(1);
  f.emit("Network.loadingFinished", { requestId: "wire-A" }); expect(gate.maxActive()).toBe(1);
});
it("preserves the real backend result when deliberately losing an acknowledgement", async () => {
  const f = await fixture(); f.start(); f.response(); await flush();
  gate.records[0].fault = true; await gate.records[0].release();
  expect(f.send).toHaveBeenCalledWith("Fetch.fulfillRequest", expect.objectContaining({ responseCode: 502 }));
  expect(gate.records[0].backendStatus).toBe(200); expect(gate.records[0].backendResult).toEqual({ content: "A" });
});
it("measures overlap at response release, not delayed protocol reply delivery", async () => {
  const f = await fixture(); f.start(); f.response(); await flush();
  f.send.mockImplementation(async method => {
    if (method === "Fetch.continueRequest") f.emit("Network.requestWillBeSent", { requestId: "wire-B", request: { ...request, postData: '{"newContent":"B"}' } });
    return {};
  });
  await gate.records[0].release();
  expect(gate.records.map(row => row.body.newContent)).toEqual(["A", "B"]);
  expect(gate.maxActive()).toBe(1);
  f.emit("Network.requestWillBeSent", { requestId: "wire-C", request });
  expect(gate.maxActive()).toBe(2); // Genuine dispatch before B's release is retained.
});
it("keeps the original thirty-second response-hold bound", async () => {
  const f = await fixture(); f.start(); f.response(); await flush();
  await vi.advanceTimersByTimeAsync(29999);
  expect(f.send.mock.calls.some(row => row[0] === "Fetch.fulfillRequest")).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await flush();
  expect(gate.records[0].error).toBe("Owned response gate deadline");
  expect(f.send).toHaveBeenCalledWith("Fetch.fulfillRequest", expect.objectContaining({ responseCode: 502 }));
});
it("retains owned transport errors and aborts held responses at disposal, never acknowledges them", async () => {
  const f = await fixture(); f.start();
  f.emit("Fetch.requestPaused", { requestId: "response-A", networkId: "wire-A", request, responseErrorReason: "ConnectionClosed" }); await flush();
  expect(String(gate.error)).toContain("ConnectionClosed"); expect(gate.responses).toHaveLength(0);
  await gate.close(); expect(f.listeners.size).toBe(0);
  expect(f.send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: "response-A", errorReason: "Aborted" });
  expect(f.send.mock.calls.some(row => row[0] === "Fetch.continueRequest")).toBe(false);
});
