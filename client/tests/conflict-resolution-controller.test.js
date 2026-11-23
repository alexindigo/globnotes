import { afterEach, describe, expect, it, vi } from "vitest";
import { createConflictResolutionController } from "../conflictResolutionController.js";
import { TOPICS } from "../bus/index.js";
vi.mock("../api.js", () => ({ getConflict: vi.fn(), resolveConflict: vi.fn() }));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const member = (path, content = "\uFEFF# exact\r\n", version = path) => ({ path, content, version, preview: "text", size: 12, mediaType: "text/markdown" });
const pair = (id = "a") => ({ id, revision: 1, state: "open", original: member("A.md"), copy: member("B.md") });
const owners = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function fixture(overrides = {}) {
  const handlers = new Map(), release = vi.fn(), navigate = vi.fn();
  const read = vi.fn(async id => pair(id));
  const controller = createConflictResolutionController({ read, subscribe: (topic, fn) => { handlers.set(topic, fn); return () => handlers.delete(topic); },
    inbox: { acquire: () => release }, navigate, fileHref: path => `/prefix/${path}`, ...overrides });
  owners.push(controller); return { controller, handlers, read, release, navigate };
}
describe("paired conflict comparison", () => {
  it("accepts both exact texts and versions as one snapshot", async () => {
    const f = fixture(); await f.controller.mount("a");
    expect(f.controller.state.pair).toEqual(pair()); expect(f.controller.state.originalHref).toBe("/prefix/A.md");
    expect(f.controller.state.status).toBe("open"); f.controller.back(); expect(f.navigate).toHaveBeenCalledWith({ name: "conflicts" });
  });
  it("owns read readiness until the invalidated pair and actions settle", async () => {
    const initial = deferred(), reread = deferred();
    const f = fixture({ read: vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(reread.promise) });
    const mounted = f.controller.mount("a");
    expect([f.controller.state.reading, f.controller.state.status]).toEqual([true, "loading"]);
    initial.resolve(pair()); await mounted;
    expect([f.controller.state.reading, f.controller.state.canKeep]).toEqual([false, true]);
    const invalidated = f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "A.md" });
    expect([f.controller.state.reading, f.controller.state.reviewRequired, f.controller.state.canKeep]).toEqual([true, true, false]);
    reread.resolve(pair()); await invalidated;
    expect([f.controller.state.reading, f.controller.state.reviewRequired, f.controller.state.canKeep]).toEqual([false, false, true]);
  });
  it("does not let an old selection clear the current read readiness", async () => {
    const old = deferred(), selected = deferred();
    const f = fixture({ read: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(selected.promise) });
    const mounting = f.controller.mount("a"), selecting = f.controller.select("b");
    old.resolve(pair("a")); await mounting;
    expect([f.controller.state.reading, f.controller.state.id, f.controller.state.pair]).toEqual([true, "b", null]);
    selected.resolve(pair("b")); await selecting;
    expect([f.controller.state.reading, f.controller.state.pair.id]).toEqual([false, "b"]);
    await f.controller.select(null);
    expect([f.controller.state.reading, f.controller.state.status]).toEqual([false, "idle"]);
  });
  it("keeps readiness busy across a coalesced successor and retires failed reads", async () => {
    const initial = deferred(), successor = deferred();
    const read = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(successor.promise).mockRejectedValueOnce(Error("offline"));
    const f = fixture({ read });
    const mounted = f.controller.mount("a");
    const invalidated = f.handlers.get(TOPICS.VAULT_RESET)();
    initial.resolve(pair()); await mounted; await invalidated;
    expect([read.mock.calls, f.controller.state.reading, f.controller.state.pair]).toEqual([[["a"], ["a"]], true, null]);
    successor.resolve(pair()); await successor.promise;
    expect([f.controller.state.reading, f.controller.state.pair.id]).toEqual([false, "a"]);
    await f.controller.refresh();
    expect([f.controller.state.reading, f.controller.state.error]).toEqual([false, "Could not load comparison."]);
  });
  it("URL selection fences old reads, including a Back/Forward visit", async () => {
    const old = deferred(), f = fixture({ read: vi.fn().mockReturnValueOnce(old.promise).mockImplementation(async id => pair(id)) });
    f.controller.mount("a"); await flush(); await f.controller.select("b"); old.resolve(pair("a")); await flush();
    expect(f.controller.state.pair.id).toBe("b"); await f.controller.select("a"); expect(f.controller.state.pair.id).toBe("a");
  });
  it("keeps the compared pair until an explicit fresh review", async () => {
    const fresh = { ...pair(), copy: member("B.md", "new", "v3") };
    const f = fixture({ read: vi.fn().mockResolvedValueOnce(pair()).mockResolvedValue(fresh) }); await f.controller.mount("a");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "B.md" });
    expect(f.controller.state.reviewRequired).toBe(true); expect(f.controller.state.pair.copy.content).toContain("exact");
    await f.controller.reviewCurrent(); expect(f.controller.state.pair.copy.content).toBe("new"); expect(f.controller.state.reviewRequired).toBe(false);
  });
  it("coalesces invalidations during initial read, ignores unrelated paths", async () => {
    const held = deferred(), read = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue(pair());
    const f = fixture({ read }); f.controller.mount("a"); await flush(); f.handlers.get(TOPICS.VAULT_RESET)();
    held.resolve(pair()); await flush(); expect(read).toHaveBeenCalledTimes(2);
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "Unrelated.md" }); expect(read).toHaveBeenCalledTimes(2);
  });
  it("outside closure stays on the selected id and does not navigate", async () => {
    const f = fixture({ read: vi.fn().mockResolvedValueOnce(pair()).mockResolvedValue({ id: "a", revision: 2, state: "resolved" }) });
    await f.controller.mount("a"); await f.handlers.get(TOPICS.VAULT_CONFLICTS)();
    expect(f.controller.state.status).toBe("resolved"); expect(f.controller.state.id).toBe("a"); expect(f.navigate).not.toHaveBeenCalled();
  });
  it("distinguishes missing from failed and retires subscriptions/reads", async () => {
    const read = vi.fn().mockRejectedValueOnce({ response: { status: 404 } }).mockRejectedValueOnce(Error("offline"));
    const f = fixture({ read }); await f.controller.mount("missing"); expect(f.controller.state.status).toBe("missing");
    await f.controller.select("failed"); expect(f.controller.state.status).toBe("error"); expect(f.controller.state.error).toContain("Could not load");
    f.controller.dispose(); expect(f.handlers.size).toBe(0); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("retrying a failed read retains the draft and requires explicit review of changed versions", async () => {
    vi.useFakeTimers(); const send = vi.fn(), drafts = { load: () => null, save: vi.fn(), release: vi.fn() };
    const fresh = { ...pair(), copy: member("B.md", "changed", "new-version") };
    const read = vi.fn().mockResolvedValueOnce(pair()).mockRejectedValueOnce(Error("offline")).mockResolvedValue(fresh);
    const f = fixture({ read, send, drafts }); await f.controller.mount("a");
    f.controller.editMerge(); f.controller.setDraft("retained manual merge"); await f.controller.refresh();
    expect(f.controller.state.error).toBe("Could not load comparison.");
    await vi.advanceTimersByTimeAsync(500);
    expect(f.controller.state.error).toBe(""); expect(f.controller.state.reviewRequired).toBe(true);
    expect(f.controller.state.pair.copy.content).not.toBe("changed"); expect(f.controller.state.draft).toBe("retained manual merge");
    expect(f.controller.state.canSaveMerge).toBe(false); expect(send).not.toHaveBeenCalled();
  });
  it("retires failed-read retries on URL selection and disposal", async () => {
    vi.useFakeTimers(); const read = vi.fn().mockRejectedValueOnce(Error("offline")).mockImplementation(async id => pair(id));
    const f = fixture({ read }); await f.controller.mount("a"); await f.controller.select("b");
    await vi.advanceTimersByTimeAsync(30000); expect(read).toHaveBeenCalledTimes(2); expect(f.controller.state.pair.id).toBe("b");
    read.mockRejectedValueOnce(Error("offline")); await f.controller.refresh(); f.controller.dispose();
    await vi.advanceTimersByTimeAsync(30000); expect(read).toHaveBeenCalledTimes(3);
  });
});
