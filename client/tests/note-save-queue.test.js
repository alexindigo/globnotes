import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoteSaveQueue, classifyNoteSaveFailure } from "../noteSaveQueue.js";
import { flushPromises } from "@vue/test-utils";

const queues = [];
afterEach(() => { queues.splice(0).forEach(queue => queue.dispose()); vi.useRealTimers(); });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const snapshot = (content, pathRevision = 0, requestedPath = "P") => ({ content, requestedPath, pathRevision, contentRevision: 1, intent: "save" });
function fixture(overrides = {}) {
  const sent = [];
  const adapters = { sessionId: "test", initial: { path: "P", content: "old" },
    send: vi.fn((snapshot, context) => { const task = deferred(); sent.push({ snapshot, context, ...task }); return task.promise; }), acknowledge: vi.fn(), ...overrides };
  const queue = createNoteSaveQueue(adapters); queues.push(queue);
  return { queue, sent, adapters };
}
async function ack(request, path = "P") { request.resolve({ path, content: request.snapshot.content }); await flushPromises(); }

describe("per-note save FIFO", () => {
  it("preparation currentness survives a waiter timeout but ends at send, observation timeout, discard or disposal", async () => {
    vi.useFakeTimers();
    const preparation = deferred(); let context;
    const { queue, sent } = fixture({ observationMs: 100, prepare: (_, value) => { context = value; return preparation.promise; } });
    queue.submit(snapshot("A")); expect(Object.isFrozen(context)).toBe(true); expect(context.isPreparationCurrent()).toBe(true);
    const wait = queue.awaitSettled({ deadline: Date.now() + 10 }); await vi.advanceTimersByTimeAsync(10);
    expect(await wait).toMatchObject({ status: "timeout" }); expect(context.isPreparationCurrent()).toBe(true);
    preparation.resolve({ fileRefs: "none" }); await vi.advanceTimersByTimeAsync(0);
    expect(context.isPreparationCurrent()).toBe(false); expect(sent).toHaveLength(1);
    let timedContext;
    const timed = fixture({ observationMs: 10, prepare: (_, value) => { timedContext = value; return new Promise(() => {}); } }).queue;
    timed.submit(snapshot("old")); await vi.advanceTimersByTimeAsync(10);
    expect(timedContext.isPreparationCurrent()).toBe(false); expect(timed.discard()).toBe(true); expect(timedContext.isPreparationCurrent()).toBe(false);
    let disposedContext;
    const disposed = fixture({ prepare: (_, value) => { disposedContext = value; return new Promise(() => {}); } }).queue;
    disposed.submit(snapshot("old")); disposed.dispose(); expect(disposedContext.isPreparationCurrent()).toBe(false);
  });
  it("late preparation rejection after timeout preserves the original single failure", async () => {
    vi.useFakeTimers(); const preparation = deferred();
    const failed = vi.fn();
    const { queue, sent } = fixture({ observationMs: 10, prepare: () => preparation.promise, failed });
    queue.submit(snapshot("A")); await vi.advanceTimersByTimeAsync(10);
    const failure = queue.state().failure;
    preparation.reject(new Error("obsolete preview rejection")); await vi.advanceTimersByTimeAsync(0);
    expect(queue.state().failure).toEqual(failure); expect(failed).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(0);
  });
  it("captures A/B/C once and sends each in admission order", async () => {
    const { queue, sent } = fixture();
    const input = snapshot("A"); queue.submit(input); queue.submit(snapshot("B")); queue.submit(snapshot("C")); input.content = "mutated";
    await flushPromises(); expect(sent.map(job => job.snapshot.content)).toEqual(["A"]);
    await ack(sent[0]); expect(sent.map(job => job.snapshot.content)).toEqual(["A", "B"]);
    await ack(sent[1]); expect(sent.map(job => job.snapshot.content)).toEqual(["A", "B", "C"]);
    await ack(sent[2]); expect(await queue.awaitSettled()).toMatchObject({ status: "settled", safe: true });
  });
  it("equal bytes are separate receipts and requests", async () => {
    const { queue, sent } = fixture();
    const a = queue.submit(snapshot("equal")), b = queue.submit(snapshot("equal"));
    expect(a.submissionId).not.toBe(b.submissionId);
    await flushPromises(); await ack(sent[0]); await ack(sent[1]);
    expect(await a.completion).toMatchObject({ status: "acknowledged" });
    expect(await b.completion).toMatchObject({ status: "acknowledged" });
  });
  it("pauses known failure, retains B/C, and admits new D as held", async () => {
    const { queue, sent } = fixture();
    queue.submit(snapshot("A")); queue.submit(snapshot("B")); queue.submit(snapshot("C")); await flushPromises();
    sent[0].reject({ response: { status: 409, data: { code: "plugin_cancelled" } } }); await flushPromises();
    expect(queue.submit(snapshot("D")).held).toBe(true);
    expect(sent).toHaveLength(1); expect(queue.state().queued.map(job => job.snapshot.content)).toEqual(["B", "C", "D"]);
    expect(await queue.awaitSettled()).toMatchObject({ status: "paused", certainty: "known-no-write", canDiscard: true });
    expect(queue.discard()).toBe(true); expect(queue.state().status).toBe("idle");
  });
  it("observation timeout never releases A's wire slot or sends B", async () => {
    vi.useFakeTimers();
    const { queue, sent } = fixture({ observationMs: 20 });
    const a = queue.submit(snapshot("A")); queue.submit(snapshot("B")); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(await a.completion).toMatchObject({ certainty: "unknown" });
    expect(queue.state()).toMatchObject({ status: "paused", inFlight: true, canDiscard: false });
    expect(queue.discard()).toBe(false);
    sent[0].resolve({ path: "Q", content: "A" }); await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1); expect(queue.state().acknowledged.path).toBe("Q");
    expect(queue.state()).toMatchObject({ status: "paused", canDiscard: true });
  });
  it("handoff timeout aborts only the waiter, not the healthy pipeline", async () => {
    vi.useFakeTimers();
    const { queue, sent } = fixture(); queue.submit(snapshot("A")); await vi.advanceTimersByTimeAsync(0);
    const wait = queue.awaitSettled({ deadline: Date.now() + 10 }); await vi.advanceTimersByTimeAsync(10);
    expect(await wait).toMatchObject({ status: "timeout" }); expect(queue.state().status).toBe("sending");
    sent[0].resolve({ path: "P", content: "A" }); await vi.advanceTimersByTimeAsync(0); expect(queue.state().status).toBe("idle");
  });
  it("advances canonical identity while preserving explicit newer path intent", async () => {
    const { queue, sent } = fixture();
    queue.submit(snapshot("A", 1, "Q")); queue.submit(snapshot("B", 1, "Q")); queue.submit(snapshot("C", 2, "P"));
    await flushPromises(); await ack(sent[0], "Canonical-Q");
    expect(sent[1].context).toMatchObject({ sourcePath: "Canonical-Q", targetPath: "Canonical-Q" });
    await ack(sent[1], "Canonical-Q"); expect(sent[2].context).toMatchObject({ sourcePath: "Canonical-Q", targetPath: "P" });
  });
  it("new note has no source until A's valid acknowledgement", async () => {
    const { queue, sent } = fixture({ initial: null }); queue.submit(snapshot("A")); queue.submit(snapshot("B")); await flushPromises();
    expect(sent[0].context.sourcePath).toBeNull(); await ack(sent[0], "Created"); expect(sent[1].context.sourcePath).toBe("Created");
  });
  it("preparation cancel is known-unsent and never skips A", async () => {
    const preparation = deferred();
    const { queue, sent } = fixture({ prepare: () => preparation.promise }); queue.submit(snapshot("A")); queue.submit(snapshot("B"));
    preparation.reject(Object.assign(new Error("cancelled"), { cancelled: true })); await flushPromises();
    expect(sent).toHaveLength(0); expect(queue.state().failure.certainty).toBe("cancelled-unsent");
  });
  it("malformed success is unknown; a bare 409 does not prove no write", async () => {
    const { queue, sent } = fixture(); queue.submit(snapshot("A")); await flushPromises(); sent[0].resolve({ path: "P" }); await flushPromises();
    expect(queue.state().failure.certainty).toBe("unknown"); expect(queue.discard()).toBe(false);
    expect(classifyNoteSaveFailure({ response: { status: 409 } }, "sending")).toBe("unknown");
  });
  it.each(["plugin_cancelled", "plugin_guard_failed", "operation_conflict"])("recognizes inspected pre-commit rejection %s", code => {
    expect(classifyNoteSaveFailure({ response: { data: { code } } }, "sending")).toBe("known-no-write");
  });
  it("records committed identity before an acknowledgement integration failure", async () => {
    const { queue, sent } = fixture({ acknowledge: () => { throw new Error("route failure"); } });
    queue.submit(snapshot("A")); queue.submit(snapshot("B")); await flushPromises(); await ack(sent[0], "Q");
    expect(queue.state().acknowledged.path).toBe("Q"); expect(queue.state().failure.certainty).toBe("known-committed"); expect(sent).toHaveLength(1);
  });
  it("disposal cancels waiters and revokes late callbacks without dispatching held work", async () => {
    const { queue, sent, adapters } = fixture(); queue.submit(snapshot("A")); queue.submit(snapshot("B")); await flushPromises();
    const wait = queue.awaitSettled(); queue.dispose(); expect(await wait).toMatchObject({ status: "disposed" });
    await ack(sent[0]); expect(adapters.acknowledge).not.toHaveBeenCalled(); expect(sent).toHaveLength(1);
    expect(queue.state().queued).toHaveLength(1); // disposal is not discard
  });

  it("explicit known-unsent discard revokes a late preparation without stranding new work", async () => {
    vi.useFakeTimers();
    const oldPreparation = deferred();
    const { queue, sent } = fixture({ observationMs: 10, prepare: job => job.content === "A" ? oldPreparation.promise : { fileRefs: "none" } });
    queue.submit(snapshot("A")); await vi.advanceTimersByTimeAsync(10);
    expect(queue.discard()).toBe(true);
    queue.submit(snapshot("new")); await vi.advanceTimersByTimeAsync(0);
    expect(sent.map(job => job.snapshot.content)).toEqual(["new"]);
    oldPreparation.resolve({ fileRefs: "move" }); await vi.advanceTimersByTimeAsync(0);
    queue.submit(snapshot("later")); await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1); // late old preparation cannot release new's slot
  });

  it.each([400, 409, 500, 503])("keeps an unproven HTTP %s response uncertain", status => {
    expect(classifyNoteSaveFailure({ response: { status, data: { detail: "storage error" } } }, "sending")).toBe("unknown");
  });

  it("a committed late reply can resolve only matching work and never execute a stale drain intent", async () => {
    vi.useFakeTimers();
    const drained = vi.fn();
    const { queue, sent } = fixture({ observationMs: 10, drained, canResolveLate: () => true });
    queue.submit(snapshot("A")); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(10);
    sent[0].resolve({ path: "P", content: "A" }); await vi.advanceTimersByTimeAsync(0);
    expect(queue.state().status).toBe("idle"); expect(drained).not.toHaveBeenCalled();
  });
});
