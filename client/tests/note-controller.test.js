import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isReadonly, reactive } from "vue";
import { createNoteController } from "../noteController.js";
import { createNotePreview } from "../notePreview.js";
import { TOPICS } from "../bus/index.js";
import { getNote, deleteNote, updateNote, createNote } from "../api.js";

vi.mock("../api.js", () => ({
  getNote: vi.fn(), deleteNote: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(),
  previewRename: vi.fn(async () => []), getNotes: vi.fn(async () => []),
  uploadFile: vi.fn(), renderBuffer: vi.fn(), apiErrorHandler: vi.fn(),
}));

const controllers = [];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(overrides = {}, contextValues = {}) {
  const context = reactive({ path: "folder/P", query: {}, authType: "none", notePaths: ["b/B", "a/A", "Root", "b/C"], ...contextValues });
  const location = { pathname: "/folder/P", search: "", hash: "" };
  const router = { options: { history: { base: "" } }, currentRoute: { value: { fullPath: "/folder/P#source" } },
    push: vi.fn(), replace: vi.fn(async path => { router.currentRoute.value.fullPath = path; }) };
  const drafts = { load: vi.fn(() => null), release: vi.fn(), save: vi.fn(), clear: vi.fn(), clearAcknowledged: vi.fn() };
  const preview = { schedule: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
  const handlers = new Map(), unsubs = [];
  let participant;
  const unregister = vi.fn();
  const adapters = {
    getContext: () => context, router, getLocation: () => location, ownerId: "controller-owner",
    read: vi.fn(async path => ({ path, content: "Seed" })), remove: vi.fn(async () => ({})),
    defer: callback => Promise.resolve().then(callback), drafts,
    previewFactory: vi.fn(() => preview),
    renameLinksFactory: vi.fn(() => ({ updateRenamedLinks: vi.fn() })),
    attachmentsFactory: vi.fn(() => ({ addImageBlobHook: vi.fn() })),
    getEditorPreference: () => "markdown", saveEditorPreference: vi.fn(),
    publish: vi.fn(), setUnload: vi.fn(), failed: vi.fn(), toast: { add: vi.fn() },
    actionAvailable: vi.fn(() => true),
    subscribe: vi.fn((topic, handler) => { handlers.set(topic, handler); const unsub = vi.fn(() => handlers.delete(topic)); unsubs.push(unsub); return unsub; }),
    registerParticipant: vi.fn((name, value) => { participant = value; return unregister; }),
    ...overrides,
  };
  const controller = createNoteController(adapters);
  controllers.push(controller);
  let text = "Seed";
  const port = { getSnapshot: vi.fn(() => ({ ready: true, content: text })), getMarkdown: () => text,
    setMarkdown: vi.fn(value => { text = value; }), isWysiwygMode: () => false,
    applyAcknowledgement: vi.fn(value => { text = value; }), selectLine: vi.fn() };
  const enter = () => { controller.toggleEditModeHandler(); text = controller.state.editorInitialValue; controller.registerEditor(port); };
  const input = value => { text = value; controller.onEditorInput(); };
  const to = (path = "Other", hash = "") => ({ name: "note", params: { path }, query: {}, hash, fullPath: `/${path}${hash}` });
  return { controller, context, location, router, drafts, preview, adapters, port, enter, input, to,
    participant: () => participant, handlers, unsubs, unregister };
}

describe("note workflow ownership", () => {
  it("loads into read-only state and publishes the resolved title and folder options", async () => {
    const f = fixture(); await f.controller.mount();
    expect(isReadonly(f.controller.state)).toBe(true);
    expect(f.controller.state).toMatchObject({ loadStatus: "loaded", noteBasename: "P", noteDirName: "folder", editMode: false });
    expect(f.controller.state.folderDatalistOptions).toEqual(["a", "b"]);
    expect(f.adapters.publish).toHaveBeenCalledWith(TOPICS.NOTE_TITLE_CHANGED, { title: "P" });
    expect(f.participant().hasUnsavedChanges()).toBe(false);
  });
  it.each([404, 500])("classifies load status %s at the controller boundary", async status => {
    const error = { response: { status } }, f = fixture({ read: vi.fn(async () => { throw error; }) });
    await f.controller.mount();
    expect(f.controller.state.isNoteNotFound).toBe(status === 404);
    expect(f.controller.state.loadStatus).toBe(status === 404 ? "loaded" : "failed");
    expect(f.adapters.failed.mock.calls).toEqual(status === 404 ? [] : [[error]]);
  });
  it.each(["success", "failure"])("fences obsolete load %s after a new resource", async outcome => {
    const slow = deferred(), f = fixture({ read: vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ path: "Latest", content: "new" }) });
    const first = f.controller.mount(); f.context.path = "Latest"; await f.controller.init();
    if (outcome === "success") slow.resolve({ path: "Old", content: "old" }); else slow.reject(Error("old failure"));
    await first;
    expect(f.controller.state.note).toEqual({ path: "Latest", content: "new" }); expect(f.adapters.failed).not.toHaveBeenCalled();
  });
  it("fences a load completing after disposal", async () => {
    const read = deferred(), f = fixture({ read: () => read.promise }); const loading = f.controller.mount();
    f.controller.dispose(); read.resolve({ path: "Old", content: "old" }); await loading;
    expect(f.controller.state.note).toEqual({});
  });
  it("enters a new note with collision-free folder prefill", async () => {
    const f = fixture({}, { path: undefined, query: { folder: "a" }, notePaths: ["a/Untitled"] });
    await f.controller.mount();
    expect(f.controller.state).toMatchObject({ loadStatus: "loaded", editMode: true, editFolder: "a", editorInitialValue: "" });
    expect(f.controller.state.note.path).not.toBe("a/Untitled"); expect(f.adapters.read).not.toHaveBeenCalled();
  });
  it.each(["resume", "delete"])("preserves deep-linked source line across draft %s", async choice => {
    const f = fixture(); f.location.hash = "#source:L4-6"; f.drafts.load.mockReturnValue("Draft");
    await f.controller.mount();
    expect(f.controller.state).toMatchObject({ isDraftModalVisible: true, editMode: false });
    if (choice === "delete") { f.controller.clearDraft(); f.drafts.load.mockReturnValue(null); }
    f.controller.setEditMode();
    expect(f.controller.state).toMatchObject({ editorMode: "markdown", editorInitialLine: { from: 4, to: 6 }, editorInitialValue: choice === "resume" ? "Draft" : "Seed" });
    expect(f.controller.isDirty()).toBe(choice === "resume");
  });
  it("read-only fragment entry remains viewing and action toggle declines", async () => {
    const f = fixture({}, { authType: "read_only" }); f.location.hash = "#source";
    await f.controller.mount(); f.handlers.get(TOPICS.EDITOR_TOGGLE_EDIT)();
    expect(f.controller.state.editMode).toBe(false);
  });
  it("tracks literal buffer/path dirtiness immediately and saves the latest draft after debounce", async () => {
    const f = fixture(); await f.controller.mount(); f.enter();
    expect(f.controller.isDirty()).toBe(false); f.input("Changed");
    expect(f.controller.state.unsavedChanges).toBe(true); expect(f.participant().hasUnsavedChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.drafts.save).toHaveBeenCalledWith("folder/P", "Changed", 1);
    f.input("Seed"); expect(f.controller.isDirty()).toBe(false);
    f.controller.setBasename("Q"); f.controller.onTitleInput(); expect(f.controller.isDirty()).toBe(true);
    expect(f.adapters.setUnload).toHaveBeenLastCalledWith(true);
  });
  it("transfers retained buffer to preview and an initializing editor without empty placeholder loss", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Retained");
    f.controller.setEditorMode("preview"); f.controller.registerEditor(null);
    expect(f.controller.currentBuffer()).toBe("Retained");
    expect(f.preview.schedule.mock.lastCall[0].getBuffer()).toBe("Retained");
    f.controller.setEditorMode("wysiwyg"); f.port.getSnapshot.mockReturnValue({ ready: false }); f.controller.registerEditor(f.port);
    expect(f.controller.currentBuffer()).toBe("Retained");
    f.port.getSnapshot.mockReturnValue({ ready: true, content: "" }); expect(f.controller.currentBuffer()).toBe("");
  });
  it("captures a ready WYSIWYG buffer before a keyed remount", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.controller.setEditorMode("wysiwyg");
    f.input("New bytes"); f.controller.captureEditorForRemount(); f.controller.registerEditor(null);
    expect(f.controller.state.editorInitialValue).toBe("New bytes");
  });
  it("untouched new-note title follows H1 and a manual title stops follow", async () => {
    const f = fixture({}, { path: undefined, query: { path: "Initial" } }); await f.controller.mount();
    f.controller.registerEditor(f.port); f.input("# Followed"); await vi.advanceTimersByTimeAsync(300);
    expect(f.controller.state.editBasename).toBe("Followed");
    f.controller.setBasename("Manual"); f.controller.onTitleInput(); f.input("# Ignored"); await vi.advanceTimersByTimeAsync(300);
    expect(f.controller.state.editBasename).toBe("Manual");
  });
  it.each(["cancel", "discard", "save"])("navigation %s resolves through the owned decision", async choice => {
    updateNote.mockImplementation(async (source, path, content) => ({ path, content }));
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Work");
    f.location.hash = "#source"; f.router.push.mockClear();
    expect(await f.controller.gateNavigation(f.to())).toBe(false);
    expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
    f.controller.onSaveChoice(choice); await flush();
    expect(f.controller.state.editMode).toBe(choice === "cancel");
    expect(f.router.push.mock.calls).toEqual(choice === "cancel" ? [] : [["/Other"]]);
    expect(updateNote.mock.calls).toEqual(choice === "save" ? [["folder/P", "folder/P", "Work", "none"]] : []);
    if (choice === "cancel") expect(f.controller.currentBuffer()).toBe("Work");
  });
  it("a reverted dirty browser pop replaces its destination after explicit discard", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Work");
    f.router.push.mockClear(); f.location.hash = "";
    expect(await f.controller.gateNavigation(f.to())).toBe(false);
    f.controller.onSaveChoice("discard");
    expect(f.router.replace).toHaveBeenCalledWith("/Other"); expect(f.router.push).not.toHaveBeenCalled();
  });
  it("session decisions share one promise, cancel retains work, and disposal resolves cancel", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Work");
    const first = f.participant().requestDecision(); expect(f.participant().requestDecision()).toBe(first);
    f.controller.onSaveChoice("cancel"); expect(await first).toBe("cancel"); expect(f.controller.isDirty()).toBe(true);
    const second = f.participant().requestDecision(); f.controller.dispose(); expect(await second).toBe("cancel");
    expect(f.unregister).toHaveBeenCalled(); expect(f.preview.dispose).toHaveBeenCalled();
  });
  it("session discard restores acknowledged content before ending edit state", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Work");
    expect(f.participant().discard()).toBe(true);
    expect(f.port.setMarkdown).toHaveBeenCalledWith("Seed"); expect(f.controller.state.editMode).toBe(false);
    expect(f.adapters.publish).toHaveBeenCalledWith(TOPICS.NOTE_EDIT_END, { path: "folder/P" });
  });
  it("delete rechecks work that appeared after confirmation opened", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); await f.controller.deleteHandler();
    expect(f.controller.state.isDeleteModalVisible).toBe(true); f.input("New work");
    await f.controller.deleteConfirmedHandler(); expect(f.adapters.remove).not.toHaveBeenCalled();
  });
  it("delete publishes only after transport success and then leaves for home", async () => {
    const removed = deferred(), f = fixture({ remove: vi.fn(() => removed.promise) }); await f.controller.mount();
    const deleting = f.controller.deleteConfirmedHandler(); await flush();
    expect(f.adapters.publish).not.toHaveBeenCalledWith(TOPICS.NOTE_DELETE, expect.anything());
    removed.resolve({}); await deleting;
    expect(f.adapters.publish).toHaveBeenCalledWith(TOPICS.NOTE_DELETE, { path: "folder/P" });
    expect(f.router.push).toHaveBeenCalledWith({ name: "home" });
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ detail: "Note deleted ✓" }));
  });
  it("delete failure uses classified policy or the injected generic fallback", async () => {
    const f = fixture({ remove: vi.fn().mockRejectedValueOnce({ response: { data: { code: "operation_conflict", detail: "Conflict detail" } } }).mockRejectedValueOnce(Error("unmapped")) });
    await f.controller.mount(); await f.controller.deleteConfirmedHandler();
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Conflict", detail: "Conflict detail" }));
    await f.controller.deleteConfirmedHandler(); expect(f.adapters.failed).toHaveBeenCalledWith(Error("unmapped")); expect(f.router.push).not.toHaveBeenCalled();
  });
  it("modal-gated actions decline and subscriptions release at disposal", async () => {
    const f = fixture(); await f.controller.mount(); f.adapters.actionAvailable.mockReturnValue(false);
    for (const handler of f.handlers.values()) handler(); expect(f.controller.state.editMode).toBe(false);
    f.adapters.actionAvailable.mockReturnValue(true); f.handlers.get(TOPICS.EDITOR_TOGGLE_EDIT)();
    expect(f.controller.state.editMode).toBe(true); f.handlers.get(TOPICS.EDITOR_TOGGLE_SOURCE_MODE)();
    expect(f.controller.state.editorMode).toBe("wysiwyg");
    f.controller.dispose(); expect(f.handlers.size).toBe(0); expect(f.unsubs).toHaveLength(5);
  });
  it("wires its default load/delete/save transports without a view import", async () => {
    getNote.mockResolvedValue({ path: "folder/P", content: "Seed" }); deleteNote.mockResolvedValue({});
    updateNote.mockImplementation(async (source, path, content) => ({ path, content }));
    const f = fixture({ read: undefined, remove: undefined }); await f.controller.mount();
    expect(getNote).toHaveBeenCalledWith("folder/P"); f.enter(); f.input("Saved");
    f.controller.saveHandler(); await flush();
    expect(updateNote).toHaveBeenCalledWith("folder/P", "folder/P", "Saved", "none");
    expect(f.controller.isDirty()).toBe(false); expect(createNote).not.toHaveBeenCalled();
    await f.controller.deleteConfirmedHandler(); expect(deleteNote).toHaveBeenCalledWith("folder/P");
  });
  it("acknowledges its own caret URL write without selecting, but later history restores selection", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.location.hash = "#source";
    const target = f.to("folder/P", "#source:L3");
    f.router.replace.mockImplementation(async fullPath => {
      expect(fullPath).toBe(target.fullPath);
      expect(await f.controller.gateNavigation(target)).toBe(true);
      f.router.currentRoute.value.fullPath = fullPath;
    });
    f.controller.onSourceSelection({ from: 3, to: 3 });
    await vi.advanceTimersByTimeAsync(200);
    expect(f.router.replace).toHaveBeenCalledExactlyOnceWith(target.fullPath);
    expect(f.port.selectLine).not.toHaveBeenCalled();
    expect(await f.controller.gateNavigation(target)).toBe(true);
    expect(f.port.selectLine).toHaveBeenCalledExactlyOnceWith({ from: 3, to: 3 });
  });
  it("publishes mode and exit state before their own push guards without replaying effects", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.location.hash = "#source";
    f.router.push.mockImplementation(async fullPath => {
      const hash = fullPath.includes("#") ? fullPath.slice(fullPath.indexOf("#")) : "";
      expect(f.controller.state.editMode).toBe(!!hash);
      if (hash) expect(f.controller.state.editorMode).toBe("wysiwyg");
      expect(await f.controller.gateNavigation(f.to("folder/P", hash))).toBe(true);
      f.router.currentRoute.value.fullPath = fullPath;
      f.location.hash = hash;
    });
    f.controller.setEditorMode("wysiwyg"); await flush();
    expect(f.port.selectLine).not.toHaveBeenCalled();
    f.controller.toggleEditModeHandler(); await flush();
    expect(f.router.push).toHaveBeenLastCalledWith("/folder/P");
    expect(f.controller.state.editMode).toBe(false);
    expect(f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_EDIT_END)).toHaveLength(1);
  });
  it("dispose retires the pending caret URL write", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.location.hash = "#source";
    f.router.replace.mockClear(); f.router.push.mockClear();
    f.controller.onSourceSelection({ from: 3, to: 3 }); f.controller.dispose();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.router.replace).not.toHaveBeenCalled(); expect(f.router.push).not.toHaveBeenCalled();
  });
  it.each(["exit", "resource-reset"])("%s retires new-note title and draft timers", async ending => {
    const f = fixture({}, { path: undefined, query: { path: "Initial" } }); await f.controller.mount();
    f.controller.registerEditor(f.port); f.input("# Obsolete title");
    expect(vi.getTimerCount()).toBe(2);
    if (ending === "exit") f.participant().discard();
    else { f.context.path = "Latest"; await f.controller.init(); }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); expect(f.drafts.save).not.toHaveBeenCalled();
    expect(f.controller.state.editBasename).not.toBe("Obsolete title");
  });
  it.each(["exit", "mode-switch", "resource-reset"])("%s retires the pending preview timer", async ending => {
    const render = vi.fn(async () => "obsolete");
    const f = fixture({ previewFactory: options => createNotePreview({ ...options, render }) });
    await f.controller.mount(); f.enter(); f.controller.setEditorMode("preview"); f.controller.registerEditor(null);
    expect(vi.getTimerCount()).toBe(1);
    if (ending === "exit") f.participant().discard();
    else if (ending === "mode-switch") f.controller.setEditorMode("markdown");
    else { f.context.path = "Latest"; await f.controller.init(); }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(400); expect(render).not.toHaveBeenCalled();
  });
});
