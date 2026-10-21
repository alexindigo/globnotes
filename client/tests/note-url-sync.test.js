import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoteUrlSync } from "../noteUrlSync.js";
import { decideNavigation } from "../noteNavigationGate.js";

function fixture(overrides = {}) {
  const location = { pathname: "/notes/Folder/My%20note", search: "?x=one&x=two", hash: "" };
  const current = { editMode: true, editorMode: "markdown", editorLine: { from: 2, to: 4 }, viewLine: null, isNewNote: false };
  const router = {
    options: { history: { base: "/notes" } },
    currentRoute: { value: { fullPath: "/Old#source" } },
    push: vi.fn(),
    replace: vi.fn(async fullPath => { router.currentRoute.value = { fullPath }; }),
  };
  let path = "Old";
  const sync = createNoteUrlSync({ router, ownerId: "owner", getLocation: () => location, getState: () => current, getPath: () => path, ...overrides });
  return { sync, router, location, current, setPath: value => { path = value; } };
}
const snapshot = { sessionId: "session", submissionId: 3 };
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); });

describe("state-to-URL writes", () => {
  it.each([false, true])("acknowledges only the caused navigation (push=%s), not subsequent history", async push => {
    const { sync, router } = fixture();
    const state = () => ({ ...sync.state(), ownerId: "owner", editMode: true,
      resourceIdentity: JSON.stringify(["note", "Folder/My note"]), editorMode: "markdown" });
    const to = { name: "note", params: { path: "Folder/My note" }, query: {},
      hash: "#source:L2-4", fullPath: "/Folder/My%20note?x=one&x=two#source:L2-4" };
    const external = { type: "sync-editor", mode: "markdown", line: { from: 2, to: 4 } };
    router[push ? "push" : "replace"].mockImplementationOnce(async fullPath => {
      expect(fullPath).toBe(to.fullPath);
      expect(decideNavigation(state(), to)).toEqual({ type: "acknowledge" });
      sync.consumeAcknowledgementGuard();
      // Even while the router's promise is pending, authority is single-use.
      expect(decideNavigation(state(), to)).toEqual(external);
      expect(sync.consumeAcknowledgedResource("Folder/My note", undefined)).toBe(false);
      router.currentRoute.value.fullPath = fullPath;
    });
    await sync.writeCurrentFragment(push);
    expect(sync.state().acknowledgementTransition).toBeNull();
    expect(decideNavigation(state(), to)).toEqual(external);
  });

  it.each(["rejected", "aborted", "duplicated"])("retires %s fragment writes before a later visit", async result => {
    const { sync, router } = fixture();
    router.replace.mockImplementationOnce(() => result === "rejected" ? Promise.reject(Error("router failed")) : Promise.resolve({ type: result }));
    const write = sync.writeCurrentFragment();
    if (result === "rejected") await expect(write).rejects.toThrow("router failed");
    else await write;
    expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it("an older fragment completion cannot retire a newer pending publication", async () => {
    const { sync, router, current } = fixture(); const first = deferred(), second = deferred();
    router.replace.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = sync.writeCurrentFragment();
    current.editorLine = { from: 8, to: 8 };
    const newer = sync.writeCurrentFragment();
    const token = sync.state().acknowledgementTransition;
    first.resolve(); await older;
    expect(sync.state().acknowledgementTransition).toEqual(token);
    second.resolve(); await newer;
    expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it.each([
    ["markdown", true, "#source:L2-4"],
    ["preview", true, "#source:L2-4"],
    ["wysiwyg", true, "#edit"],
    ["markdown", false, "#view:L8"],
  ])("maps %s edit=%s to %s", (editorMode, editMode, hash) => {
    const { sync, router, current } = fixture();
    Object.assign(current, { editorMode, editMode, viewLine: { from: 8, to: 8 } });
    sync.writeCurrentFragment(true);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/Folder/My%20note?x=one&x=two${hash}`);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("replaces continuous state and preserves literal slashes, encoding and repeated queries", () => {
    const { sync, router, location } = fixture();
    location.pathname = "/notes/Folder/%E7%AC%94%E8%AE%B0/part";
    sync.writeCurrentFragment();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/Folder/%E7%AC%94%E8%AE%B0/part?x=one&x=two#source:L2-4");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("uses current document location at write time, skipping an already matching fragment", () => {
    const { sync, router, location } = fixture();
    location.hash = "#source:L2-4";
    sync.writeCurrentFragment(true);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    location.pathname = "/notes/New/Path"; location.search = "?new=1";
    sync.writeFragment(null, true);
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/New/Path?new=1");
  });

  it("new-note fragment and caret intents do not write URLs", async () => {
    vi.useFakeTimers();
    const { sync, router, current } = fixture(); current.isNewNote = true;
    sync.writeCurrentFragment(true); sync.writeFragment(null); sync.scheduleCaretSync();
    await vi.advanceTimersByTimeAsync(120);
    expect(router.push).not.toHaveBeenCalled(); expect(router.replace).not.toHaveBeenCalled();
  });

  it("defaults the location adapter to browser location", () => {
    window.history.replaceState(null, "", "/Folder/Note?q=1");
    const { sync, router } = fixture({ getLocation: undefined });
    sync.writeCurrentFragment();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/Folder/Note?q=1#source:L2-4");
  });
});

describe("caret URL debounce", () => {
  it("debounces at 120ms and reads the latest fragment and document URL at fire time", async () => {
    vi.useFakeTimers();
    const { sync, router, current, location } = fixture();
    sync.scheduleCaretSync(); await vi.advanceTimersByTimeAsync(100);
    current.editorLine = { from: 9, to: 9 }; sync.scheduleCaretSync();
    await vi.advanceTimersByTimeAsync(119); expect(router.replace).not.toHaveBeenCalled();
    location.search = "?latest=1";
    await vi.advanceTimersByTimeAsync(1);
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/Folder/My%20note?latest=1#source:L9");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("cancellation is repeatable, prevents a pending write and permits later scheduling", async () => {
    vi.useFakeTimers(); const { sync, router } = fixture();
    sync.scheduleCaretSync(); sync.clearCaretSyncTimer(); sync.clearCaretSyncTimer();
    await vi.advanceTimersByTimeAsync(120); expect(router.replace).not.toHaveBeenCalled();
    sync.scheduleCaretSync(); await vi.advanceTimersByTimeAsync(120);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});

describe("canonical save route and acknowledgement token", () => {
  it("an already canonical route creates no transition or router write", async () => {
    const { sync, router } = fixture(); router.currentRoute.value.fullPath = "/Canonical#source:L2-4";
    await sync.canonicalSaveRoute(snapshot, "Canonical");
    expect(router.replace).not.toHaveBeenCalled(); expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it("publishes exact submission authority before replace and suppresses only the acknowledged resource reload", async () => {
    const { sync, router } = fixture();
    router.replace.mockImplementationOnce(async fullPath => {
      const transition = sync.state().acknowledgementTransition;
      expect(transition).toMatchObject({ ownerId: "owner", sessionId: "session", submissionId: 3, fullPath: "/Folder/My%20note#source:L2-4", path: "Folder/My note", guardConsumed: false });
      expect(transition.nonce).toMatch(/^[\da-f-]{36}$/i);
      const action = decideNavigation({ ...sync.state(), ownerId: "owner", sessionId: "session", activeSubmissionId: 3 }, { fullPath });
      expect(action).toEqual({ type: "acknowledge" });
      sync.consumeAcknowledgementGuard();
      expect(sync.consumeAcknowledgedResource("Other", "session")).toBe(false);
      expect(sync.consumeAcknowledgedResource("Folder/My note", "other-session")).toBe(false);
      expect(sync.consumeAcknowledgedResource("Folder/My note", "session")).toBe(true);
      expect(sync.consumeAcknowledgedResource("Folder/My note", "session")).toBe(false);
      router.currentRoute.value = { fullPath };
    });
    await sync.canonicalSaveRoute(snapshot, "Folder/My note");
    expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it("an unconsumed token cannot suppress init and state snapshots cannot mutate its authority", async () => {
    const { sync } = fixture(); await sync.canonicalSaveRoute(snapshot, "Canonical");
    const before = sync.state(); before.acknowledgementTransition.guardConsumed = true;
    expect(sync.consumeAcknowledgedResource("Canonical", "session")).toBe(false);
    expect(sync.state().acknowledgementTransition.guardConsumed).toBe(false);
  });

  it("clears its token after replace when the live prop already has the canonical path", async () => {
    const { sync, setPath } = fixture(); setPath("Canonical");
    await sync.canonicalSaveRoute(snapshot, "Canonical");
    expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it("an old completion cannot clear a replacement submission's token", async () => {
    const { sync, router, setPath } = fixture(); const first = deferred(), second = deferred();
    router.replace.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const older = sync.canonicalSaveRoute(snapshot, "Canonical");
    const firstNonce = sync.state().acknowledgementTransition.nonce;
    const newer = sync.canonicalSaveRoute({ sessionId: "session", submissionId: 4 }, "Next");
    const next = sync.state().acknowledgementTransition;
    expect(next.nonce).not.toBe(firstNonce);
    setPath("Canonical"); router.currentRoute.value.fullPath = "/Canonical#source:L2-4"; first.resolve(); await older;
    expect(sync.state().acknowledgementTransition).toEqual(next);
    setPath("Next"); router.currentRoute.value.fullPath = "/Next#source:L2-4"; second.resolve(); await newer;
    expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it("a rejected router write propagates and retires navigation authority", async () => {
    const { sync, router } = fixture(); const error = Error("router unavailable");
    router.replace.mockRejectedValueOnce(error);
    await expect(sync.canonicalSaveRoute(snapshot, "Canonical")).rejects.toBe(error);
    expect(sync.state().acknowledgementTransition).toBeNull();
  });

  it("an aborted canonical navigation reports committed work without leaving navigation authority", async () => {
    const { sync, router } = fixture(); router.replace.mockResolvedValueOnce(undefined);
    await expect(sync.canonicalSaveRoute(snapshot, "Canonical")).rejects.toThrow("Save committed, but its canonical route could not be applied. Work is retained.");
    expect(sync.state().acknowledgementTransition).toBeNull();
  });
});
