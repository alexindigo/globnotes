import { afterEach, describe, expect, it, vi } from "vitest";
import { createConflictResolutionController } from "../conflictResolutionController.js";
import { TOPICS } from "../bus/index.js";
import { reactive } from "vue";
import { registerSessionParticipant, resolveParticipants } from "../sessionActions.js";
vi.mock("../api.js", () => ({ getConflict: vi.fn(), resolveConflict: vi.fn() }));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const member = (path, content = "\uFEFF# original\r\n", version = path) => ({ path, content, version, preview: "text" });
const pair = (id = "a") => ({ id, revision: 2, state: "open", original: member("A.md"), copy: member("A.conflict.md", "copy") });
const receipt = action => ({ id: "a", revision: 3, status: "settled", action, remaining: [{ path: "A.md", version: "saved" }], removed: action === "both" ? [] : ["A.conflict.md"] });
const owners = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function fixture(overrides = {}) {
  const handlers = new Map(), drafts = { load: vi.fn(() => null), save: vi.fn(), clear: vi.fn(), clearAcknowledged: vi.fn(), release: vi.fn() };
  let participant;
  const send = vi.fn(async (_, request) => receipt(request.action)), navigate = vi.fn(), read = vi.fn(async id => pair(id));
  const controller = createConflictResolutionController({ read, send, drafts, navigate, fileHref: path => `/prefix/${path}`,
    subscribe: (topic, fn) => { handlers.set(topic, fn); return () => handlers.delete(topic); },
    registerParticipant: (_, callbacks) => { participant = callbacks; return vi.fn(); }, unload: { set: vi.fn(), dispose: vi.fn() },
    getContext: () => ({ writable: true, scope: "/prefix:globnotes" }), ...overrides });
  owners.push(controller); return { controller, send: overrides.send ?? send, navigate, read, drafts, handlers, participant: () => participant };
}
describe("explicit conflict resolution and retained work", () => {
  it("captures both shown bases/revision, confirms filenames, and sends only one wire", async () => {
    const held = deferred(), f = fixture({ send: vi.fn(() => held.promise) }); await f.controller.mount("a");
    f.controller.choose("copy"); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.state.confirmation.message).toBe("Replace A.md with A.conflict.md, then delete A.conflict.md?");
    const choice = f.controller.state.confirmation.identity;
    f.controller.confirmResolution(choice); f.controller.confirmResolution(choice); await flush(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]).toEqual(["a", { action: "copy", revision: 2, base: { original: { kind: "version", version: "A.md" }, copy: { kind: "version", version: "A.conflict.md" } } }]);
    held.resolve(receipt("copy")); await flush(); expect(f.navigate).toHaveBeenCalledTimes(1);
  });
  it("invalidates an open confirmation before it can send", async () => {
    const f = fixture(); await f.controller.mount("a"); f.controller.choose("original"); const choice = f.controller.state.confirmation.identity;
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "A.md" }); f.controller.confirmResolution(choice);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("a delayed file notification for the already-shown versions does not strand initial actions", async () => {
    const f = fixture(); await f.controller.mount("a"); await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "A.md" });
    expect(f.controller.state.reviewRequired).toBe(false); expect(f.controller.state.canKeep).toBe(true);
  });
  it("merges exact visible text at fixed bases and clears only its acknowledged draft", async () => {
    const f = fixture(); await f.controller.mount("a"); f.controller.editMerge(); expect(f.controller.state.draft).toBe(pair().original.content);
    f.controller.setDraft("\uFEFF# new heading\r\nexact\r\n"); f.controller.choose("merge");
    const choice = f.controller.state.confirmation.identity; await f.controller.confirmResolution(choice); await flush();
    expect(f.send.mock.calls[0][1].content).toBe("\uFEFF# new heading\r\nexact\r\n");
    expect(f.drafts.clearAcknowledged).toHaveBeenCalledWith(1); expect(f.controller.hasUnsavedChanges()).toBe(false);
  });
  it("hides competing choices in merge mode, read-only hides all mutations, binary hides merge", async () => {
    const context = reactive({ writable: true }); const f = fixture({ getContext: () => context }); await f.controller.mount("a");
    f.controller.editMerge(); f.controller.choose("both"); expect(f.send).not.toHaveBeenCalled(); expect(f.controller.state.canKeep).toBe(false);
    context.writable = false; expect(f.controller.state.canResolve).toBe(false); f.controller.choose("merge"); expect(f.send).not.toHaveBeenCalled();
    const b = fixture({ read: async () => ({ ...pair(), copy: { ...member("binary"), preview: "binary", content: undefined } }) }); await b.controller.mount("a");
    expect(b.controller.state.canMerge).toBe(false); expect(b.controller.state.canKeep).toBe(true);
  });
  it("retains stale draft, requires fresh review and a separate new choice", async () => {
    const send = vi.fn().mockRejectedValue({ response: { status: 409, data: { code: "conflict_stale" } } });
    const f = fixture({ send }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("mine"); f.controller.choose("merge");
    await f.controller.confirmResolution(f.controller.state.confirmation.identity); expect(f.controller.state.reviewRequired).toBe(true);
    f.controller.choose("merge"); expect(send).toHaveBeenCalledTimes(1); await f.controller.reviewCurrent();
    expect(f.controller.state.draft).toBe("mine"); expect(f.controller.state.canResolve).toBe(true); expect(send).toHaveBeenCalledTimes(1);
  });
  it("the review flag owns stale presentation, which retires with explicit review", async () => {
    const f = fixture({ send: async () => { throw { response: { status: 409, data: { code: "conflict_stale" } } }; } });
    await f.controller.mount("a"); f.controller.choose("original"); await f.controller.confirmResolution(f.controller.state.confirmation.identity);
    expect(f.controller.state.reviewRequired).toBe(true); expect(f.controller.state.message).toBe("");
    await f.controller.reviewCurrent(); expect(f.controller.state.reviewRequired).toBe(false); expect(f.controller.state.message).toBe("");
    expect(f.controller.state.canKeep).toBe(true);
  });
  it("closed-state presentation retires unknown instructions without acknowledging the local draft", async () => {
    const f = fixture({ send: async () => { throw Error("lost"); } }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("retained"); f.controller.choose("merge");
    await f.controller.confirmResolution(f.controller.state.confirmation.identity); expect(f.controller.state.message).toContain("outcome is unknown");
    f.read.mockResolvedValue({ id: "a", revision: 3, state: "resolved" }); await f.controller.reviewCurrent();
    expect(f.controller.state.resolvedElsewhere).toBe(true); expect(f.controller.state.message).not.toContain("outcome is unknown");
    expect(f.controller.state.message).toContain("retained until you discard"); expect(f.controller.state.draft).toBe("retained");
    expect(f.drafts.clearAcknowledged).not.toHaveBeenCalled();
  });
  it.each(["network", "partial", "bare401", "malformed"])("%s retains unknown authority after an open review and blocks discard/departure/resend", async kind => {
    const send = vi.fn(kind === "malformed" ? async () => ({ status: "settled" }) : async () => { throw kind === "partial" ? { response: { data: { code: "operation_partial" } } } : kind === "bare401" ? { response: { status: 401 } } : Error("network"); });
    const f = fixture({ send }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("retained"); f.controller.choose("merge");
    await f.controller.confirmResolution(f.controller.state.confirmation.identity); await f.controller.reviewCurrent();
    expect(f.controller.state.unknown).toBe(true); expect(await f.controller.settlePending()).toBe(false); expect(f.controller.discard()).toBe(false);
    f.controller.choose("merge"); expect(send).toHaveBeenCalledTimes(1); expect(f.controller.state.draft).toBe("retained");
  });
  it("closed read ends unknown authority but still asks explicit Discard/Cancel for unacknowledged draft", async () => {
    const f = fixture({ send: async () => { throw Error("lost"); } }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("retained"); f.controller.choose("merge");
    await f.controller.confirmResolution(f.controller.state.confirmation.identity);
    f.read.mockResolvedValue({ id: "a", revision: 3, state: "resolved" }); await f.controller.reviewCurrent();
    expect(f.controller.state.status).toBe("resolved"); expect(await f.controller.settlePending()).toBe(true); expect(f.controller.hasUnsavedChanges()).toBe(true);
    const departure = f.controller.gateNavigation(); await flush(); expect(f.controller.state.decision.canSave).toBe(false); f.controller.onDecision("cancel");
    expect(await departure).toBe(false); expect(f.controller.state.draft).toBe("retained"); expect(f.drafts.clear).not.toHaveBeenCalled();
    const next = f.controller.gateNavigation(); await flush(); f.controller.onDecision("discard"); expect(await next).toBe(true); expect(f.drafts.clear).toHaveBeenCalledTimes(1);
  });
  it("observation timeout aborts departure; late success never revives it or logout", async () => {
    vi.useFakeTimers(); const held = deferred(), f = fixture({ send: () => held.promise }); await f.controller.mount("a"); f.controller.choose("both");
    const attempt = f.controller.gateNavigation(); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(await attempt).toBe(false); expect(f.controller.discard()).toBe(false); held.resolve(receipt("both")); await flush();
    expect(f.navigate).not.toHaveBeenCalled(); expect(await f.controller.settlePending()).toBe(true);
    expect(f.controller.state.resolvedElsewhere).toBe(false); expect(f.controller.state.message).toContain("Kept A.md.");
  });
  it("a timed-out still-pending wire may retire only after authoritative closure, retaining explicit draft discard", async () => {
    vi.useFakeTimers(); const held = deferred(), f = fixture({ send: () => held.promise }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("retained"); f.controller.choose("merge");
    f.controller.confirmResolution(f.controller.state.confirmation.identity); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    f.read.mockResolvedValue({ id: "a", revision: 3, state: "resolved" }); await f.controller.reviewCurrent();
    expect(await f.controller.settlePending()).toBe(true); expect(f.controller.hasUnsavedChanges()).toBe(true); expect(f.controller.discard()).toBe(true);
    held.resolve(receipt("merge")); await flush(); expect(f.navigate).not.toHaveBeenCalled(); expect(f.drafts.clearAcknowledged).not.toHaveBeenCalled();
  });
  it("a closure invalidation before its own receipt cannot steal merge acknowledgement", async () => {
    const held = deferred(), f = fixture({ send: () => held.promise }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("mine"); f.controller.choose("merge");
    const completion = f.controller.confirmResolution(f.controller.state.confirmation.identity);
    f.read.mockResolvedValue({ id: "a", revision: 3, state: "resolved" }); await f.handlers.get(TOPICS.VAULT_CONFLICTS)();
    held.resolve(receipt("merge")); expect(await completion).toBe(true); await flush();
    expect(f.drafts.clearAcknowledged).toHaveBeenCalledWith(1); expect(f.controller.hasUnsavedChanges()).toBe(false);
  });
  it("a pre-resolution read cannot reopen an acknowledged record", async () => {
    const old = deferred(), held = deferred(), f = fixture({ send: () => held.promise }); await f.controller.mount("a");
    f.controller.choose("both"); f.read.mockReturnValueOnce(old.promise); f.handlers.get(TOPICS.VAULT_CONFLICTS)(); await flush();
    held.resolve(receipt("both")); await flush(); old.resolve(pair()); await flush();
    expect(f.controller.state.status).toBe("resolved"); expect(f.controller.state.canKeep).toBe(false);
  });
  it("only exact sent middleware authentication rejection retries the same captured request", async () => {
    const auth = deferred(), send = vi.fn().mockRejectedValueOnce({ response: { status: 401, data: { detail: "Invalid authentication credentials" } } }).mockResolvedValue(receipt("merge"));
    const f = fixture({ send, requestAuthentication: () => auth.promise }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("captured"); f.controller.choose("merge");
    const attempt = f.controller.confirmResolution(f.controller.state.confirmation.identity); await flush();
    expect(f.controller.state.message).toContain("Sign in"); expect(f.controller.discard()).toBe(false); auth.resolve(true); await attempt; await flush();
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]); expect(f.controller.hasUnsavedChanges()).toBe(false);
  });
  it("cancelled sign-in retains text and requires review before another explicit choice", async () => {
    const send = vi.fn().mockRejectedValue({ response: { status: 401, data: { detail: "Invalid authentication credentials" } } });
    const f = fixture({ send, requestAuthentication: async () => false }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("retained"); f.controller.choose("merge");
    expect(await f.controller.confirmResolution(f.controller.state.confirmation.identity)).toBe(false); await flush();
    expect(f.controller.state.reviewRequired).toBe(true); expect(f.controller.state.draft).toBe("retained"); expect(f.controller.state.unknown).toBe(false);
    expect(await f.controller.settlePending()).toBe(true); expect(send).toHaveBeenCalledTimes(1);
  });
  it("a read 401 recovers the unsent read without a resolution or draft acknowledgement", async () => {
    const auth = deferred(), read = vi.fn().mockRejectedValueOnce({ response: { status: 401 } }).mockResolvedValue(pair());
    const f = fixture({ read, requestAuthentication: () => auth.promise }); await f.controller.mount("a");
    expect(f.controller.state.status).toBe("error"); expect(f.send).not.toHaveBeenCalled(); auth.resolve(true); await flush();
    expect(f.controller.state.status).toBe("open"); expect(read).toHaveBeenCalledTimes(2); expect(f.drafts.clearAcknowledged).not.toHaveBeenCalled();
  });
  it("waiting for sign-in is known-unsent, and an expired departure never revives after recovery", async () => {
    vi.useFakeTimers(); const auth = deferred(), send = vi.fn().mockRejectedValueOnce({ response: { status: 401, data: { detail: "Invalid authentication credentials" } } }).mockResolvedValue(receipt("both"));
    const f = fixture({ send, requestAuthentication: () => auth.promise }); await f.controller.mount("a"); f.controller.choose("both"); await flush();
    const departure = f.controller.gateNavigation(); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(await departure).toBe(false); expect(f.controller.state.unknown).toBe(false); auth.resolve(true); await flush();
    expect(send).toHaveBeenCalledTimes(2); expect(f.navigate).not.toHaveBeenCalled(); expect(await f.controller.settlePending()).toBe(true);
  });
  it("a browser draft-clear error cannot replay an already acknowledged merge", async () => {
    const f = fixture(); f.drafts.clearAcknowledged.mockImplementation(() => { throw Error("storage blocked"); });
    await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("retained"); f.controller.choose("merge");
    expect(await f.controller.confirmResolution(f.controller.state.confirmation.identity)).toBe(false);
    expect(f.controller.state.status).toBe("resolved"); expect(f.controller.state.unknown).toBe(false); expect(f.controller.state.draft).toBe("retained");
    expect(await f.controller.settlePending()).toBe(true); expect(f.navigate).not.toHaveBeenCalled();
  });
  it("recovered draft needs Resume then a fresh explicit review and owns session decisions", async () => {
    const f = fixture(); f.drafts.load.mockReturnValue({ content: "saved browser draft", revision: 1, base: { original: {}, copy: {} } }); await f.controller.mount("a");
    expect(f.controller.state.recovered).toBe(true); expect(f.controller.state.canResolve).toBe(false); f.controller.resumeDraft();
    expect(f.controller.state.draft).toBe("saved browser draft"); expect(f.controller.state.reviewRequired).toBe(true);
    await f.controller.reviewCurrent(); expect(f.controller.state.canResolve).toBe(true); expect(f.participant().hasUnsavedChanges()).toBe(true);
    const decision = f.participant().requestDecision("logout"); f.controller.onDecision("cancel"); expect(await decision).toBe("cancel");
    const cancel = f.controller.cancelMerge(); await flush(); f.controller.onDecision("cancel"); expect(await cancel).toBe(false); expect(f.controller.state.draft).toBe("saved browser draft");
  });
  it.each(["logout", "access"])("%s uses the real participant coordinator for Cancel, Save and Discard", async reason => {
    const f = fixture({ registerParticipant: registerSessionParticipant }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("mine");
    let attempt = resolveParticipants(reason); await flush(); f.controller.onDecision("cancel"); expect(await attempt).toBe("cancel"); expect(f.controller.state.draft).toBe("mine");
    attempt = resolveParticipants(reason); await flush(); f.controller.onDecision("save"); expect(await attempt).toBe("proceed");
    expect(f.send.mock.calls[0][1].content).toBe("mine"); expect(f.navigate).not.toHaveBeenCalled();
    f.controller.dispose();
    const other = fixture({ registerParticipant: registerSessionParticipant }); await other.controller.mount("b"); other.controller.editMerge(); other.controller.setDraft("discard only local");
    attempt = resolveParticipants(reason); await flush(); other.controller.onDecision("discard"); expect(await attempt).toBe("proceed"); expect(other.send).not.toHaveBeenCalled();
  });
  it("known guard failure aborts the waiting departure, then permits an explicit local discard", async () => {
    const held = deferred(), f = fixture({ send: () => held.promise }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("mine"); f.controller.choose("merge");
    f.controller.confirmResolution(f.controller.state.confirmation.identity); const departure = f.controller.gateNavigation();
    held.reject({ response: { data: { code: "plugin_cancelled", detail: "guard said no" } } }); await flush();
    expect(await departure).toBe(false); expect(f.controller.state.message).toBe("guard said no"); expect(f.controller.state.unknown).toBe(false);
    const next = f.controller.gateNavigation(); await flush(); expect(f.controller.state.decision.canSave).toBe(false); f.controller.onDecision("discard");
    expect(await next).toBe(true); expect(f.drafts.clear).toHaveBeenCalledTimes(1);
  });
  it("file links and dirty selection use the same decision without touching files", async () => {
    const openFile = vi.fn(), event = { preventDefault: vi.fn() }, f = fixture({ openFile }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("mine");
    expect(f.controller.select("b")).toBe(false); expect(f.controller.state.id).toBe("a");
    let link = f.controller.followFile(event, "/file"); await flush(); f.controller.onDecision("cancel"); await link;
    expect(event.preventDefault).toHaveBeenCalledTimes(1); expect(openFile).not.toHaveBeenCalled(); expect(f.controller.state.draft).toBe("mine");
    link = f.controller.followFile(event, "/file"); await flush(); f.controller.onDecision("discard"); await link; expect(openFile).toHaveBeenCalledWith("/file"); expect(f.send).not.toHaveBeenCalled();
  });
  it("unchanged seeded merge can close immediately; dirty Cancel merge cannot discard without explicit choice", async () => {
    const f = fixture(); await f.controller.mount("a"); f.controller.editMerge(); expect(await f.controller.cancelMerge()).toBe(true);
    expect(f.controller.state.decision).toBeNull(); f.controller.editMerge(); f.controller.setDraft("changed");
    const cancel = f.controller.cancelMerge(); await flush(); expect(f.controller.state.decision.canSave).toBe(false);
    f.controller.onDecision("discard"); expect(await cancel).toBe(true); expect(f.controller.state.merge).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });
  it("a late acknowledgement never clears newer text retained after timeout", async () => {
    vi.useFakeTimers(); const held = deferred(), f = fixture({ send: () => held.promise }); await f.controller.mount("a"); f.controller.editMerge(); f.controller.setDraft("A"); f.controller.choose("merge");
    f.controller.confirmResolution(f.controller.state.confirmation.identity); await vi.advanceTimersByTimeAsync(60_000); f.controller.setDraft("B");
    held.resolve(receipt("merge")); await flush(); expect(f.controller.state.draft).toBe("B"); expect(f.drafts.clearAcknowledged).not.toHaveBeenCalled(); expect(f.controller.hasUnsavedChanges()).toBe(true);
  });
});
