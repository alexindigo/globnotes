import { afterEach, describe, expect, it, vi } from "vitest";
import { isReadonly, nextTick, reactive } from "vue";
import { createConflictInbox } from "../conflictInbox.js";
import { TOPICS } from "../bus/index.js";
vi.mock("../api.js", () => ({ getConflicts: vi.fn() }));
vi.mock("../vaultChanges.js", () => ({ acquireVaultChanges: vi.fn() }));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const row = (id = "a", extra = {}) => ({ id, path: "Original.md", copyPath: "Copy.md", reason: "overlapping-edits", createdAt: "2026-11-01T12:00:00Z", revision: 1, ...extra });
const response = (...conflicts) => ({ revision: 1, total: conflicts.length, conflicts });
const owners = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function fixture(read = vi.fn(async () => response())) {
  const handlers = new Map(), release = vi.fn();
  const acquireChanges = vi.fn(() => { expect(handlers.size).toBe(3); return release; });
  const inbox = createConflictInbox({ read, acquireChanges, subscribe: (topic, fn) => { handlers.set(topic, fn); return () => handlers.delete(topic); } });
  owners.push(inbox); inbox.setContext({ active: true, key: "vault/account" });
  return { inbox, read, handlers, acquireChanges, release };
}
describe("shared conflict metadata owner", () => {
  it("does no import/context fetch, subscribes before reading and reference-counts a single connection", async () => {
    const f = fixture(); expect(f.read).not.toHaveBeenCalled();
    const a = f.inbox.acquire(), b = f.inbox.acquire();
    expect(f.inbox.state.total).toBe(null); expect(f.inbox.state.loading).toBe(true);
    await flush(); expect(f.inbox.state.total).toBe(0); expect(isReadonly(f.inbox.state)).toBe(true);
    expect(f.acquireChanges).toHaveBeenCalledTimes(1); a(); a(); expect(f.release).not.toHaveBeenCalled();
    b(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.handlers.size).toBe(0);
  });
  it("sorts oldest-first, labels known reasons and resolves member targets from metadata only", async () => {
    const f = fixture(vi.fn(async () => response(row("z"), row("b", { reason: "stale-base" }), row("old", { createdAt: "2026-10-01T00:00:00Z" }))));
    f.inbox.acquire(); await flush();
    expect(f.inbox.state.rows.map(row => row.id)).toEqual(["old", "b", "z"]);
    expect(f.inbox.state.rows[1].reasonLabel).toBe("Changed since the writer read it");
    expect(f.inbox.state.rows[2].reasonLabel).toBe("Overlapping edits");
    expect(f.inbox.lookupByMember("Copy.md", "copyPath").target).toEqual({ name: "conflict", params: { id: "old" } });
  });
  it("retains the accepted count on error and never renders a failed initial read as empty", async () => {
    const f = fixture(vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce(response(row())).mockRejectedValueOnce(Error("offline")));
    f.inbox.acquire(); await flush(); expect(f.inbox.state.total).toBe(null); expect(f.inbox.state.error).toBe("Could not load conflicts.");
    await f.inbox.refresh(); expect(f.inbox.state.total).toBe(1);
    await f.inbox.refresh(); expect(f.inbox.state.total).toBe(1); expect(f.inbox.state.rows).toHaveLength(1); expect(f.inbox.state.stale).toBe(true);
  });
  it.each([TOPICS.VAULT_CHANGE, TOPICS.VAULT_RESET, TOPICS.VAULT_CONFLICTS])("coalesces %s while reading and refuses the superseded snapshot", async topic => {
    const old = deferred(), follow = deferred(), f = fixture(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(follow.promise));
    f.inbox.acquire(); await flush();
    f.handlers.get(topic)({}); f.handlers.get(topic)({});
    old.resolve(response()); await flush();
    expect(f.inbox.state.total).toBe(null); expect(f.read).toHaveBeenCalledTimes(2);
    follow.resolve(response(row())); await flush(); expect(f.inbox.state.total).toBe(1);
  });
  it("file-before-record then metadata refresh observes the newly created record", async () => {
    const f = fixture(vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response()).mockResolvedValueOnce(response(row())));
    f.inbox.acquire(); await flush(); await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "Copy.md" });
    expect(f.inbox.state.total).toBe(0); await f.handlers.get(TOPICS.VAULT_CONFLICTS)({ revision: 2 });
    expect(f.inbox.state.total).toBe(1);
  });
  it("identity/disposal fences old reads and clears names synchronously", async () => {
    const old = deferred(), f = fixture(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(row("new"))));
    f.inbox.acquire(); await flush(); f.inbox.setContext({ active: true, key: "vault/new-account" }); await flush();
    old.resolve(response(row("old"))); await flush(); expect(f.inbox.state.rows.map(row => row.id)).toEqual(["new"]);
    f.inbox.dispose(); expect(f.inbox.state.rows).toEqual([]); expect(f.inbox.state.available).toBe(false);
  });
  it("config readiness, login/setup and credentials gate App's lifetime", async () => {
    const context = reactive({ ready: false, route: "note", config: { authType: "password" }, token: null });
    const read = vi.fn(async () => response(row()));
    const inbox = createConflictInbox({ read, token: () => context.token, subscribe: () => () => {}, acquireChanges: () => () => {} }); owners.push(inbox);
    inbox.bindContext({ config: () => context.config, configReady: () => context.ready, routeName: () => context.route });
    context.ready = true; await nextTick(); expect(read).not.toHaveBeenCalled();
    context.token = "credential"; await flush(); expect(read).toHaveBeenCalledTimes(1); expect(inbox.state.total).toBe(1);
    context.route = "login"; expect(inbox.state.rows).toEqual([]); expect(inbox.state.available).toBe(false);
    context.route = "conflicts"; await flush(); expect(read).toHaveBeenCalledTimes(2);
    context.config.setupRequired = true; expect(inbox.state.available).toBe(false);
  });
  it("retires failed-read retries with their account and final owner", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue(response(row("new"))));
    const release = f.inbox.acquire(); await flush(); expect(f.inbox.state.error).toContain("Could not load");
    f.inbox.setContext({ active: true, key: "new-account" }); await flush();
    await vi.advanceTimersByTimeAsync(30000); expect(f.read).toHaveBeenCalledTimes(2); expect(f.inbox.state.rows[0].id).toBe("new");
    f.read.mockRejectedValueOnce(Error("offline")); await f.inbox.refresh(); release();
    await vi.advanceTimersByTimeAsync(30000); expect(f.read).toHaveBeenCalledTimes(3); expect(f.inbox.state.total).toBe(null);
  });
});
