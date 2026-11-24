import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isReadonly, reactive, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { heldOperation } from "../../tests/helpers/owned_operation.ts";
import { createIdentityNoteController, createNoteController } from "../noteController.js";
import { createIdentityAppSession } from "../appSession.js";
import { createVaultChanges } from "../vaultChanges.js";
import { createNotePreview } from "../notePreview.js";
import { createIdentityNoteDraftStore } from "../noteDrafts.js";
import { createNoteSaveOwner } from "../noteSaveOwner.js";
import { identitySessionKey } from "../appSessionPolicy.js";
import { TOPICS } from "../bus/index.js";
import { getNote, deleteNote, updateNote, createNote } from "../api.js";

vi.mock("../api.js", () => ({
  getNote: vi.fn(), deleteNote: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(),
  previewRename: vi.fn(async () => []), getNotes: vi.fn(async () => []),
  uploadFile: vi.fn(), renderBuffer: vi.fn(), apiErrorHandler: vi.fn(),
  getPluginHostCatalog: vi.fn(async () => ({ plugins: [] })), openPluginHostEvents: vi.fn(async () => () => {}),
}));
vi.mock("../noteIndex.js", () => ({ refreshNoteIndex: vi.fn() }));

const controllers = [];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); updateNote.mockReset(); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(overrides = {}, contextValues = {}) {
  const context = reactive({ path: "folder/P", query: {}, capabilities: { canEdit: true }, notePaths: ["b/B", "a/A", "Root", "b/C"], ...contextValues });
  const location = { pathname: "/folder/P", search: "", hash: "" };
  let afterEach;
  const router = { options: { history: { base: "" } }, currentRoute: { value: { fullPath: "/folder/P" } },
    afterEach: callback => { afterEach = callback; return () => { afterEach = undefined; }; },
    push: vi.fn(target => {
      if (typeof target === "string") {
        router.currentRoute.value.fullPath = target;
        location.hash = target.includes("#") ? target.slice(target.indexOf("#")) : "";
      }
    }), replace: vi.fn(async path => { router.currentRoute.value.fullPath = path; }) };
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
    // Change notices arrive through `subscribe`; the app's stream owner stays out.
    acquireChanges: vi.fn(() => vi.fn()),
    ...overrides,
  };
  const controller = (overrides.createController ?? createNoteController)(adapters);
  controllers.push(controller);
  let text = "Seed";
  const port = { getSnapshot: vi.fn(() => ({ ready: true, content: text })), getMarkdown: () => text,
    setMarkdown: vi.fn(value => { text = value; }), isWysiwygMode: () => false,
    applyAcknowledgement: vi.fn(value => { text = value; }), selectLine: vi.fn() };
  const enter = () => { controller.toggleEditModeHandler(); text = controller.state.editorInitialValue; controller.registerEditor(port); };
  const input = value => { text = value; controller.onEditorInput(); };
  const to = (path = "Other", hash = "") => ({ name: "note", params: { path }, query: {}, hash, fullPath: `/${path}${hash}` });
  return { controller, context, location, router, drafts, preview, adapters, port, enter, input, to,
    participant: () => participant, handlers, unsubs, unregister,
    commitRoute: target => { router.currentRoute.value = target; afterEach?.(target); },
    admitDeparture: target => router.push.mockImplementationOnce(async url => {
      expect(url).toBe(target.fullPath);
      expect(await controller.gateNavigation(target)).toBe(true);
      afterEach?.(target);
    }) };
}

describe("note workflow ownership", () => {
  const projection = (accountId = "alice", vaultId = "vault", sessionGeneration = "first") => ({
    principal: { kind: "account" }, accountId, vaultId, sessionGeneration, capabilities: { canEdit: true },
  });

  it.each(["Seed", "dirty text"])("a rename submitting %s does not claim an unrelated destination draft", async content => {
    const store = () => createIdentityNoteDraftStore({ prefix: "/rename", identity: projection,
      tokens: { isCurrentTokenStored: () => true } });
    store().save("folder/Destination", "unrelated draft", 1, "unrelated base");
    store().save("folder/P", "Seed", 1, "Seed");
    try {
      const f = fixture({ drafts: store() });
      await f.controller.mount(); f.controller.toggleEditModeHandler();
      f.controller.setDecisionVisible("draft", false); f.controller.setEditMode();
      f.controller.registerEditor(f.port);
      f.controller.setBasename("Destination"); f.controller.onTitleInput();
      if (content !== "Seed") { f.input(content); await vi.advanceTimersByTimeAsync(1000); }
      updateNote.mockResolvedValueOnce({ path: "folder/Destination", content });
      expect(f.controller.applyRename()).toBe(true);
      expect(await f.participant().settlePending()).toBe(true);
      const recovery = store();
      expect([recovery.load("folder/P", 0), recovery.load("folder/Destination", 0), recovery.base("folder/Destination")])
        .toEqual([null, "unrelated draft", "unrelated base"]);
      expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/Destination", content, "none", "Seed");
    } finally { localStorage.clear(); }
  });

  it("reports rejected draft storage while sending and acknowledging the live buffer", async () => {
    const quota = new DOMException("Storage is full", "QuotaExceededError");
    const drafts = { load: () => null, release() {}, base() {}, save: vi.fn(() => { throw quota; }),
      captureAcknowledgement: vi.fn(() => completeDraft), clear() {} };
    const completeDraft = vi.fn();
    const f = fixture({ drafts });
    await f.controller.mount(); f.enter(); f.input("live edit");
    updateNote.mockResolvedValueOnce({ path: "folder/P", content: "live edit" });
    const receipt = f.controller.saveHandler();
    expect(await receipt.completion).toMatchObject({ status: "acknowledged" });
    expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/P", "live edit", "none", "Seed");
    expect(completeDraft).toHaveBeenCalledExactlyOnceWith();
    expect(f.adapters.toast.add.mock.calls.map(([toast]) => toast.summary)).toEqual(["Local draft unavailable"]);
  });

  it.each([true, false])("only an accepted renewal of the same note scope resumes a pre-write 401 (same scope: %s)", async sameScope => {
    const current = ref(projection()), valid = ref(true), login = deferred();
    const sessionKey = () => valid.value ? identitySessionKey(current.value) : null;
    const requestAuthentication = vi.fn(() => login.promise);
    const f = fixture({ sessionKey, saveOwnerFactory: adapters => createNoteSaveOwner({ ...adapters, requestAuthentication }) }, projection());
    await f.controller.mount(); f.enter(); f.input("first");
    updateNote.mockImplementationOnce(async () => {
      valid.value = false;
      throw { response: { status: 401, data: { code: "credentials_refused" } } };
    }).mockResolvedValueOnce({ path: "folder/P", content: "first" });
    const receipt = f.controller.saveHandler();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAuthentication).toHaveBeenCalledExactlyOnceWith();
    f.input("newer typing");
    current.value = projection("alice", sameScope ? "vault" : "another-vault", "renewed");
    Object.assign(f.context, current.value); valid.value = true;
    login.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    const call = ["folder/P", "folder/P", "first", "none", "Seed"];
    expect(updateNote.mock.calls).toEqual(sameScope ? [call, call] : [call]);
    expect(f.controller.currentBuffer()).toBe("newer typing");
    if (sameScope) {
      expect(await receipt.completion).toMatchObject({ status: "acknowledged" });
      expect(f.controller.state.canModify).toBe(true);
    } else {
      expect(f.controller.state.canModify).toBe(false);
    }
  });

  it.each(["renewed Edit", "renewed View", "foreign vault"])("a Save during the reauthentication gap remains local until %s", async renewal => {
    const current = ref(projection()), live = ref(true), login = deferred();
    const sessionKey = () => live.value ? identitySessionKey(current.value) : null;
    const requestAuthentication = vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(login.promise);
    const f = fixture({ sessionKey, requestAuthentication }, projection());
    await f.controller.mount(); f.enter(); f.input("first");
    updateNote.mockImplementationOnce(async () => {
      live.value = false;
      f.context.capabilities.canEdit = false;
      throw { response: { status: 401, data: { code: "credentials_refused" } } };
    }).mockResolvedValueOnce({ path: "folder/P", content: "first" })
      .mockResolvedValueOnce({ path: "folder/P", content: "second" });
    const first = f.controller.saveHandler();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAuthentication).toHaveBeenCalledTimes(1);
    expect(f.controller.state.canModify).toBe(false);
    f.input("second");
    const second = f.controller.saveHandler();
    expect(second).toMatchObject({ held: true });
    f.input("third, not submitted");
    await vi.advanceTimersByTimeAsync(0);
    const initial = ["folder/P", "folder/P", "first", "none", "Seed"];
    expect(updateNote.mock.calls).toEqual([initial]);
    expect(requestAuthentication).toHaveBeenCalledTimes(2);
    const restored = projection("alice", renewal === "foreign vault" ? "foreign" : "vault", "renewed");
    restored.capabilities.canEdit = renewal !== "renewed View";
    Object.assign(f.context, restored); current.value = restored; live.value = true; login.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    if (renewal === "renewed Edit") {
      expect(updateNote.mock.calls).toEqual([initial, initial, ["folder/P", "folder/P", "second", "none", "first"]]);
      expect(await first.completion).toMatchObject({ status: "acknowledged" });
      expect(await second.completion).toMatchObject({ status: "acknowledged" });
    } else expect(updateNote.mock.calls).toEqual([initial]);
    expect(f.controller.currentBuffer()).toBe("third, not submitted");
  });

  it("conflict copy metadata is reachable only within its originating account and vault", async () => {
    const f = fixture({}, projection());
    await f.controller.mount(); f.enter(); f.input("conflicting edit");
    const path = "folder/Conflict-copy";
    updateNote.mockResolvedValueOnce({ path, content: "conflicting edit", saveResult: { status: "conflict" } });
    expect(await f.controller.saveHandler().completion).toMatchObject({ status: "acknowledged" });
    const delivered = [];
    for (const identity of [projection("bob"), projection("alice", "another-vault"), projection("alice", "vault", "renewed")]) {
      const copy = fixture({}, { ...identity, path });
      await copy.controller.mount(); copy.controller.openConflictOriginal();
      delivered.push([copy.controller.state.conflictOriginal, copy.router.push.mock.calls]);
    }
    expect(delivered).toEqual([["", []], ["", []], ["folder/P", [[{ path: "/folder/P", hash: "" }]]]]);
  });

  it("does not read or replace Alice's clean editor on Bob's vault reset", async () => {
    const identity = ref("alice");
    const read = vi.fn(async path => ({ path, content: identity.value, version: identity.value }));
    const f = fixture({ sessionKey: () => identity.value, read });
    await f.controller.mount(); f.enter(); identity.value = "bob";
    await f.handlers.get(TOPICS.VAULT_RESET)({ next: 1 });
    expect([read.mock.calls, f.controller.currentBuffer(), f.controller.state.note.version]).toEqual([[["folder/P"]], "alice", "alice"]);
  });
  it("reloads an unchanged reader route when a new session arrives", async () => {
    const identity = ref("alice"), read = vi.fn(async path => ({ path, content: `# ${identity.value}` }));
    const delivered = deferred();
    const f = fixture({ sessionKey: () => identity.value, read,
      publish: (topic, value) => { if (topic === TOPICS.NOTE_TITLE_CHANGED && value.title === "bob") delivered.resolve(); } });
    await f.controller.mount(); identity.value = "bob";
    await delivered.promise;
    expect([read.mock.calls, f.controller.state.loadStatus, f.controller.state.note.content]).toEqual([[["folder/P"], ["folder/P"]], "loaded", "# bob"]);
  });
  it("resumes the surviving remembered draft against its original conflict base", async () => {
    let remembered = true;
    const makeDrafts = () => createIdentityNoteDraftStore({ prefix: "/draft-base", identity: () => ({
      principal: { kind: "account" }, accountId: "alice", vaultId: "vault",
    }), tokens: { isCurrentTokenStored: () => remembered } });
    try {
      makeDrafts().save("folder/P", "remembered edit", 1, "original base");
      remembered = false;
      makeDrafts().save("folder/P", "closed tab edit", 1, "original base");
      sessionStorage.clear();
      const f = fixture({ drafts: makeDrafts() });
      await f.controller.mount(); f.controller.toggleEditModeHandler();
      expect(f.controller.state.isDraftModalVisible).toBe(true);
      f.controller.setEditMode();
      expect(f.controller.state.editorInitialValue).toBe("remembered edit");
      updateNote.mockResolvedValueOnce({ path: "folder/P", content: "saved merge" });
      const receipt = f.controller.saveHandler();
      expect(await receipt.completion).toMatchObject({ status: "acknowledged" });
      expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/P", "remembered edit", "none", "original base");
      expect(makeDrafts().load("folder/P", 0)).toBeNull();
    } finally { localStorage.clear(); sessionStorage.clear(); }
  });
  it("sends the version displayed when deletion was confirmed even after a reset", async () => {
    const read = vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "A", version: "v1" })
      .mockResolvedValueOnce({ path: "folder/P", content: "B", version: "v2" });
    const f = fixture({ read });
    await f.controller.mount(); await f.controller.deleteHandler();
    await f.handlers.get(TOPICS.VAULT_RESET)({ next: 1 });
    expect(f.controller.state.note.version).toBe("v2");
    await f.controller.deleteConfirmedHandler();
    expect(f.adapters.remove).toHaveBeenCalledExactlyOnceWith("folder/P", "v1");
  });
  it("publishes editor entry and exit only after the router commits them", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/:path(.*)", name: "note", component: {} },
    ] });
    await router.push("/folder/P");
    const f = fixture({ router, getLocation: () => ({ pathname: router.currentRoute.value.path, search: "", hash: router.currentRoute.value.hash }) });
    await f.controller.mount();
    let hold = deferred(), entered = deferred();
    router.beforeEach(async to => { entered.resolve(to.fullPath); return await hold.promise; });
    router.beforeResolve(f.controller.gateNavigation);
    const entering = f.controller.toggleEditModeHandler();
    expect(await entered.promise).toBe("/folder/P#source");
    try {
      expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual(["/folder/P", false]);
    } finally { hold.resolve(true); await entering; }
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual(["/folder/P#source", true]);
    hold = deferred(); entered = deferred();
    const exiting = f.controller.toggleEditModeHandler();
    expect(await entered.promise).toBe("/folder/P");
    try {
      expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual(["/folder/P#source", true]);
    } finally { hold.resolve(false); await exiting; }
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual(["/folder/P#source", true]);
    hold = deferred(); entered = deferred();
    const retry = f.controller.toggleEditModeHandler();
    expect(await entered.promise).toBe("/folder/P");
    hold.resolve(true); await retry;
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual(["/folder/P", false]);
  });
  it.each(["entry", "history", "mode"])("retired Edit admission cannot commit the %s fragment", async intent => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:path(.*)", name: "note", component: {} }] });
    const from = intent === "mode" ? "/folder/P#source" : "/folder/P";
    await router.push(from);
    const location = () => ({ pathname: router.currentRoute.value.path, search: "", hash: router.currentRoute.value.hash });
    const f = fixture({ router, getLocation: location });
    await f.controller.mount();
    const entered = deferred(), hold = deferred();
    router.beforeEach(f.controller.gateNavigation);
    router.beforeEach(to => { entered.resolve(to.fullPath); return hold.promise; });
    const navigation = intent === "entry" ? f.controller.toggleEditModeHandler()
      : intent === "mode" ? f.controller.setEditorMode("wysiwyg") : router.push("/folder/P#edit");
    try {
      expect(await entered.promise).toBe(intent === "entry" ? "/folder/P#source" : "/folder/P#edit");
      f.context.capabilities.canEdit = false;
    } finally { hold.resolve(true); await navigation; }
    expect(router.currentRoute.value.fullPath).toBe(from);
    expect(f.controller.state.editMode).toBe(intent === "mode");
    if (intent === "mode") expect(f.controller.state.editorMode).toBe("markdown");
  });
  it("Save and Close retains the acknowledged editor when the viewer route is refused", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:path(.*)", name: "note", component: {} }] });
    await router.push("/folder/P#source");
    const location = () => ({ pathname: router.currentRoute.value.path, search: "", hash: router.currentRoute.value.hash });
    const f = fixture({ router, getLocation: location });
    await f.controller.mount(); f.controller.registerEditor(f.port); f.input("Saved content");
    updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Saved content" });
    const hold = deferred(), entered = deferred();
    router.beforeEach(f.controller.gateNavigation);
    const stop = router.beforeEach(to => { entered.resolve(to.fullPath); return hold.promise; });
    const exit = f.controller.saveHandler(true);
    try {
      expect(await entered.promise).toBe("/folder/P");
      expect([f.controller.state.editMode, f.controller.isDirty()]).toEqual([true, false]);
    } finally { hold.resolve(false); await exit; stop(); }
    expect(await exit).toBe(false);
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode, f.controller.currentBuffer()])
      .toEqual(["/folder/P#source", true, "Saved content"]);
    expect(await f.controller.toggleEditModeHandler()).toBe(true);
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual(["/folder/P", false]);
    expect(updateNote).toHaveBeenCalledOnce();
  });
  it("does not apply an admitted history effect if a later guard rejects it", async () => {
    const route = "/folder/P";
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/:path(.*)", name: "note", component: {} },
    ] });
    await router.push(route);
    const f = fixture({ router, getLocation: () => ({ pathname: router.currentRoute.value.path, search: "", hash: router.currentRoute.value.hash }) });
    await f.controller.mount();
    router.beforeEach(f.controller.gateNavigation);
    const entered = deferred(), hold = deferred();
    const removeGuard = router.beforeResolve(to => { entered.resolve(to.fullPath); return hold.promise; });
    const opening = router.push(route + "#edit");
    expect(await entered.promise).toBe(route + "#edit");
    try {
      expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual([route, false]);
    } finally { hold.resolve(false); await opening; removeGuard(); }
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode]).toEqual([route, false]);
    await router.push(route + "#edit");
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode, f.controller.state.editorMode]).toEqual([route + "#edit", true, "wysiwyg"]);
  });
  it.each(["clean", "discarded"])("typing during admission cancels a %s editor departure", async status => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", name: "home", component: {} }, { path: "/:path(.*)", name: "note", component: {} },
    ] });
    await router.push("/folder/P#source");
    const location = () => ({ pathname: router.currentRoute.value.path, search: "", hash: router.currentRoute.value.hash });
    const f = fixture({ router, getLocation: location });
    await f.controller.mount(); f.controller.registerEditor(f.port);
    router.beforeEach(f.controller.gateNavigation);
    const hold = deferred(), entered = deferred();
    router.beforeEach(to => { if (to.name === "home") { entered.resolve(to.fullPath); return hold.promise; } });
    let departure;
    if (status === "discarded") {
      f.input("Original draft"); await router.push("/");
      expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
      const after = deferred(), stop = router.afterEach((to, _, failure) => { if (to.name === "home") after.resolve(failure); });
      f.controller.onSaveChoice("discard"); departure = after.promise.finally(stop);
    } else departure = router.push("/");
    try {
      expect(await entered.promise).toBe("/");
      f.input("New input while the router is waiting");
    } finally { hold.resolve(true); }
    expect(await departure).toBeTruthy();
    expect([router.currentRoute.value.fullPath, f.controller.state.editMode, f.controller.currentBuffer(), f.controller.isDirty()])
      .toEqual(["/folder/P#source", true, "New input while the router is waiting", true]);
  });
  it("leaves a discarded unsaved new note without a second decision", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", name: "home", component: {} }, { path: "/_/new", name: "new", component: {} },
    ] });
    await router.push("/_/new");
    const f = fixture({ router }, { path: undefined, query: {} });
    await f.controller.mount(); f.controller.registerEditor(f.port); f.input("Unsaved");
    router.beforeEach(f.controller.gateNavigation);
    const closing = f.controller.toggleEditModeHandler();
    await flush(); expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
    f.controller.onSaveChoice("discard"); await closing;
    expect([router.currentRoute.value.name, f.controller.state.editMode, f.controller.state.isSaveChangesModalVisible, f.controller.isDirty()])
      .toEqual(["home", false, false, false]);
  });
  it("a clean identity reader hands off from guest to account and rereads under that owner", async () => {
    vi.useRealTimers();
    const config = ref({ principal: { kind: "guest" }, accountId: null, vaultId: "vault", sessionGeneration: "guest", authorityRevision: 0, capabilities: { canRead: true, canEdit: false } });
    const session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; },
      tokens: { getStoredToken: () => null, isCurrentTokenStored: () => false }, transport: {}, stopRuntime() {}, applyBrand() {} });
    session.adopt(config.value);
    const read = vi.fn(async path => ({ path, content: config.value.accountId ? "Account note" : "Public note" }));
    const f = fixture({ createController: adapters => createIdentityNoteController({ session, ...adapters }), read,
      getContext: () => ({ path: "folder/P", query: {}, notePaths: [], capabilities: config.value.capabilities }) });
    try {
      await f.controller.mount(); expect(f.controller.state.note.content).toBe("Public note");
      expect(session.adopt({ ...config.value, principal: { kind: "account", id: "alice", login: "alice" }, accountId: "alice", sessionGeneration: "alice", capabilities: { canRead: true, canEdit: true } })).toBe(true);
      await vi.waitFor(() => expect([f.controller.state.loadStatus, f.controller.state.note.content]).toEqual(["loaded", "Account note"]));
      expect([read.mock.calls, f.controller.state.canModify, f.controller.state.editMode]).toEqual([[["folder/P"], ["folder/P"]], true, false]);
    } finally { await f.controller.dispose(); await session.dispose(); }
  });
  it.each(["same-account", "different-account"])("identity reader retains the exact dirty editor through %s recovery", async mode => {
    const initial = { principal: { kind: "account", id: "alice", login: "alice" }, accountId: "alice", vaultId: "vault", sessionGeneration: "alice", authorityRevision: 0, capabilities: { canRead: true, canEdit: true } };
    const config = ref(initial), prefix = "/identity-note-test";
    const storage = (map = new Map()) => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
    const draftAdapters = { local: storage(), session: storage() };
    let token = "alice-token";
    const session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; },
      tokens: { getStoredToken: () => token, storeToken: value => { token = value; }, isCurrentTokenStored: () => false }, transport: {}, stopRuntime() {}, applyBrand() {} });
    session.adopt(config.value);
    const f = fixture({ createController: adapters => createIdentityNoteController({ session, prefix, draftAdapters, ...adapters }),
      getContext: () => ({ path: "folder/P", query: {}, notePaths: [], capabilities: config.value.capabilities }) });
    const drafts = createIdentityNoteDraftStore({ prefix, identity: () => initial, tokens: session.tokens, ...draftAdapters });
    try {
      await f.controller.mount(); f.enter(); f.input("Alice retained typing");
      f.participant().retainForAuthentication();
      expect(drafts.load("folder/P", 0)).toBe("Alice retained typing");
      const sameAccount = mode === "same-account", login = sameAccount ? "alice" : "bob";
      expect(session.acceptToken(`${login}-renewed-token`, false)).toBe(true);
      expect([f.controller.currentBuffer(), f.controller.state.canModify, f.controller.state.editMode]).toEqual(["Alice retained typing", false, true]);
      expect(session.adopt({ ...config.value, principal: { kind: "account", id: login, login }, accountId: login, sessionGeneration: "renewed" })).toBe(sameAccount);
      expect([f.controller.currentBuffer(), f.controller.state.canModify, f.controller.state.editMode, f.controller.state.editorReadOnly, f.adapters.read.mock.calls])
        .toEqual(["Alice retained typing", sameAccount, true, !sameAccount, [["folder/P"]]]);
      expect(drafts.load("folder/P", 0)).toBe("Alice retained typing");
    } finally { await f.controller.dispose(); await session.dispose(); }
  });
  it.each(["before", "after", "queued", "replacement", "disposed"])("a held save keeps its original owner across session renewal (%s)", async order => {
    vi.useRealTimers();
    const config = ref({ principal: { kind: "account", id: "alice", login: "alice" }, accountId: "alice", vaultId: "vault", sessionGeneration: "alice", authorityRevision: 0,
      capabilities: { canRead: true, canEdit: true } });
    const session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; },
      tokens: { getStoredToken: () => "alice-token", isCurrentTokenStored: () => false }, transport: {}, stopRuntime() {}, applyBrand() {} });
    session.adopt(config.value);
    let hold, owner;
    const update = vi.fn().mockImplementationOnce(async () => { await hold(); return { path: "folder/P", content: "saved first" }; })
      .mockImplementation(async (_source, path, content) => ({ path, content }));
    const f = fixture({ createController: adapters => createIdentityNoteController({ session, prefix: `/held-save-renewal/${order}`, ...adapters }),
      getContext: () => ({ path: "folder/P", query: {}, capabilities: config.value.capabilities }),
      saveOwnerFactory: options => (owner = createNoteSaveOwner({ ...options, update })) });
    try {
      await f.controller.mount(); f.enter(); f.input("first");
      await heldOperation({ label: "original save", owner: () => f.controller, progress: { kind: "controlled", clock: "external" } },
        boundary => { hold = boundary; return f.controller.saveHandler().completion; }, async save => {
          await save.reached(); f.input("newer typing");
          const queued = order === "queued" || order === "replacement" ? f.controller.saveHandler() : null;
          const renewed = { ...config.value, sessionGeneration: "renewed" };
          const saveFacts = () => f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_SAVE);
          if (order !== "after") {
            session.invalidate(); save.release();
            await vi.waitFor(() => expect(owner.queueState().acknowledged?.content).toBe("saved first"));
            expect([f.controller.state.canModify, f.controller.state.note.content, f.controller.currentBuffer(), saveFacts()])
              .toEqual([false, "Seed", "newer typing", []]);
            expect(owner.queueState().active?.phase).toBe("acknowledging");
          }
          if (order === "disposed") {
            await f.controller.dispose();
            expect(await save.result()).toEqual({ status: "disposed", safe: false });
            expect(session.adopt(renewed)).toBe(true);
            expect([f.controller.state.note.content, saveFacts()]).toEqual(["Seed", []]);
            return;
          }
          if (order === "replacement") {
            expect(session.adopt({ ...renewed, principal: { kind: "account", id: "bob", login: "bob" }, accountId: "bob" })).toBe(false);
            expect(await save.result()).toMatchObject({ status: "acknowledged" });
            expect([f.controller.state.editorReadOnly, f.controller.state.note.content, f.controller.currentBuffer(), f.controller.saveHandler(), saveFacts(), update.mock.calls])
              .toEqual([true, "Seed", "newer typing", null, [], [["folder/P", "folder/P", "first", "none", "Seed"]]]);
            return;
          }
          expect(session.adopt(renewed)).toBe(true);
          expect(await save.result()).toMatchObject({ status: "acknowledged" });
          if (!queued) {
            expect([f.controller.state.canModify, f.controller.state.note.content, f.controller.currentBuffer(), f.controller.isDirty()])
              .toEqual([true, "saved first", "newer typing", true]);
          }
          expect(await (queued ?? f.controller.saveHandler()).completion).toMatchObject({ status: "acknowledged" });
          expect([f.controller.state.note.content, update.mock.calls]).toEqual(["newer typing", [
            ["folder/P", "folder/P", "first", "none", "Seed"], ["folder/P", "folder/P", "newer typing", "none", "saved first"],
          ]]);
        });
    } finally { await f.controller.dispose(); await session.dispose(); }
  });
  it("the same dirty note survives actual session outage and held reconnect revalidation", async () => {
    vi.useRealTimers();
    const config = ref({ principal: { kind: "account", id: "alice", login: "alice" }, accountId: "alice", vaultId: "vault", sessionGeneration: "alice", authorityRevision: 0, capabilities: { canRead: true, canEdit: true } });
    const restored = { ...config.value }, originalProjection = identitySessionKey(restored); let session, hold, reads = 0;
    const changes = createVaultChanges({ sessionKey: () => session.key() });
    session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; },
      tokens: { getStoredToken: () => "alice-token", isCurrentTokenStored: () => false }, transport: { getConfig: async () => {
        if (reads++ === 0) throw Object.assign(new Error("restart"), { status: 503 }); await hold(); return restored;
      } }, stopRuntime() {}, applyBrand() {}, setChangesSession: changes.setSession, recover: changes.revalidate });
    session.adopt(config.value);
    const originalKey = session.key(), originalAuthority = session.capture();
    const f = fixture({ createController: adapters => createIdentityNoteController({ session, ...adapters }),
      getContext: () => ({ path: "folder/P", query: {}, notePaths: [], capabilities: config.value.capabilities }) });
    try {
      await f.controller.mount(); f.enter(); f.input("Retained through restart");
      await heldOperation({ label: "dirty note recovery", owner: () => session, progress: { kind: "controlled", clock: "external" } }, boundary => {
        hold = boundary; return session.refresh().then(async result => { await changes.settle(); return result; });
      }, async work => {
        await work.reached(); expect([session.state.valid, f.controller.currentBuffer(), f.controller.state.editMode, f.controller.state.canModify]).toEqual([false, "Retained through restart", true, false]);
        expect(await work.result()).toBe(false);
        expect([session.state.valid, f.controller.currentBuffer(), f.controller.state.editMode, f.controller.state.canModify, f.controller.isDirty(), f.adapters.read.mock.calls]).toEqual([true, "Retained through restart", true, true, true, [["folder/P"]]]);
        // Cutover includes the local projection lifetime in the live key.
        expect([identitySessionKey(session.snapshot()), session.key() === originalKey, originalAuthority()])
          .toEqual([originalProjection, false, false]);
        updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Retained through restart" });
        expect(await f.controller.saveHandler().completion).toMatchObject({ status: "acknowledged" });
        expect(updateNote.mock.calls).toEqual([["folder/P", "folder/P", "Retained through restart", "none", "Seed"]]);
      });
    } finally { await f.controller.dispose(); await session.dispose(); await changes.dispose(); }
  });
  it("identity invalidation retains the original dirty editor and cannot borrow Bob's Edit", async () => {
    const identity = ref("alice");
    const f = fixture({ sessionKey: () => identity.value }, { capabilities: { canEdit: true } });
    await f.controller.mount(); f.enter(); f.input("Alice retained typing"); identity.value = "bob";
    expect([f.controller.currentBuffer(), f.controller.isDirty(), f.controller.state.canModify]).toEqual(["Alice retained typing", true, false]);
    await f.controller.init(); expect(f.adapters.read).toHaveBeenCalledTimes(1);
    const receipt = f.controller.saveHandler(); if (receipt) await receipt.completion;
    expect(updateNote).not.toHaveBeenCalled(); expect(f.controller.state.editMode).toBe(true); expect(f.drafts.clear).not.toHaveBeenCalled();
  });
  it("a retired identity's original read cannot repopulate the current note view", async () => {
    vi.useRealTimers();
    const identity = ref("alice"); let hold;
    const read = vi.fn(async path => ({ path, content: "Bob replacement" })).mockImplementationOnce(async () => {
      await hold(); return { path: "folder/P", content: "Alice private" };
    });
    const f = fixture({ sessionKey: () => identity.value, read });
    await heldOperation({ label: "original note read", owner: () => f.controller, progress: { kind: "controlled", clock: "external" } }, boundary => { hold = boundary; return f.controller.mount(); }, async work => {
      await work.reached(); identity.value = "bob"; await work.result();
      expect([f.controller.state.note.content, f.controller.state.canModify]).toEqual(["Bob replacement", true]);
    });
  });
  it("Review conflict uses the shared copy lookup and ordinary dirty departure protection", async () => {
    const lookupByMember = vi.fn(() => ({ id: "conflict-a" }));
    const f = fixture({ conflictInbox: { lookupByMember } }); await f.controller.mount(); f.enter(); f.input("Keep my typing");
    f.controller.reviewConflict();
    expect(lookupByMember).toHaveBeenCalledWith("folder/P.md", "copyPath");
    expect(f.router.push).toHaveBeenLastCalledWith({ name: "conflict", params: { id: "conflict-a" } });
    const target = { name: "conflict", params: { id: "conflict-a" }, query: {}, hash: "", fullPath: "/_/conflicts/conflict-a" };
    expect(await f.controller.gateNavigation(target)).toBe(false); expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
    f.controller.onSaveChoice("cancel"); expect(f.controller.currentBuffer()).toBe("Keep my typing"); expect(f.controller.isDirty()).toBe(true);
    lookupByMember.mockReturnValue(null); f.controller.reviewConflict();
    expect(f.router.push).toHaveBeenLastCalledWith({ name: "conflicts" });
  });
  it.each(["change", "reset"])("an initial read cannot swallow an earlier stream %s", async event => {
    const initial = deferred();
    const f = fixture({ read: vi.fn().mockReturnValueOnce(initial.promise)
      .mockResolvedValue({ path: "folder/P", content: "Elsewhere", version: "v2" }) });
    const loading = f.controller.mount();
    if (event === "change") f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    else f.handlers.get(TOPICS.VAULT_RESET)({ next: 10 });
    initial.resolve({ path: "folder/P", content: "Seed", version: "v1" }); await loading; await flush();
    expect(f.controller.state.note.content).toBe("Elsewhere"); expect(f.adapters.read).toHaveBeenCalledTimes(2);
  });
  it.each(["reset", "created", "deleted", "renamed"].flatMap(event => [false, true].map(dirty => [event, dirty])))
    ("an uncreated note has no vault identity for %s (dirty=%s)", async (event, dirty) => {
      const read = vi.fn().mockRejectedValue({ response: { status: 404 } });
      // An explicit requested name may already belong to somebody else's file.
      const f = fixture({ read }, { path: undefined, query: { path: "Proposed" } });
      await f.controller.mount(); f.controller.registerEditor(f.port);
      f.input(dirty ? "My new text" : "");
      if (event === "reset") await f.handlers.get(TOPICS.VAULT_RESET)({ next: 10 });
      else await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: event === "renamed" ? "Other.md" : "Proposed.md",
        oldPath: event === "renamed" ? "Proposed.md" : undefined, kind: event, hash: "v2" });
      await flush();
      expect(f.adapters.read).not.toHaveBeenCalled();
      expect(f.controller.state.vaultNotice).toBe("");
      expect(f.controller.state.isNoteNotFound).toBe(false);
      expect(f.controller.currentBuffer()).toBe(dirty ? "My new text" : "");
      expect(f.controller.state.note.path).toBe("Proposed");
    });
  it("creation acknowledgement, not the requested name or route update, admits vault observation", async () => {
    const wire = deferred(); createNote.mockReturnValueOnce(wire.promise);
    const read = vi.fn().mockRejectedValue({ response: { status: 404 } });
    const f = fixture({ read }, { path: undefined, query: { path: "Proposed" } });
    await f.controller.mount(); f.controller.registerEditor(f.port); f.input("Mine");
    f.controller.saveHandler(); await flush();
    await f.handlers.get(TOPICS.VAULT_RESET)({ next: 10 });
    expect(read).not.toHaveBeenCalled(); expect(f.controller.state.vaultNotice).toBe("");
    wire.resolve({ path: "Created", content: "Mine", version: "v1" }); await flush();
    // Simulate the prop update lagging the save's canonical URL integration.
    expect(f.controller.state.isNewNote).toBe(true);
    expect(f.controller.state.note.path).toBe("Created");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "Proposed.md", kind: "deleted" });
    expect(f.controller.state.vaultNotice).toBe("");
    await f.handlers.get(TOPICS.VAULT_RESET)({ next: 11 });
    expect(read).toHaveBeenCalledExactlyOnceWith("Created");
    expect(f.controller.state.vaultNotice).toContain("saving will re-create it");
    expect(f.controller.currentBuffer()).toBe("Mine");
  });
  it.each(["view", "clean", "dirty"])("external changes refresh or retain the open note (%s)", async mode => {
    const f = fixture({ read: vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" })
      .mockResolvedValue({ path: "folder/P", content: "Elsewhere", version: "v2" }) });
    await f.controller.mount();
    if (mode !== "view") f.enter();
    if (mode === "dirty") f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2", peer: "local" }); await flush();
    if (mode === "dirty") {
      expect(f.controller.currentBuffer()).toBe("Mine");
      expect(f.controller.state.vaultNotice).toContain("will be merged");
      expect(f.adapters.read).toHaveBeenCalledTimes(1);
    } else {
      expect(f.controller.state.note.content).toBe("Elsewhere");
      expect(f.controller.state.vaultNotice).toBe("");
      expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ detail: "Updated with changes from elsewhere", severity: "info" }));
      if (mode === "clean") {
        expect(f.controller.currentBuffer()).toBe("Elsewhere"); expect(f.controller.isDirty()).toBe(false);
        f.input("Next"); updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Next", version: "v3" });
        f.controller.saveHandler(); await flush(); expect(updateNote.mock.calls.at(-1)[4]).toBe("Elsewhere");
      }
    }
  });
  it("ignores own versions and fences external reads against typing", async () => {
    const slow = deferred();
    const f = fixture({ read: vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" }).mockReturnValueOnce(slow.promise) });
    await f.controller.mount(); f.enter();
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v1" });
    expect(f.adapters.read).toHaveBeenCalledTimes(1); expect(f.controller.state.vaultNotice).toBe("");
    const reading = f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    f.input("Mine"); slow.resolve({ path: "folder/P", content: "Elsewhere", version: "v2" }); await reading;
    expect(f.controller.currentBuffer()).toBe("Mine"); expect(f.controller.state.note.version).toBe("v1");
    expect(f.controller.state.vaultNotice).toContain("will be merged");
  });
  it("defers a save's early stream echo until its acknowledged version can identify it", async () => {
    const wire = deferred(), f = fixture({ read: vi.fn(async () => ({ path: "folder/P", content: "Seed", version: "v1" })) });
    updateNote.mockReturnValueOnce(wire.promise);
    await f.controller.mount(); f.enter(); f.input("A"); f.controller.saveHandler(); await flush();
    f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    wire.resolve({ path: "folder/P", content: "A", version: "v2", saveResult: { status: "saved" } }); await flush();
    expect(f.controller.state.vaultNotice).toBe(""); expect(f.adapters.read).toHaveBeenCalledTimes(1);
    expect(f.controller.isDirty()).toBe(false);
  });
  it("a recreation with identical bytes clears a deleted viewing snapshot", async () => {
    const f = fixture({ read: vi.fn(async () => ({ path: "folder/P", content: "Seed", version: "v1" })) });
    await f.controller.mount();
    f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "deleted" });
    expect(f.controller.state.isNoteNotFound).toBe(true);
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "created", hash: "v1" });
    expect(f.controller.state.isNoteNotFound).toBe(false); expect(f.controller.state.vaultNotice).toBe("");
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ detail: "Updated with changes from elsewhere", severity: "info" }));
  });
  it.each(["view", "clean", "dirty"])("deletion and rename-away retain the right protections (%s)", async mode => {
    const f = fixture(); await f.controller.mount();
    if (mode !== "view") f.enter(); if (mode === "dirty") f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "Elsewhere.md", oldPath: "folder/P.md", kind: "renamed" });
    expect(f.controller.state.isNoteNotFound).toBe(mode === "view");
    expect(f.controller.state.vaultNotice).toBe(mode === "view" ? "This note was deleted elsewhere" : "Deleted elsewhere - saving will re-create it");
    expect(f.controller.state.saveFeedback).toBe(f.controller.state.vaultNotice);
    if (mode !== "view") {
      updateNote.mockResolvedValueOnce({ path: "folder/P", content: mode === "dirty" ? "Mine" : "Seed", version: "recreated", saveResult: { status: "saved", recreated: true } });
      f.controller.saveHandler(); await flush();
      expect(updateNote.mock.calls.at(-1)[4]).toBe("Seed");
      expect(f.controller.state.vaultNotice).toBe("");
      expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ detail: "'folder/P' was deleted elsewhere; your save re-created it", severity: "success" }));
    }
  });
  it("persistent external state is exposed in the save-status snapshot, not a toast", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    expect(f.controller.state.saveFeedback).toBe("This note changed elsewhere. Your changes will be merged when you save.");
    expect(f.adapters.toast.add).not.toHaveBeenCalled();
  });
  it("discard retires the merge promise on every edit exit but preserves external deletion", async () => {
    for (const deleted of [true, false]) for (const exit of ["session", "close", "navigation"]) {
      const f = fixture(); await f.controller.mount(); f.enter(); f.input("Mine");
      await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: deleted ? "deleted" : "modified", hash: "v2" });
      const notice = deleted ? "Deleted elsewhere - saving will re-create it" : "This note changed elsewhere. Your changes will be merged when you save.";
      expect(f.controller.state.saveFeedback).toBe(notice);
      if (exit === "session") expect(f.participant().discard()).toBe(true);
      else if (exit === "navigation") {
        const target = f.to();
        expect(await f.controller.gateNavigation(target)).toBe(false);
        f.admitDeparture(target);
        f.controller.onSaveChoice("discard");
        await flush();
      } else {
        f.controller.toggleEditModeHandler(); await flush();
        f.controller.onSaveChoice("discard"); await flush();
      }
      expect(f.controller.state.editMode).toBe(false);
      await flush();
      expect(f.controller.currentBuffer()).toBe("Seed");
      expect(f.controller.state.saveFeedback).toBe(deleted ? notice : "");
      expect(f.controller.state.vaultNotice).toBe(deleted ? notice : "");
      f.enter();
      expect(f.controller.state.saveFeedback).toBe(deleted ? notice : "");
      if (deleted) {
        updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Seed", saveResult: { status: "saved", recreated: true } });
        f.controller.saveHandler(); await flush();
        expect(updateNote).toHaveBeenLastCalledWith("folder/P", "folder/P", "Seed", "none", "Seed");
      }
    }
  });
  it.each(["discard", "revert"])("reloads pending external content when %s makes the note clean", async action => {
    const disk = deferred();
    const read = vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" }).mockReturnValueOnce(disk.promise);
    const f = fixture({ read }); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    if (action === "discard") expect(f.participant().discard()).toBe(true);
    else f.input("Seed");
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.controller.state.saveFeedback).not.toBe("");
    if (action === "discard") expect(f.controller.state.saveFeedback).not.toContain("will be merged");
    disk.resolve({ path: "folder/P", content: "Disk", version: "v2" }); await flush();
    expect(f.controller.state.note).toMatchObject({ content: "Disk", version: "v2" });
    expect(f.controller.state.saveFeedback).toBe("");
    if (action === "discard") f.enter();
    expect(f.controller.currentBuffer()).toBe("Disk");
    expect(f.controller.isDirty()).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    f.input("Next"); updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Next", version: "v3" });
    f.controller.saveHandler(); await flush();
    expect(updateNote).toHaveBeenLastCalledWith("folder/P", "folder/P", "Next", "none", "Disk");
  });
  it("reconciles a dirty reset through the same reload owner after discard", async () => {
    const read = vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" })
      .mockResolvedValueOnce({ path: "folder/P", content: "Disk", version: "v2" })
      .mockResolvedValue({ path: "folder/P", content: "Latest", version: "v3" });
    const f = fixture({ read }); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_RESET)({ next: 10 });
    expect(f.controller.currentBuffer()).toBe("Mine");
    expect(f.participant().discard()).toBe(true); await flush();
    expect(f.controller.state.saveFeedback).toBe("");
    f.enter(); expect(f.controller.currentBuffer()).toBe("Latest");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("keeps newer typing when a pending clean reload completes after edit re-entry", async () => {
    const disk = deferred();
    const read = vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" })
      .mockReturnValueOnce(disk.promise).mockResolvedValue({ path: "folder/P", content: "Disk", version: "v2" });
    const f = fixture({ read }); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    expect(f.participant().discard()).toBe(true); f.enter(); f.input("New typing");
    disk.resolve({ path: "folder/P", content: "Disk", version: "v2" }); await flush();
    expect(f.controller.currentBuffer()).toBe("New typing");
    expect(f.controller.state.saveFeedback).toContain("will be merged");
    expect(f.participant().discard()).toBe(true); await flush();
    f.enter(); expect(f.controller.currentBuffer()).toBe("Disk");
  });
  it("keeps pending external state truthful if the clean-note reload fails after discard", async () => {
    const error = new Error("Disk unavailable");
    const read = vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" })
      .mockRejectedValueOnce(error).mockResolvedValue({ path: "folder/P", content: "Disk", version: "v2" });
    const f = fixture({ read }); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    expect(f.participant().discard()).toBe(true); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.controller.state.editMode).toBe(false);
    expect(f.controller.state.note.content).toBe("Seed");
    expect(f.controller.state.saveFeedback).toContain("changed elsewhere");
    expect(f.controller.state.saveFeedback).toContain("reload failed");
    expect(f.controller.state.saveFeedback).not.toContain("will be merged");
    expect(f.adapters.failed).toHaveBeenCalledWith(error);
    f.enter(); expect(f.controller.state.saveFeedback).not.toBe("");
    await f.handlers.get(TOPICS.VAULT_RESET)({ next: 11 }); await flush();
    expect(f.controller.currentBuffer()).toBe("Disk");
    expect(f.controller.state.saveFeedback).toBe("");
  });
  it("retires pending external reload work before disposal ends edit state", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    f.controller.dispose(); await flush();
    expect(f.adapters.read).toHaveBeenCalledTimes(1);
  });
  it("an acknowledged merge emits one success toast and clears persistent external state", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Merged", version: "v3", saveResult: { status: "merged" } });
    f.controller.saveHandler(); await flush();
    expect(f.controller.state.saveFeedback).toBe(""); expect(f.controller.state.vaultNotice).toBe("");
    expect(f.adapters.toast.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: "Merged with changes made elsewhere", severity: "success" }));
    // The save owner publishes NOTE_SAVE; the controller must not duplicate it.
    expect(f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_SAVE)).toHaveLength(0);
  });
  it("save failures take priority over external state without dropping that state", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Mine");
    await f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "modified", hash: "v2" });
    updateNote.mockRejectedValueOnce({ response: { status: 401, data: {} } });
    f.controller.saveHandler(); await flush();
    expect(f.controller.state.saveFeedback).toContain("Saving paused");
    expect(f.controller.state.vaultNotice).toContain("will be merged");
  });
  it("explicit Save & close recreates an unchanged deleted note before exiting", async () => {
    const f = fixture(); await f.controller.mount(); f.enter();
    f.handlers.get(TOPICS.VAULT_CHANGE)({ path: "folder/P.md", kind: "deleted" });
    updateNote.mockResolvedValueOnce({ path: "folder/P", content: "Seed", saveResult: { status: "saved", recreated: true } });
    expect(await f.controller.saveHandler(true)).toBe(true);
    expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/P", "Seed", "none", "Seed");
    expect(f.controller.state.editMode).toBe(false);
  });
  it("requires acknowledgement capability at editor registration", () => {
    const f = fixture();
    expect(() => f.controller.registerEditor({ getMarkdown: () => "text" })).toThrow(/applyAcknowledgement/);
  });
  it("retains acknowledged content with no mounted editor", async () => {
    const f = fixture(); await f.controller.mount(); f.enter();
    f.input("Sent"); f.controller.setEditorMode("preview"); f.controller.registerEditor(null);
    updateNote.mockResolvedValueOnce({ path: "folder/Q", content: "Returned" });
    f.controller.setBasename("Q"); f.controller.onTitleInput(); f.controller.applyRename(); await flush();
    expect(f.controller.currentBuffer()).toBe("Returned");
  });
  it.each([false, true])("retains acknowledgement when editor is initializing (declines=%s)", async declines => {
    const f = fixture(); await f.controller.mount(); f.enter();
    f.port.getSnapshot.mockReturnValue({ ready: false });
    if (declines) f.port.applyAcknowledgement.mockReturnValue(false);
    updateNote.mockResolvedValueOnce({ path: "folder/Q", content: "Returned" });
    f.controller.setBasename("Q"); f.controller.onTitleInput(); f.controller.applyRename(); await flush();
    expect(f.controller.currentBuffer()).toBe("Returned");
    const fact = f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_EDIT_STATE).at(-1)[1];
    expect(fact).toMatchObject({ revision: 0, canSave: !declines });
    if (declines) expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Save paused" }));
  });
  it("makes canSave false after overlapping rename acknowledgement, until explicit Save", async () => {
    const response = deferred(), f = fixture();
    updateNote.mockReturnValueOnce(response.promise);
    await f.controller.mount(); f.enter(); f.input("![pic](assets/pic.png)\n");
    f.controller.setFolder("new"); f.controller.syncTitle(); f.controller.applyRename(); await flush();
    f.input("![pic](uploads/other.png)\n");
    response.resolve({ path: "new/P", content: "![pic](../folder/assets/pic.png)\n" }); await flush();
    expect(f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_EDIT_STATE).at(-1)[1]).toMatchObject({ unsaved: true, canSave: false });
    expect(f.controller.currentBuffer()).toBe("![pic](uploads/other.png)\n");
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("Save") }));
  });
  it.each(["exit", "delete", "session"].flatMap(entry => ["save", "discard", "cancel"].map(choice => [entry, choice])))
    ("settled rename conflict reaches %s's explicit %s decision", async (entry, choice) => {
      const response = deferred(), f = fixture();
      const base = "![pic](assets/pic.png)\n", mine = "![pic](uploads/other.png)\n", returned = "![pic](../folder/assets/pic.png)\n";
      updateNote.mockReturnValueOnce(response.promise);
      await f.controller.mount(); f.enter(); f.input(base);
      f.controller.setFolder("new"); f.controller.syncTitle(); f.controller.applyRename(); await flush();
      f.input(mine); response.resolve({ path: "new/P", content: returned }); await flush();
      let attempt;
      if (entry === "session") {
        expect(await f.participant().settlePending()).toBe(true);
        attempt = f.participant().requestDecision();
      } else if (entry === "delete") attempt = f.controller.deleteHandler();
      else f.controller.toggleEditModeHandler();
      await flush();
      expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
      expect(updateNote).toHaveBeenCalledTimes(1);
      updateNote.mockImplementation(async (_, path, content) => ({ path, content }));
      f.controller.onSaveChoice(choice); await flush();
      if (entry === "session") {
        expect(await attempt).toBe(choice);
        if (choice === "discard") expect(await f.participant().discard()).toBe(true);
        if (choice === "save") expect(await f.participant().save()).toBe(true);
      } else if (attempt) await attempt;
      expect(updateNote).toHaveBeenCalledTimes(choice === "save" ? 2 : 1);
      expect(f.controller.currentBuffer()).toBe(choice === "discard" ? returned : mine);
      if (choice === "cancel") expect(f.controller.isDirty()).toBe(true);
      else expect(f.controller.isDirty()).toBe(false);
      if (entry === "delete") expect(f.controller.state.isDeleteModalVisible).toBe(choice !== "cancel");
    });

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
    const f = fixture({}, { capabilities: { canEdit: false } }); f.location.hash = "#source";
    await f.controller.mount(); f.handlers.get(TOPICS.EDITOR_TOGGLE_EDIT)();
    expect(f.controller.state.editMode).toBe(false);
  });
  it("tracks literal buffer dirtiness, excludes unapplied paths and saves the latest draft after debounce", async () => {
    const f = fixture(); await f.controller.mount(); f.enter();
    expect(f.controller.isDirty()).toBe(false); f.input("Changed");
    expect(f.controller.state.unsavedChanges).toBe(true); expect(f.participant().hasUnsavedChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.drafts.save).toHaveBeenCalledWith("folder/P", "Changed", 1);
    f.input("Seed"); expect(f.controller.isDirty()).toBe(false);
    f.controller.setBasename("Q"); f.controller.onTitleInput(); expect(f.controller.isDirty()).toBe(false);
    expect(f.adapters.setUnload).toHaveBeenLastCalledWith(false);
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
    const target = f.to();
    expect(await f.controller.gateNavigation(target)).toBe(false);
    if (choice !== "cancel") f.admitDeparture(target);
    expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
    f.controller.onSaveChoice(choice); await flush();
    expect(f.controller.state.editMode).toBe(choice === "cancel");
    expect(f.router.push.mock.calls).toEqual(choice === "cancel" ? [] : [["/Other"]]);
    expect(updateNote.mock.calls).toEqual(choice === "save" ? [["folder/P", "folder/P", "Work", "none", "Seed"]] : []);
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
  it("a stale delete keeps the note, says why and shows the current version", async () => {
    const read = vi.fn().mockResolvedValueOnce({ path: "folder/P", content: "Seed", version: "v1" })
      .mockResolvedValue({ path: "folder/P", content: "Elsewhere", version: "v2" });
    const f = fixture({ read, remove: vi.fn().mockRejectedValue({ response: { status: 409, data: { code: "base_stale", currentVersion: "v2" } } }) });
    await f.controller.mount(); await f.controller.deleteConfirmedHandler(); await flush();
    expect(f.adapters.remove).toHaveBeenCalledExactlyOnceWith("folder/P", "v1");
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Changed elsewhere", severity: "error" }));
    expect(f.router.push).not.toHaveBeenCalled(); expect(f.adapters.publish).not.toHaveBeenCalledWith(TOPICS.NOTE_DELETE, expect.anything());
    expect(f.controller.state.note.content).toBe("Elsewhere");
  });
  it("a delete refusal for the original identity cannot notify or refresh its replacement", async () => {
    const identity = ref("alice"), entered = deferred(), removed = deferred();
    const f = fixture({ sessionKey: () => identity.value, remove: vi.fn(() => { entered.resolve(); return removed.promise; }) });
    await f.controller.mount(); await f.controller.deleteHandler();
    const deletion = f.controller.deleteConfirmedHandler();
    await entered.promise;
    identity.value = "bob";
    removed.reject({ response: { status: 409, data: { code: "base_stale" } } });
    await deletion;
    expect(f.adapters.read.mock.calls).toEqual([["folder/P"], ["folder/P"]]); // one initial read and one replacement read
    expect(f.adapters.toast.add).not.toHaveBeenCalled();
    expect(f.router.push).not.toHaveBeenCalled();
  });
  it("delete failure uses classified policy or the injected generic fallback", async () => {
    const f = fixture({ remove: vi.fn().mockRejectedValueOnce({ response: { data: { code: "operation_conflict", detail: "Conflict detail" } } }).mockRejectedValueOnce(Error("unmapped")) });
    await f.controller.mount(); await f.controller.deleteConfirmedHandler();
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Conflict", detail: "Conflict detail" }));
    await f.controller.deleteConfirmedHandler(); expect(f.adapters.failed).toHaveBeenCalledWith(Error("unmapped")); expect(f.router.push).not.toHaveBeenCalled();
  });
  it("modal-gated actions decline and subscriptions release at disposal", async () => {
    const f = fixture(); await f.controller.mount(); f.adapters.actionAvailable.mockReturnValue(false);
    for (const [topic, handler] of f.handlers) if (topic.startsWith("editor:")) handler(); expect(f.controller.state.editMode).toBe(false);
    f.adapters.actionAvailable.mockReturnValue(true); f.handlers.get(TOPICS.EDITOR_TOGGLE_EDIT)();
    expect(f.controller.state.editMode).toBe(true); f.handlers.get(TOPICS.EDITOR_TOGGLE_SOURCE_MODE)();
    expect(f.controller.state.editorMode).toBe("wysiwyg");
    f.controller.dispose(); expect(f.handlers.size).toBe(0); expect(f.unsubs).toHaveLength(7);
  });
  it("wires its default load/delete/save transports without a view import", async () => {
    getNote.mockResolvedValue({ path: "folder/P", content: "Seed", version: "v1" }); deleteNote.mockResolvedValue({});
    updateNote.mockImplementation(async (source, path, content) => ({ path, content, version: "v2" }));
    const f = fixture({ read: undefined, remove: undefined }); await f.controller.mount();
    expect(getNote).toHaveBeenCalledWith("folder/P"); f.enter(); f.input("Saved");
    f.controller.saveHandler(); await flush();
    expect(updateNote).toHaveBeenCalledWith("folder/P", "folder/P", "Saved", "none", "Seed");
    expect(f.controller.isDirty()).toBe(false); expect(createNote).not.toHaveBeenCalled();
    await f.controller.deleteConfirmedHandler(); expect(deleteNote).toHaveBeenCalledWith("folder/P", "v2");
  });
  it("save is a no-op outside editing and when text is already submitted, and never stores the editor mode", async () => {
    updateNote.mockImplementation(async (source, path, content) => ({ path, content }));
    const f = fixture(); await f.controller.mount(); f.controller.saveHandler();
    f.enter(); f.controller.saveHandler(); expect(updateNote).not.toHaveBeenCalled();
    f.input("Saved"); f.controller.saveHandler(); f.controller.saveHandler(); await flush();
    expect(updateNote).toHaveBeenCalledTimes(1); expect(f.controller.state.editMode).toBe(true);
    f.controller.saveHandler(); expect(updateNote).toHaveBeenCalledTimes(1);
    expect(f.adapters.saveEditorPreference).not.toHaveBeenCalled();
    f.controller.setEditorMode("wysiwyg"); expect(f.adapters.saveEditorPreference).toHaveBeenCalledExactlyOnceWith("wysiwyg");
  });
  it.each(["Untitled", "Heading"])("first save creates %s and stays editing", async title => {
    createNote.mockImplementation(async (path, content) => ({ path, content }));
    const f = fixture({}, { path: undefined, notePaths: [] }); await f.controller.mount(); f.controller.registerEditor(f.port);
    f.input(title === "Heading" ? "# Heading" : "New text");
    await vi.advanceTimersByTimeAsync(300); f.controller.saveHandler(); await flush();
    expect(createNote).toHaveBeenCalledExactlyOnceWith(title, title === "Heading" ? "# Heading" : "New text");
    expect(f.controller.state.editMode).toBe(true); expect(f.controller.isDirty()).toBe(false);
  });
  it("rename carries current text, applies acknowledgement and Discard reverts only later text", async () => {
    updateNote.mockImplementation(async (source, path, content) => ({ path, content: content.replace("old.png", "new.png") }));
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("![image](old.png)");
    f.controller.setBasename("Q"); f.controller.onTitleInput(); expect(updateNote).not.toHaveBeenCalled();
    expect(f.controller.applyRename()).toBe(true); f.controller.applyRename(); await flush();
    expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/Q", "![image](old.png)", "none", "Seed");
    expect(f.controller.currentBuffer()).toBe("![image](new.png)");
    f.input("Later"); f.participant().discard(); expect(f.controller.currentBuffer()).toBe("![image](new.png)");
    expect(f.controller.state.note.path).toBe("folder/Q");
  });
  it("save writes the current file and leaves unapplied name input alone", async () => {
    updateNote.mockImplementation(async (source, path, content) => ({ path, content }));
    const f = fixture(); await f.controller.mount(); f.enter();
    f.controller.setBasename("Q"); f.controller.onTitleInput(); f.input("Work");
    f.controller.saveHandler(); await flush();
    expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/P", "Work", "none", "Seed");
    expect(f.controller.state.editBasename).toBe("Q"); expect(f.controller.isDirty()).toBe(false);
    f.controller.applyRename(); await flush();
    expect(updateNote).toHaveBeenLastCalledWith("folder/P", "folder/Q", "Work", "none", "Work");
  });
  it("navigation and session settlement apply pending renames even with clean text", async () => {
    updateNote.mockImplementation(async (source, path, content) => ({ path, content }));
    const f = fixture(); await f.controller.mount(); f.enter();
    f.controller.setBasename("Q"); f.controller.onTitleInput();
    expect(await f.participant().settlePending()).toBe(true);
    expect(updateNote).toHaveBeenCalledExactlyOnceWith("folder/P", "folder/Q", "Seed", "none", "Seed");
    f.controller.setBasename("R"); f.controller.onTitleInput();
    f.location.hash = "#source";
    expect(await f.controller.gateNavigation(f.to())).toBe(false); await flush();
    expect(updateNote).toHaveBeenLastCalledWith("folder/Q", "folder/R", "Seed", "none", "Seed");
    expect(f.router.push).toHaveBeenCalledWith("/Other");
  });
  it("new-note rename changes only requested name; invalid rename retains fields and blocks exit/session", async () => {
    const f = fixture({}, { path: undefined }); await f.controller.mount();
    f.controller.setBasename("Manual"); f.controller.onTitleInput(); expect(f.controller.applyRename()).toBe(true);
    expect(createNote).not.toHaveBeenCalled(); expect(updateNote).not.toHaveBeenCalled();
    f.controller.setBasename("bad?"); f.controller.onTitleInput(); expect(f.controller.applyRename()).toBe(false);
    expect(await f.participant().settlePending()).toBe(false);
    expect(f.controller.state.editBasename).toBe("bad?");
    expect(f.adapters.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: "Invalid" }));
    expect(f.controller.state.editMode).toBe(true);
  });
  it("publishes text-free revisions, invalid and paused capabilities, and the final clean exit", async () => {
    const wire = deferred(); updateNote.mockReturnValue(wire.promise);
    const f = fixture(); await f.controller.mount(); f.enter();
    f.input("A"); f.input("B");
    const facts = () => f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_EDIT_STATE).map(([, fact]) => fact);
    expect(facts().at(-1)).toEqual({ path: "folder/P", revision: 2, editing: true, unsaved: true, canSave: true });
    f.controller.setBasename("bad?"); f.controller.onTitleInput(); expect(facts().at(-1).canSave).toBe(false);
    f.controller.setBasename("P"); f.controller.onTitleInput(); f.controller.saveHandler(); await flush();
    wire.reject({ response: { data: { code: "plugin_cancelled" } } }); await flush();
    expect(facts().at(-1)).toMatchObject({ unsaved: true, canSave: false });
    f.participant().discard(); expect(facts().at(-1)).toMatchObject({ editing: false, unsaved: false, canSave: false });
    expect(facts().every(fact => Object.keys(fact).sort().join() === "canSave,editing,path,revision,unsaved")).toBe(true);
  });
  it("publishes inactive edit state on disposal without changing caret URL behavior", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("Unsaved");
    f.adapters.publish.mockClear();
    f.controller.dispose();
    const facts = f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_EDIT_STATE).map(([, fact]) => fact);
    expect(facts).toEqual([{ path: "folder/P", revision: 1, editing: false, unsaved: false, canSave: false }]);
    f.controller.dispose();
    expect(f.adapters.publish.mock.calls.filter(([topic]) => topic === TOPICS.NOTE_EDIT_STATE)).toHaveLength(1);
  });
  it("save-close composes save, settlement and exit without closing over newer work", async () => {
    const wire = deferred(); updateNote.mockReturnValue(wire.promise);
    const f = fixture(); await f.controller.mount(); f.enter(); f.input("A");
    const closing = f.controller.saveHandler(true); await flush();
    expect(f.controller.state.editMode).toBe(true); f.input("Later");
    wire.resolve({ path: "folder/P", content: "A" }); await flush();
    expect(f.controller.state.isSaveChangesModalVisible).toBe(true);
    f.controller.onSaveChoice("cancel"); expect(await closing).toBe(false); expect(f.controller.currentBuffer()).toBe("Later");
    updateNote.mockResolvedValue({ path: "folder/P", content: "Later" });
    const cleanClose = f.controller.saveHandler(true); await flush();
    expect(await cleanClose).toBe(true); expect(f.controller.state.editMode).toBe(false);
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
    f.commitRoute(target); await flush();
    expect(f.port.selectLine).toHaveBeenCalledExactlyOnceWith({ from: 3, to: 3 });
  });
  it("publishes mode and exit state after their own push guards without replaying effects", async () => {
    const f = fixture(); await f.controller.mount(); f.enter(); f.location.hash = "#source";
    f.router.push.mockImplementation(async fullPath => {
      const hash = fullPath.includes("#") ? fullPath.slice(fullPath.indexOf("#")) : "";
      expect(f.controller.state.editMode).toBe(true);
      expect(f.controller.state.editorMode).toBe(hash ? "markdown" : "wysiwyg");
      expect(await f.controller.gateNavigation(f.to("folder/P", hash))).toBe(true);
      f.router.currentRoute.value.fullPath = fullPath;
      f.location.hash = hash;
    });
    f.controller.setEditorMode("wysiwyg"); await flush();
    expect(f.controller.state.editorMode).toBe("wysiwyg");
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
