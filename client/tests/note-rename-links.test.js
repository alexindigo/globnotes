import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNote, getNotes, updateNote } from "../api.js";
import { createNoteRenameLinks } from "../noteRenameLinks.js";

vi.mock("../api.js", () => ({ getNote: vi.fn(), getNotes: vi.fn(), updateNote: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const adapters = {
    ownsPath: vi.fn(() => false), updated: vi.fn(), failed: vi.fn(),
    search: vi.fn(async () => [{ path: "probe/source" }]),
    read: vi.fn(async () => ({ content: "[[target/old]] and [md](../target/old.md)" })),
    update: vi.fn(async () => ({})), ...overrides,
  };
  return { ...adapters, ...createNoteRenameLinks(adapters) };
}

describe("best-effort rename link traversal", () => {
  it("searches references, excludes both identities, and writes rewritten content with the original API arguments", async () => {
    const f = fixture({ search: vi.fn(async () => ["target/old", "target/new", "probe/source"].map(path => ({ path }))) });
    await f.updateRenamedLinks("target/old", "target/new");
    expect(f.search).toHaveBeenCalledExactlyOnceWith("target/old", undefined, undefined, undefined, true);
    expect(f.read).toHaveBeenCalledExactlyOnceWith("probe/source");
    expect(f.update).toHaveBeenCalledExactlyOnceWith("probe/source", "probe/source", "[[target/new]] and [md](../target/new.md)");
    expect(f.updated).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not read owned aliases or rewrite unchanged content", async () => {
    const f = fixture({
      search: vi.fn(async () => [{ path: "owned" }, { path: "untouched" }]),
      ownsPath: vi.fn(path => path === "owned"), read: vi.fn(async () => ({ content: "![[target/old]] [[other]]" })),
    });
    await f.updateRenamedLinks("target/old", "target/new");
    expect(f.read).toHaveBeenCalledExactlyOnceWith("untouched");
    expect(f.update).not.toHaveBeenCalled(); expect(f.updated).not.toHaveBeenCalled();
  });

  it("rechecks live ownership after an asynchronous read", async () => {
    const pending = deferred(), aliases = new Set();
    const f = fixture({ ownsPath: path => aliases.has(path), read: vi.fn(() => pending.promise) });
    const completion = f.updateRenamedLinks("target/old", "target/new");
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledExactlyOnceWith("probe/source");
    aliases.add("probe/source"); pending.resolve({ content: "[[target/old]]" }); await completion;
    expect(f.update).not.toHaveBeenCalled(); expect(f.updated).not.toHaveBeenCalled();
  });

  it("waits for each write before reading the next candidate and reports the full completed count", async () => {
    const pending = deferred();
    const f = fixture({ search: vi.fn(async () => [{ path: "A" }, { path: "B" }]), update: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({}) });
    const completion = f.updateRenamedLinks("target/old", "target/new");
    await Promise.resolve(); await Promise.resolve();
    expect(f.read.mock.calls).toEqual([["A"]]); expect(f.updated).not.toHaveBeenCalled();
    pending.resolve({}); await completion;
    expect(f.read.mock.calls).toEqual([["A"], ["B"]]); expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.updated).toHaveBeenCalledExactlyOnceWith(2);
  });

  it.each(["search", "read", "update"])("swallows %s failure, stopping the traversal without reporting success", async stage => {
    const error = new Error(stage);
    const f = fixture({ search: vi.fn(async () => [{ path: "A" }, { path: "B" }]), [stage]: vi.fn().mockRejectedValue(error) });
    await expect(f.updateRenamedLinks("target/old", "target/new")).resolves.toBeUndefined();
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(error); expect(f.updated).not.toHaveBeenCalled();
    if (stage !== "search") expect(f.read).toHaveBeenCalledTimes(1);
    if (stage === "search" || stage === "read") expect(f.update).not.toHaveBeenCalled();
  });

  it("keeps partial writes but does not report aggregate success after a later failure", async () => {
    const error = new Error("second write");
    const f = fixture({ search: vi.fn(async () => [{ path: "A" }, { path: "B" }, { path: "C" }]), update: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(error) });
    await f.updateRenamedLinks("target/old", "target/new");
    expect(f.update).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.failed).toHaveBeenCalledWith(error); expect(f.updated).not.toHaveBeenCalled();
  });

  it("does nothing when search has no candidates", async () => {
    const f = fixture({ search: vi.fn(async () => []) });
    await f.updateRenamedLinks("old", "new");
    expect(f.read).not.toHaveBeenCalled(); expect(f.updated).not.toHaveBeenCalled();
  });

  it("binds the default transport and preserves the diagnostic failure effect", async () => {
    getNotes.mockResolvedValue([{ path: "ref" }]); getNote.mockResolvedValue({ content: "[[old]]" }); updateNote.mockResolvedValue({});
    const controller = createNoteRenameLinks({ ownsPath: () => false });
    await controller.updateRenamedLinks("old", "new");
    expect(getNotes).toHaveBeenCalledExactlyOnceWith("old", undefined, undefined, undefined, true);
    expect(getNote).toHaveBeenCalledExactlyOnceWith("ref"); expect(updateNote).toHaveBeenCalledExactlyOnceWith("ref", "ref", "[[new]]");
    const error = new Error("offline"), log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getNotes.mockRejectedValueOnce(error); await controller.updateRenamedLinks("old", "new");
      expect(log).toHaveBeenCalledExactlyOnceWith("link update failed", error);
    } finally { log.mockRestore(); }
  });
});
