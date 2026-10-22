import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({ createNote: vi.fn(), updateNote: vi.fn(), previewRename: vi.fn() }));

import { createNote, updateNote, previewRename } from "../api.js";
import { TOPICS } from "../bus/index.js";
import { createNoteSaveOwner } from "../noteSaveOwner.js";

const owners = [];
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

function fixture(overrides = {}, useDefaults = false) {
  const current = { note: { path: "P", content: "old" }, isNewNote: false,
    requestedPath: "P", contentRevision: 0, pathRevision: 0 };
  let buffer = "old";
  let owner;
  const sent = [];
  const transport = kind => vi.fn((...args) => {
    const request = { ...deferred(), kind, args };
    sent.push(request);
    return request.promise;
  });
  const adapters = {
    ownerId: "owner",
    getState: () => current,
    getBuffer: () => buffer,
    isContentChanged: () => {
      const queue = owner.state().queue;
      return queue.unresolved || owner.contentNeedsSave();
    },
    applyNote: vi.fn(result => { current.note = result; }),
    applyPath: vi.fn(path => { current.requestedPath = path; }),
    applyContentAcknowledgement: vi.fn(content => { buffer = content; }),
    restoreContent: vi.fn(content => { buffer = content; }),
    publishTitle: vi.fn(), setMovedFiles: vi.fn(),
    urlSync: { canonicalSaveRoute: vi.fn(async () => {}) },
    updateRenamedLinks: vi.fn(),
    drafts: { clear: vi.fn(), clearAcknowledged: vi.fn() },
    requestDecision: vi.fn(async () => "cancel"), closeNote: vi.fn(),
    saveEditorPreference: vi.fn(), changed: vi.fn(), refreshDirtyState: vi.fn(),
    invalid: vi.fn(), held: vi.fn(), failed: vi.fn(), publish: vi.fn(),
    create: transport("create"), update: transport("update"), preview: vi.fn(async () => []),
    ...overrides,
  };
  if (useDefaults) {
    createNote.mockImplementation(adapters.create);
    updateNote.mockImplementation(adapters.update);
    previewRename.mockImplementation(adapters.preview);
    delete adapters.create; delete adapters.update; delete adapters.preview;
  }
  owner = createNoteSaveOwner(adapters);
  owners.push(owner);
  function edit(content, path) {
    buffer = content; current.contentRevision++;
    if (path !== undefined) { current.requestedPath = path; current.pathRevision++; }
  }
  async function ack(index, path = "P", content = sent[index].args[2], extra = {}) {
    sent[index].resolve({ path, content, ...extra });
    await flush();
  }
  return { owner, current, adapters, sent, edit, ack, buffer: () => buffer };
}

describe("save owner submission and acknowledgement", () => {
  it.each([false, true])("holds delayed rename results when newer prose exists (queued=%s)", async queued => {
    const f = fixture();
    const base = "# P\n\n![pic](assets/pic.png)\n\nBody\n";
    const returned = base.replace("assets/", "../old/assets/");
    f.owner.start(); f.edit(base, "new/P"); f.owner.rename(); await flush();
    f.edit(base + "New paragraph\n"); if (queued) f.owner.save();
    await f.ack(0, "new/P", returned);
    expect(f.buffer()).toBe(base + "New paragraph\n");
    expect(f.sent).toHaveLength(1); expect(f.owner.queueState().rebaseConflict).toBe(true);
    f.owner.save(); await flush();
    expect(f.sent[1].args).toEqual(["new/P", "new/P", base + "New paragraph\n", "none"]);
    await f.ack(1, "new/P");
    expect(f.current.note.content).toBe(base + "New paragraph\n");
    expect(f.owner.contentNeedsSave()).toBe(false);
  });
  it.each([false, true])("holds overlapping rename edits until explicit Save (queued=%s)", async queued => {
    const f = fixture();
    const base = "![pic](assets/pic.png)\n", mine = "![pic](uploads/other.png)\n";
    f.owner.start(); f.edit(base, "new/P"); f.owner.rename(); await flush();
    f.edit(mine); if (queued) f.owner.save();
    await f.ack(0, "new/P", "![pic](../old/assets/pic.png)\n");
    expect(f.buffer()).toBe(mine); expect(f.sent).toHaveLength(1);
    expect(f.owner.queueState().rebaseConflict).toBe(true);
    expect(f.adapters.failed).toHaveBeenCalledWith(expect.objectContaining({ code: "rename_rebase_conflict" }));
    f.owner.save(); await flush();
    expect(f.sent[1].args).toEqual(["new/P", "new/P", mine, "none"]);
    await f.ack(1, "new/P");
    expect(f.current.note.content).toBe(mine);
    expect(f.owner.queueState().rebaseConflict).toBe(false);
  });
  it("holds a queued snapshot even when the live text returned to the sent base", async () => {
    const f = fixture(), base = "![pic](assets/pic.png)\n\nBody\n";
    const returned = base.replace("assets/", "../old/assets/");
    f.owner.start(); f.edit(base, "new/P"); f.owner.rename(); await flush();
    f.edit(base.replace("assets/pic.png", "uploads/other.png")); f.owner.save();
    f.edit(base); await f.ack(0, "new/P", returned);
    expect(f.buffer()).toBe(returned); expect(f.sent).toHaveLength(1);
    expect(f.owner.queueState().rebaseConflict).toBe(true);
    f.owner.save(); await flush();
    expect(f.sent[1].args[2]).toContain("uploads/other.png");
    await f.ack(1, "new/P");
    expect(f.sent[2].args[2]).toBe(returned);
    await f.ack(2, "new/P");
    expect(f.current.note.content).toBe(returned);
  });
  it.each([false, true])("holds repeated path segments without guessing an alignment (queued=%s)", async queued => {
    const f = fixture(), base = "![pic](a/a/p.png)\n", mine = "![pic](b/a/p.png)\n";
    f.owner.start(); f.edit(base, "old/a/P"); f.owner.rename(); await flush();
    f.edit(mine); if (queued) f.owner.save();
    await f.ack(0, "old/a/P", "![pic](a/p.png)\n");
    expect(f.sent).toHaveLength(1); expect(f.buffer()).toBe(mine);
    expect(f.owner.queueState().rebaseConflict).toBe(true);
  });
  it.each([false, true])("holds copied references introduced during rename (queued=%s)", async queued => {
    const f = fixture(), base = "![pic](assets/pic.png)\n\nBody\n";
    const mine = base + "![copy](assets/pic.png)\n";
    f.owner.start(); f.edit(base, "new/P"); f.owner.rename(); await flush();
    f.edit(mine); if (queued) f.owner.save();
    await f.ack(0, "new/P", base.replace("assets/", "../old/assets/"));
    expect(f.sent).toHaveLength(1); expect(f.buffer()).toBe(mine);
    expect(f.owner.queueState().rebaseConflict).toBe(true);
  });
  it("does not release conflicting queued work when manual Save has an invalid current name", async () => {
    const f = fixture(), base = "![pic](assets/pic.png)\n";
    f.owner.start(); f.edit(base, "new/P"); f.owner.rename(); await flush();
    f.edit(base.replace("assets/pic.png", "uploads/other.png")); f.owner.save();
    await f.ack(0, "new/P", base.replace("assets/", "../old/assets/"));
    f.edit(f.buffer(), "bad?"); f.owner.save(); await flush();
    expect(f.sent).toHaveLength(1);
    expect(f.owner.queueState().rebaseConflict).toBe(true);
    expect(f.adapters.invalid).toHaveBeenCalled();
  });

  it("has an idle read-only snapshot and safely settles before editing", async () => {
    const { owner } = fixture();
    expect(Object.isFrozen(owner.state())).toBe(true);
    expect(Object.isFrozen(owner.state().queue)).toBe(true);
    expect(owner.queueState()).toBeUndefined();
    expect(owner.state()).toMatchObject({ queue: { status: "idle", unresolved: false }, pendingRenamePrompt: null });
    expect(await owner.settle()).toBe(true);
    expect(owner.discard()).toBe(false);
  });

  it("starts a fresh session with the existing base, and resets aliases only for a resource reset", () => {
    const { owner, current } = fixture();
    owner.start();
    expect(owner.queueState()).toMatchObject({ sessionId: "owner:1", acknowledged: current.note });
    expect(owner.ownsPath("P")).toBe(true);
    owner.end(); expect(owner.queueState()).toBeUndefined();
    expect(owner.ownsPath("P")).toBe(true);
    owner.reset(); expect(owner.ownsPath("P")).toBe(false);
    current.note = { path: "Next" };
    owner.start();
    expect(owner.queueState()).toMatchObject({ sessionId: "owner:2", acknowledged: { path: "Next", content: "" } });
  });

  it("captures each click immediately and keeps literal FIFO content and revisions", async () => {
    const { owner, sent, edit, ack, buffer, adapters } = fixture();
    owner.start(); edit("A"); const a = owner.save();
    edit("B"); const b = owner.save(); edit("D");
    expect(a.submissionId).not.toBe(b.submissionId);
    expect(owner.queueState().active.snapshot).toMatchObject({ content: "A", requestedPath: "P", contentRevision: 1, pathRevision: 0, draftRevision: 1, intent: "save", attachmentPolicy: "none" });
    expect(owner.queueState().active.snapshot).not.toHaveProperty("draftKey");
    expect(Object.isFrozen(owner.queueState().active.snapshot)).toBe(true);
    await flush(); expect(sent.map(item => item.args)).toEqual([["P", "P", "A", "none"]]);
    await ack(0); expect(sent[1].args).toEqual(["P", "P", "B", "none"]);
    await ack(1); expect(buffer()).toBe("D");
    expect(adapters.applyContentAcknowledgement).not.toHaveBeenCalled();
    expect(adapters.drafts.clearAcknowledged).not.toHaveBeenCalled();
  });

  it("ignores equal-content clicks before, during and after saving", async () => {
    const { owner, sent, edit, ack } = fixture();
    expect(owner.save()).toBeNull(); owner.start(); expect(owner.save()).toBeNull();
    edit("same"); owner.save(); expect(owner.save()).toBeNull(); await flush();
    edit("B"); owner.save(); expect(owner.save()).toBeNull();
    await ack(0, "P", "normalized"); expect(sent[1].args[2]).toBe("B");
    await ack(1); expect(owner.save()).toBeNull(); expect(sent).toHaveLength(2);
  });

  it("validates before admission without saving a mode preference", async () => {
    const { owner, edit, sent, adapters } = fixture();
    owner.start(); edit("A"); owner.save(); await flush();
    edit("D", "bad?"); expect(owner.save(true)).toBeNull();
    expect(sent).toHaveLength(1); expect(owner.queueState().queued).toHaveLength(0);
    expect(adapters.invalid).toHaveBeenCalledWith(expect.any(String));
    expect(adapters.saveEditorPreference).not.toHaveBeenCalled();
  });
  it("a paused queue does not capture the same submitted text again", async () => {
    const { owner, edit, sent, adapters } = fixture(); owner.start(); edit("A"); owner.save(); await flush();
    sent[0].reject({ response: { data: { code: "plugin_cancelled" } } }); await flush();
    expect(owner.save()).toBeNull(); expect(owner.queueState().jobs).toHaveLength(1);
    expect(adapters.held).not.toHaveBeenCalled(); expect(sent).toHaveLength(1);
  });

  it("integrates owned normalization, moved files, route and rename facts in their existing order", async () => {
    const { owner, adapters, edit, ack, current, buffer } = fixture();
    owner.start(); edit("literal", "Q"); owner.rename(); await flush();
    const snapshot = owner.queueState().active.snapshot;
    const movedFiles = [{ oldPath: "a.png", newPath: "b.png" }];
    await ack(0, "Canonical", "normalized", { movedFiles });
    expect(current.note).toEqual({ path: "Canonical", content: "normalized", movedFiles });
    expect(current.requestedPath).toBe("Canonical"); expect(buffer()).toBe("normalized");
    expect(adapters.publish).toHaveBeenCalledExactlyOnceWith(TOPICS.NOTE_RENAME, { oldPath: "P", newPath: "Canonical" });
    expect(adapters.setMovedFiles).toHaveBeenCalledExactlyOnceWith(movedFiles);
    expect(adapters.urlSync.canonicalSaveRoute).toHaveBeenCalledExactlyOnceWith(snapshot, "Canonical");
    expect(adapters.updateRenamedLinks).toHaveBeenCalledExactlyOnceWith("P", "Canonical");
    expect(adapters.applyNote.mock.invocationCallOrder[0]).toBeLessThan(adapters.publishTitle.mock.invocationCallOrder[0]);
    expect(adapters.publish.mock.invocationCallOrder[0]).toBeLessThan(adapters.urlSync.canonicalSaveRoute.mock.invocationCallOrder[0]);
    expect(adapters.urlSync.canonicalSaveRoute.mock.invocationCallOrder[0]).toBeLessThan(adapters.updateRenamedLinks.mock.invocationCallOrder[0]);
    expect(adapters.drafts.clearAcknowledged).toHaveBeenCalledExactlyOnceWith(1);
    expect(owner.ownsPath("P")).toBe(true); expect(owner.ownsPath("Canonical")).toBe(true);
  });

  it("publishes a content-only save and resets moved files when absent", async () => {
    const { owner, edit, ack, adapters } = fixture();
    owner.start(); edit("A"); owner.save(); await flush(); await ack(0);
    expect(adapters.publish).toHaveBeenCalledExactlyOnceWith(TOPICS.NOTE_SAVE, { path: "P" });
    expect(adapters.setMovedFiles).toHaveBeenCalledWith([]);
    expect(adapters.updateRenamedLinks).not.toHaveBeenCalled();
    expect(adapters.applyContentAcknowledgement).not.toHaveBeenCalled();
  });

  it("preserves newer path intent while queued saves inherit acknowledged canonical identity", async () => {
    const { owner, edit, ack, sent, current, buffer } = fixture();
    owner.start(); edit("A", "Q"); owner.rename(); edit("B"); owner.save(); edit("C", "P"); owner.rename();
    // This case isolates path lineage; conflicting content normalization is
    // covered by the explicit rename-rebase cases above.
    await flush(); await ack(0, "Canonical", "A");
    expect(sent[1].args).toEqual(["Canonical", "Canonical", "B", "none"]);
    expect(current.requestedPath).toBe("P"); expect(buffer()).toBe("C");
    await ack(1, "Canonical", "B"); expect(sent[2].args).toEqual(["Canonical", "P", "C", "none"]);
  });

  it("creates once, uses real identity for B and never closes a new-note save", async () => {
    const { owner, current, edit, ack, sent, adapters } = fixture();
    current.isNewNote = true;
    owner.start(); edit("A"); owner.save(); edit("B"); owner.save(); await flush();
    expect(sent[0]).toMatchObject({ kind: "create", args: ["P", "A"] });
    await ack(0, "Created", "A");
    expect(sent[1]).toMatchObject({ kind: "update", args: ["Created", "Created", "B", "none"] });
    expect(adapters.closeNote).not.toHaveBeenCalled();
    await ack(1, "Created", "B"); expect(adapters.closeNote).not.toHaveBeenCalled();
    expect(adapters.publish.mock.calls).toEqual([[TOPICS.NOTE_CREATE, { path: "Created" }], [TOPICS.NOTE_SAVE, { path: "Created" }]]);
  });

  it("binds default create/update/preview adapters without the view importing transports", async () => {
    const { owner, current, edit, ack } = fixture({}, true);
    current.isNewNote = true; owner.start(); edit("A"); owner.save(); await flush();
    expect(createNote).toHaveBeenCalledExactlyOnceWith("P", "A");
    await ack(0, "Created", "A"); edit("B", "folder/Q"); owner.rename(); await flush();
    expect(previewRename).toHaveBeenCalledExactlyOnceWith("Created", "folder/Q");
    expect(updateNote).toHaveBeenCalledExactlyOnceWith("Created", "folder/Q", "B", "none");
  });

  it("waits for canonical routing before rewriting links or sending queued work", async () => {
    const route = deferred();
    const { owner, edit, sent, ack, adapters } = fixture({ urlSync: { canonicalSaveRoute: vi.fn(() => route.promise) } });
    owner.start(); edit("A", "Q"); owner.rename(); edit("B"); owner.save(); await flush();
    await ack(0, "Q", "A");
    expect(sent).toHaveLength(1); expect(adapters.updateRenamedLinks).not.toHaveBeenCalled();
    route.resolve(); await flush();
    expect(adapters.updateRenamedLinks).toHaveBeenCalledWith("P", "Q"); expect(sent).toHaveLength(2);
  });

  it("retains committed identity and held B on a canonical route failure without replay", async () => {
    const error = Error("route failed");
    const { owner, edit, sent, ack, adapters } = fixture({ urlSync: { canonicalSaveRoute: vi.fn(async () => { throw error; }) } });
    owner.start(); edit("A", "Q"); owner.rename(); edit("B"); owner.save(); await flush(); await ack(0, "Q", "A");
    expect(owner.queueState()).toMatchObject({ status: "paused", acknowledged: { path: "Q", content: "A" }, failure: { certainty: "known-committed" } });
    expect(sent).toHaveLength(1); expect(adapters.failed).toHaveBeenCalledWith(error);
    expect(adapters.updateRenamedLinks).not.toHaveBeenCalled();
    expect(adapters.drafts.clearAcknowledged).not.toHaveBeenCalled();
  });
  it("does not resubmit acknowledged normalized text after integration fails", async () => {
    const { owner, edit, ack, buffer } = fixture({ urlSync: { canonicalSaveRoute: vi.fn(async () => { throw Error("route failed"); }) } });
    owner.start(); edit("literal"); owner.save(); await flush(); await ack(0, "P", "normalized");
    expect(buffer()).toBe("normalized"); expect(owner.queueState().failure.certainty).toBe("known-committed");
    expect(owner.save()).toBeNull(); expect(owner.queueState().jobs).toHaveLength(1);
  });
});

describe("save owner attachment preparation", () => {
  it.each(["move", "relink", "none"])("accepts the exact current prompt's %s choice for its original snapshot", async strategy => {
    const refs = [{ url: "image.png", kind: "image" }];
    const { owner, edit, sent, adapters } = fixture({ preview: vi.fn(async () => refs) });
    owner.start(); edit("A", "folder/P"); owner.rename(); edit("B"); owner.save(); await flush();
    const prompt = owner.state().pendingRenamePrompt;
    expect(Object.isFrozen(prompt)).toBe(true); expect(Object.isFrozen(prompt.identity)).toBe(true);
    expect(prompt.refs).toEqual(refs);
    expect(prompt.identity).toMatchObject({ sessionId: "owner:1", jobId: 1 });
    expect(prompt.identity).not.toHaveProperty("queue");
    expect(prompt.identity).not.toHaveProperty("isCurrent");
    expect(adapters.preview).toHaveBeenCalledExactlyOnceWith("P", "folder/P");
    owner.confirmRename(strategy, {}); expect(sent).toHaveLength(0);
    owner.confirmRename(strategy, prompt.identity); await flush();
    expect(owner.state().pendingRenamePrompt).toBeNull();
    expect(sent[0].args).toEqual(["P", "folder/P", "A", strategy]);
  });

  it.each(["new", "same-folder", "session"])("skips previews for %s saves", async kind => {
    const { owner, current, edit, sent, adapters, ack } = fixture();
    current.isNewNote = kind === "new"; owner.start(); edit("A", kind === "same-folder" ? "Q" : "folder/P");
    const pending = kind === "session" ? owner.saveForNavigation() : owner.save(); await flush();
    expect(adapters.preview).not.toHaveBeenCalled(); expect(owner.state().pendingRenamePrompt).toBeNull();
    expect(sent).toHaveLength(1);
    if (kind === "session") { await ack(0, "folder/P"); expect(await pending).toBe(true); }
  });

  it.each([null, {}, "invalid"])("pauses invalid rename previews (%j) before mutation", async refs => {
    const { owner, edit, sent } = fixture({ preview: vi.fn(async () => refs) });
    owner.start(); edit("A", "folder/P"); owner.rename(); await flush();
    expect(sent).toHaveLength(0); expect(owner.state().pendingRenamePrompt).toBeNull();
    expect(owner.queueState()).toMatchObject({ status: "paused", failure: { certainty: "known-unsent", message: "Invalid rename preview; no write was sent." } });
  });

  it("pauses on preview rejection without sending a mutation", async () => {
    const error = Error("preview failed");
    const { owner, edit, sent, adapters } = fixture({ preview: vi.fn(async () => { throw error; }) });
    owner.start(); edit("A", "folder/P"); owner.rename(); await flush();
    expect(owner.queueState().failure.certainty).toBe("known-unsent");
    expect(adapters.failed).toHaveBeenCalledWith(error); expect(sent).toHaveLength(0);
  });

  it("cancels only the current prompt and retains queued snapshots as held", async () => {
    const { owner, edit, sent, adapters } = fixture({ preview: vi.fn(async () => [{ url: "a" }]) });
    owner.start(); edit("A", "folder/P"); owner.rename(); edit("B"); owner.save(); await flush();
    owner.cancelRename(owner.state().pendingRenamePrompt.identity); await flush();
    expect(owner.queueState()).toMatchObject({ status: "paused", failure: { certainty: "cancelled-unsent" } });
    expect(owner.queueState().queued.map(job => job.snapshot.content)).toEqual(["B"]);
    edit("C"); expect(owner.save().held).toBe(true); expect(adapters.held).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(0); expect(owner.state().pendingRenamePrompt).toBeNull();
  });

  it("revokes an open prompt at the observation deadline and ignores its stale callbacks", async () => {
    const { owner, edit, sent, adapters } = fixture({ preview: vi.fn(async () => [{ url: "a" }]) });
    owner.start(); edit("A", "folder/P"); owner.rename(); await flush();
    const identity = owner.state().pendingRenamePrompt.identity;
    await vi.advanceTimersByTimeAsync(60_000);
    const failure = owner.queueState().failure;
    expect(owner.state().pendingRenamePrompt).toBeNull();
    owner.confirmRename("move", identity); owner.cancelRename(identity); await flush();
    expect(sent).toHaveLength(0); expect(owner.queueState().failure).toEqual(failure);
    expect(adapters.failed).toHaveBeenCalledOnce();
  });

  it.each(["reset", "start", "dispose", "timeout"])("late previews after %s cannot open prompts or send writes", async action => {
    const preview = deferred();
    const { owner, edit, sent } = fixture({ preview: () => preview.promise });
    owner.start(); edit("A", "folder/P"); owner.rename();
    if (action === "timeout") await vi.advanceTimersByTimeAsync(60_000);
    else owner[action]();
    preview.resolve([{ url: "obsolete" }]); await flush();
    expect(owner.state().pendingRenamePrompt).toBeNull(); expect(sent).toHaveLength(0);
  });

  it("old prompt identities cannot resolve or hide a replacement session's prompt", async () => {
    const { owner, edit, sent } = fixture({ preview: vi.fn(async () => [{ url: "a" }]) });
    owner.start(); edit("old", "folder/P"); owner.rename(); await flush();
    const oldIdentity = owner.state().pendingRenamePrompt.identity;
    owner.start(); edit("new", "next/P"); owner.rename(); await flush();
    const currentIdentity = owner.state().pendingRenamePrompt.identity;
    owner.confirmRename("none", oldIdentity); owner.cancelRename(oldIdentity); await flush();
    expect(owner.state().pendingRenamePrompt.identity).toBe(currentIdentity); expect(sent).toHaveLength(0);
    owner.confirmRename("move", currentIdentity); await flush(); expect(sent[0].args).toEqual(["P", "next/P", "new", "move"]);
  });
});

describe("save owner settlement and decisions", () => {
  it.each(["save", "discard", "cancel"])("resolves dirty work through the existing %s decision", async decision => {
    const { owner, edit, adapters, sent, ack, buffer } = fixture({ requestDecision: vi.fn(async () => decision) });
    owner.start(); edit("draft", "Q"); const pending = owner.resolve(); await flush();
    expect(adapters.requestDecision).toHaveBeenCalledOnce();
    if (decision === "save") {
      expect(sent[0].args).toEqual(["P", "P", "draft", "none"]);
      await ack(0, "P"); expect(await pending).toBe(true);
      expect(adapters.saveEditorPreference).not.toHaveBeenCalled();
    } else {
      expect(await pending).toBe(decision === "discard"); expect(sent).toHaveLength(0);
      expect(buffer()).toBe(decision === "discard" ? "old" : "draft");
      expect(adapters.drafts.clear).toHaveBeenCalledTimes(decision === "discard" ? 1 : 0);
    }
  });

  it("resolves clean work without a decision or extra save", async () => {
    const { owner, adapters } = fixture(); owner.start();
    expect(await owner.resolve()).toBe(true); expect(adapters.requestDecision).not.toHaveBeenCalled();
    expect(adapters.saveEditorPreference).not.toHaveBeenCalled();
  });

  it("a failed barrier aborts this attempt; the next known-paused attempt may explicitly discard", async () => {
    const { owner, edit, sent, adapters, buffer } = fixture({ requestDecision: vi.fn(async () => "discard") });
    owner.start(); edit("A"); owner.save(); const attempt = owner.resolve(); await flush();
    sent[0].reject({ response: { data: { code: "plugin_cancelled" } } }); await flush();
    expect(await attempt).toBe(false); expect(adapters.requestDecision).not.toHaveBeenCalled();
    expect(buffer()).toBe("A"); expect(await owner.resolve()).toBe(true);
    expect(buffer()).toBe("old"); expect(adapters.drafts.clear).toHaveBeenCalledOnce();
  });

  it("unknown or in-flight writes block discard and resolution without asking for a decision", async () => {
    const { owner, edit, sent, adapters } = fixture();
    owner.start(); edit("A"); owner.save(); await flush(); expect(owner.discard()).toBe(false);
    sent[0].reject(Error("lost")); await flush();
    expect(await owner.settle()).toBe(false); expect(await owner.resolve()).toBe(false); expect(owner.discard()).toBe(false);
    expect(adapters.requestDecision).not.toHaveBeenCalled(); expect(adapters.drafts.clear).not.toHaveBeenCalled();
  });

  it("discard restores the latest acknowledged base instead of the original loaded note", async () => {
    const { owner, edit, ack, current, buffer, adapters } = fixture();
    owner.start(); edit("saved", "Q"); owner.rename(); await flush(); await ack(0, "Canonical", "normalized");
    edit("newer", "Elsewhere"); expect(owner.discard()).toBe(true);
    expect(current.requestedPath).toBe("Elsewhere"); expect(buffer()).toBe("normalized");
    expect(adapters.restoreContent).toHaveBeenCalledExactlyOnceWith("normalized");
  });

  it("new-note discard restores its unsaved initial note when no acknowledgement exists", () => {
    const { owner, current, edit, buffer } = fixture();
    current.isNewNote = true; current.note = { path: "Untitled" }; owner.start(); edit("draft", "New");
    expect(owner.discard()).toBe(true); expect(current.requestedPath).toBe("New"); expect(buffer()).toBe("");
  });

  it("navigation saves wait for settlement and refuse a clean handoff over newer edits", async () => {
    const { owner, edit, ack } = fixture();
    owner.start(); edit("A"); const pending = owner.saveForNavigation(); await flush(); edit("D"); await ack(0);
    expect(await pending).toBe(false);
  });

  it("invalid or held navigation saves never authorize a handoff", async () => {
    const { owner, edit, sent, adapters } = fixture();
    owner.start(); edit("A", "bad?"); expect(await owner.saveForNavigation()).toBe(false);
    edit("B", "P"); owner.save(); await flush(); sent[0].reject({ response: { data: { code: "plugin_cancelled" } } }); await flush();
    expect(await owner.saveForNavigation()).toBe(false); expect(sent).toHaveLength(1);
    expect(adapters.held).not.toHaveBeenCalled();
  });

  it.each(["settle", "saveForNavigation"])("a replaced owner makes the old %s barrier unsafe", async method => {
    const { owner, edit, sent, adapters } = fixture();
    owner.start(); edit("A");
    if (method === "settle") owner.save();
    const pending = owner[method](); await flush(); owner.start();
    expect(await pending).toBe(false);
    sent[0].resolve({ path: "Obsolete", content: "A" }); await flush();
    expect(adapters.applyNote).not.toHaveBeenCalled(); expect(owner.queueState().sessionId).toBe("owner:2");
  });

  it("explicit save then resolve waits for the final drain and a decision about unsent newer work", async () => {
    const decision = deferred();
    const { owner, edit, ack, adapters } = fixture({ requestDecision: vi.fn(() => decision.promise) });
    owner.start(); edit("A"); owner.save(); const closing = owner.resolve(); edit("B"); owner.save(); edit("D"); await flush();
    await ack(0); expect(adapters.requestDecision).not.toHaveBeenCalled();
    await ack(1); expect(adapters.requestDecision).toHaveBeenCalledOnce(); expect(adapters.closeNote).not.toHaveBeenCalled();
    decision.resolve("cancel"); await flush(); expect(await closing).toBe(false); expect(adapters.closeNote).not.toHaveBeenCalled();
  });

  it("save settlement never closes a session, including after replacement", async () => {
    const { owner, edit, ack, adapters } = fixture();
    owner.start(); edit("A"); owner.save(); await flush(); await ack(0); expect(adapters.closeNote).not.toHaveBeenCalled();
    adapters.closeNote.mockClear(); const decision = deferred(); adapters.requestDecision.mockReturnValueOnce(decision.promise);
    edit("B"); owner.save(); const resolving = owner.resolve(); edit("D"); await flush(); await ack(1);
    expect(adapters.requestDecision).toHaveBeenCalledOnce();
    owner.start(); edit("Replacement work"); decision.resolve("discard"); await flush();
    expect(await resolving).toBe(false); expect(adapters.restoreContent).not.toHaveBeenCalled();
    expect(adapters.closeNote).not.toHaveBeenCalled();
  });

  it.each([false, true])("late matching acknowledgement settles only its own work (newer buffer=%s) without reviving save-close", async newer => {
    const { owner, edit, sent, adapters } = fixture();
    owner.start(); edit("A"); owner.save(); await flush();
    const wait = owner.settle(); await vi.advanceTimersByTimeAsync(60_000); expect(await wait).toBe(false);
    if (newer) edit("D");
    sent[0].resolve({ path: "P", content: "A" }); await flush();
    expect(owner.queueState().status).toBe(newer ? "paused" : "idle");
    expect(adapters.closeNote).not.toHaveBeenCalled(); expect(adapters.requestDecision).not.toHaveBeenCalled();
    expect(adapters.drafts.clearAcknowledged).not.toHaveBeenCalled();
  });
});
