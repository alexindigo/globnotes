import { afterEach, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { heldOperation } from "../../tests/helpers/owned_operation.ts";
import { createIdentityAppSession } from "../appSession.js";
import { createIdentityLoginFlow } from "../loginFlow.js";
import { identitySessionKey, permissionEligibility, readerRuntimeEligibility } from "../appSessionPolicy.js";
import { createIdentityTokenStorage } from "../tokenStorage.js";
import { createIdentityApi } from "../api.js";
import { createIdentityRouteGuard } from "../router.js";
import { createIdentityNoteIndex } from "../noteIndex.js";
import { createIdentityNoteDraftStore } from "../noteDrafts.js";
import { createAppPermissions } from "../appPermissions.js";
import { createSearchResults } from "../searchResults.js";
import { createIdentityPluginRuntime } from "../pluginRuntime.js";
import { createVaultChanges } from "../vaultChanges.js";
import { createNoteSaveOwner } from "../noteSaveOwner.js";
import { createConflictInbox } from "../conflictInbox.js";
import { canCreateNote } from "../noteCreation.js";
import { registerSessionParticipant, resolveParticipants } from "../sessionActions.js";
import { createSettingsPageState } from "../settingsPageState.js";

const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  localStorage.clear(); sessionStorage.clear();
});
const projection = (account = "alice", level = "view", revision = 1) => ({
  principal: account ? { kind: "account", id: account } : { kind: "guest" }, accountId: account,
  sessionGeneration: account ? `session-${account}` : "guest", vaultId: level === "none" ? null : "vault-one", authorityRevision: revision,
  capabilities: { canRead: level !== "none", canEdit: ["edit", "admin"].includes(level), canManageVault: level === "admin", canManageOwnAccount: !!account, canCreateVault: !!account },
  setupRequired: false, brand: { name: "Fixture" },
});
const controlled = (label, owner) => ({ label, owner: () => owner, progress: { kind: "controlled", clock: "external" } });
function app({ resolve = vi.fn(async () => "proceed"), transport } = {}) {
  const current = ref(projection("alice", "edit")), events = [];
  const tokens = createIdentityTokenStorage({ prefix: "/one", setCookie() {} }); tokens.storeToken("old.jwt", true);
  const io = transport ?? { getConfig: vi.fn(async () => projection(null)), getToken: vi.fn(async () => "fresh.jwt") };
  const session = createIdentityAppSession({ config: () => current.value, setConfig: value => { current.value = value; events.push("config"); }, tokens, transport: io, resolve,
    startRuntime: key => events.push(["runtime", key]), stopRuntime: () => events.push("stop"), setChangesSession: key => events.push(["changes", key]),
    clearBrowseData: () => events.push("clear-browse"), refreshNotes: () => events.push("notes"), applyBrand() {}, navigate: target => events.push(target.name),
  });
  cleanups.push(() => session.dispose()); session.adopt(current.value);
  return { session, current, tokens, io, events, resolve };
}
function flow(f, overrides = {}) {
  const adapters = { session: f.session, credentials: () => ({ username: "bob", password: "password", totp: "123456", rememberMe: true }),
    clearCredentials: vi.fn(), redirect: () => null, navigate: vi.fn(), toast: { add: vi.fn() }, ...overrides };
  const login = createIdentityLoginFlow(adapters); cleanups.push(() => login.dispose());
  return { login, ...adapters };
}

it("a retired transport admits only credential recovery even while the old token is stored", async () => {
  const get = vi.fn(async () => ({ data: projection() })), request = vi.fn(async () => ({ data: {} }));
  const open = vi.fn(async () => Response.json({ entries: [], next: 0 }));
  const api = createIdentityApi({ sessionKey: () => null, tokens: { getStoredToken: () => "alice.jwt" }, http: { get, request }, fetch: open });
  const results = await Promise.allSettled([api.read("notes"), api.write("put", "notes", {}),
    api.openVaultChanges({ onEvent() {} }).then(async close => { await close(); }), api.getConfig()]);
  expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected", "fulfilled"]);
  expect(get.mock.calls).toEqual([["config", { headers: { Authorization: "Bearer alice.jwt" } }]]);
  expect([request.mock.calls, open.mock.calls]).toEqual([[], []]);
});

it("retaining a 403's dirty work cannot retire a replacement installed by the participant", async () => {
  const current = ref(projection()), refusal = Error("denied"); refusal.status = 403;
  const get = vi.fn(async () => { throw refusal; });
  const session = createIdentityAppSession({ config: () => current.value, setConfig: value => { current.value = value; },
    tokens: { getStoredToken: () => "opaque" }, http: { get }, applyBrand() {} });
  cleanups.push(() => session.dispose()); session.adopt(current.value);
  cleanups.push(registerSessionParticipant("replacement", { hasUnsavedChanges: () => true,
    retainForAuthentication() { session.adopt(projection("bob")); } }));
  await expect(session.transport.read("notes")).rejects.toBe(refusal);
  expect([session.state.valid, current.value.accountId, get.mock.calls.map(([path]) => path)]).toEqual([true, "bob", ["notes"]]);
});

it("reports the initial config installation error from the adoption that owns it", async () => {
  const failure = Error("cannot install config"), failed = vi.fn();
  const session = createIdentityAppSession({ config: () => ({}), setConfig: () => { throw failure; }, failed,
    tokens: { getStoredToken: () => null }, transport: { getConfig: async () => projection(null) } });
  cleanups.push(() => session.dispose());
  expect(await session.load()).toBe(false);
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
  expect([session.state.ready, session.state.valid]).toEqual([false, false]);
});

it("navigates and completes the shared logout before anonymous config answers", async () => {
  let release, entered;
  const answer = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = app({ transport: { getConfig: () => { entered(); return answer; } } });
  const logout = f.session.logout();
  try {
    expect(f.session.logout()).toBe(logout);
    await started;
    expect(f.events.filter(value => value === "login")).toEqual(["login"]);
    expect(await logout).toBe(true);
    f.session.acceptToken("bob.jwt", false); f.session.adopt(projection("bob"));
  } finally { release(projection(null)); await f.session.settle(); }
  expect([f.current.value.accountId, f.tokens.getStoredToken()]).toEqual(["bob", "bob.jwt"]);
});

it("awaits and reports an asynchronous accepted login callback rejection", async () => {
  let resolveEntered, rejectCallback;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const callback = new Promise((_, reject) => { rejectCallback = reject; });
  // Keep the test-owned promise observed even in the broken flow.
  callback.catch(() => {});
  const failure = Error("navigation rejected"), reportError = vi.fn();
  const f = app({ transport: { getToken: async () => "bob.jwt", getConfig: async () => projection("bob") } });
  const login = flow(f, { reportError, authenticated: () => { resolveEntered(); return callback; } });
  const completing = login.login.logIn();
  await entered;
  rejectCallback(failure);
  await completing;
  expect(reportError).toHaveBeenCalledExactlyOnceWith(failure, login.toast);
  expect(login.clearCredentials).toHaveBeenCalledExactlyOnceWith();
});

it("a cursor cannot open as Bob before Bob's stream session has been installed", async () => {
  let identity = null;
  const opens = [], events = [];
  const changes = createVaultChanges({ sessionKey: () => identity, open: async options => { opens.push(options); return () => {}; }, publish: (...args) => events.push(args) });
  cleanups.push(() => changes.dispose()); changes.acquire(); await changes.settle();
  identity = "alice"; changes.setSession(identity); await changes.settle();
  opens.at(-1).onEvent({ event: "cursor", data: { next: 17 } });
  identity = "bob"; changes.restart(); await changes.settle();
  changes.setSession(identity); await changes.settle();
  const change = { seq: 1, path: "B.md" };
  opens.at(-1).onEvent({ event: "change", data: change });
  expect([opens.map(({ since }) => since), events.map(([, value]) => value)]).toEqual([[0, 0], [change]]);
});

it("session keys use only safe facts; reader runtime and Admin permission review are independent", () => {
  const view = projection(), admin = projection("alice", "admin");
  expect([readerRuntimeEligibility(true, view, "home", null), permissionEligibility(true, view, "home", "raw-token"), permissionEligibility(true, admin, "home", null)]).toEqual([true, false, true]);
  expect([canCreateNote(view), canCreateNote(projection("alice", "edit"))]).toEqual([false, true]);
  const key = identitySessionKey({ ...view, authType: "anything", token: "raw-token" });
  expect(key).toBe(identitySessionKey(view));
  expect([projection("bob"), projection(null), { ...view, vaultId: "other-vault" }, projection("alice", "view", 2), { ...view, sessionGeneration: "new" }].map(identitySessionKey)).toEqual([
    '[["account","bob"],"session-bob","vault-one",1]', '[["guest"],"guest","vault-one",1]', '[["account","alice"],"session-alice","other-vault",1]', '[["account","alice"],"session-alice","vault-one",2]', '[["account","alice"],"new","vault-one",1]',
  ]);
});
it("the real permission owner starts View runtime without reading Admin requests", async () => {
  const current = ref(projection()), ready = ref(false), start = vi.fn(), readPending = vi.fn(async () => []);
  const permissions = createAppPermissions({ config: () => current.value, configReady: () => ready.value, routeName: () => "home", setupRequested: () => false, refreshConfig() {}, token: () => "secret",
    catalog: ref({ plugins: [] }), modals: ref([]), startRuntime: start, stopRuntime() {}, readPending, attentionRegistry: { publish: () => () => {} } });
  cleanups.push(() => permissions.dispose()); ready.value = true; await nextTick();
  expect(start).toHaveBeenCalledWith(identitySessionKey(current.value)); expect(readPending).not.toHaveBeenCalled();
  current.value = projection("alice", "admin"); await nextTick(); expect(readPending).toHaveBeenCalled();
});
it("invalidation fences delayed config without deleting or resolving dirty participants", async () => {
  let hold;
  const f = app({ transport: { getConfig: async () => { await hold(); return projection("alice", "admin"); } } });
  const asked = vi.fn(); cleanups.push(registerSessionParticipant("identity-note", { hasUnsavedChanges: () => true, requestDecision: asked }));
  await heldOperation(controlled("old config", f.session), boundary => { hold = boundary; return f.session.refresh(); }, async work => {
    await work.reached(); f.session.invalidate(); f.session.adopt(projection("bob", "none"));
    expect(await work.result()).toBe(false);
    expect(f.current.value).toEqual(projection("bob", "none")); expect(asked).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
  });
});
it.each(["cancel", "discard", "save"])("logout %s settles original participants before browser-only credential retirement", async choice => {
  const events = [];
  cleanups.push(registerSessionParticipant("identity-note", { hasUnsavedChanges: () => true, requestDecision: async () => choice,
    discard: () => events.push("discard"), save: async () => { events.push("saved"); return true; } }));
  const f = app({ resolve: resolveParticipants }); await f.session.logout();
  expect(f.tokens.getStoredToken()).toBe(choice === "cancel" ? "old.jwt" : null); expect(f.io.getToken).not.toHaveBeenCalled();
  expect(events).toEqual(choice === "save" ? ["saved"] : choice === "discard" ? ["discard"] : []);
  expect(f.events.filter(value => value === "login")).toEqual(choice === "cancel" ? [] : ["login"]);
});
it("public vaults retain explicit named sign-in and Cancel keeps credentials and route", async () => {
  const f = app({ resolve: vi.fn(async () => "cancel") }), login = flow(f);
  login.login.init("none"); await login.login.logIn();
  expect(f.io.getToken).not.toHaveBeenCalled(); expect(login.clearCredentials).not.toHaveBeenCalled(); expect(f.tokens.getStoredToken()).toBe("old.jwt");
  expect(await createIdentityRouteGuard({ status: () => projection(null) })({ name: "login" })).toBe(true);
  expect(await createIdentityRouteGuard({ status: () => projection("bob", "none") })({ name: "account" })).toBe(true);
});
it("a token response from a retired owner is not persisted", async () => {
  let hold;
  const f = app({ transport: { getToken: async () => { await hold(); return "late.jwt"; }, getConfig: async () => projection("bob") } }), login = flow(f);
  await heldOperation(controlled("old token", f.session), boundary => { hold = boundary; return login.login.logIn(); }, async work => {
    await work.reached(); f.session.invalidate(); await work.result();
    expect(f.tokens.getStoredToken()).toBe("old.jwt"); expect(login.navigate).not.toHaveBeenCalled();
  });
});
it("sign-in waits for participants before proof, then adopts the new safe session", async () => {
  let hold; const events = [];
  const f = app({ resolve: async () => { events.push("resolve"); await hold(); return "proceed"; }, transport: {
    getToken: vi.fn(async () => { events.push("prove"); return "bob.jwt"; }), getConfig: async () => projection("bob", "none") } }), login = flow(f);
  await heldOperation(controlled("sign-in departure", f.session), boundary => { hold = boundary; return login.login.logIn(); }, async work => {
    await work.reached(); expect(events).toEqual(["resolve"]); expect(f.tokens.getStoredToken()).toBe("old.jwt"); await work.result();
    expect(events).toEqual(["resolve", "prove"]); expect(f.tokens.getStoredToken()).toBe("bob.jwt"); expect(f.current.value).toEqual(projection("bob", "none"));
    expect(login.navigate).toHaveBeenCalledExactlyOnceWith({ name: "home" });
  });
});
it("a logout's delayed anonymous config cannot clear or navigate over Bob's replacement sign-in", async () => {
  let hold; const f = app({ transport: { getConfig: async () => { await hold(); return projection(null); } } });
  await heldOperation(controlled("anonymous logout config", f.session), boundary => { hold = boundary; return f.session.logout(); }, async work => {
    await work.reached(); expect(f.tokens.getStoredToken()).toBeNull(); expect(f.events.filter(value => value === "login")).toEqual(["login"]);
    f.session.acceptToken("bob.jwt", false); f.session.adopt(projection("bob", "none"));
    expect(await work.result()).toBe(true); await f.session.settle();
    expect(f.current.value).toEqual(projection("bob", "none")); expect(f.tokens.getStoredToken()).toBe("bob.jwt"); expect(f.events.filter(value => value === "login")).toEqual(["login"]);
  });
});
it("logout keeps its shared completion and reaches ordinary sign-in when the anonymous refresh fails", async () => {
  const error = new Error("offline");
  const getConfig = vi.fn(async () => { throw error; });
  const f = app({ transport: { getConfig } });
  const pending = f.session.logout();
  expect(f.session.logout()).toBe(pending); expect(await pending).toBe(true);
  await f.session.settle();
  expect(getConfig).toHaveBeenCalledExactlyOnceWith();
  expect([f.tokens.getStoredToken(), f.session.state.valid, f.events.filter(value => value === "login")]).toEqual([null, false, ["login"]]);
});
it.each([false, true])("every ordinary/gap poll callback has its own final fence (gap=%s)", async gap => {
  let scope = "alice"; const delivered = [], closed = vi.fn();
  const api = createIdentityApi({ tokens: { getStoredToken: () => "token" }, sessionKey: () => scope,
    fetch: async () => Response.json({ gap, entries: [{ seq: 1, path: "first" }, { seq: 2, path: "private" }], next: 2, conflictRevision: 3, driverRevision: 4 }) });
  const close = await api.openVaultChanges({ poll: true, onEvent: event => { delivered.push(event); scope = "bob"; }, onClose: closed });
  try { expect(delivered).toEqual([gap ? { event: "reset", data: { next: 2 } } : { event: "change", data: { seq: 1, path: "first" } }]); expect(closed).not.toHaveBeenCalled(); }
  finally { await close(); }
});
it("prepared API sends separate password/TOTP, fences old reads, and preserves original late write ACK", async () => {
  let scope = "alice", hold; const posts = [], invalidated = [];
  const api = createIdentityApi({ tokens: { getStoredToken: () => "opaque" }, sessionKey: () => scope,
    http: { get: async () => { await hold(); return { data: ["alice-private"] }; }, request: async () => { await hold(); return { data: { path: "Note", content: "committed" } }; },
      post: async (...args) => { posts.push(args); return { data: { access_token: "signed.jwt" } }; } }, onAuthorityFailure: value => invalidated.push(value) });
  expect(await api.getToken("alice", "password", "123456")).toBe("signed.jwt"); expect(posts).toEqual([["token", { username: "alice", password: "password", totp: "123456" }]]);
  await heldOperation(controlled("old API read", api), boundary => { hold = boundary; return api.read("index"); }, async work => {
    await work.reached(); scope = "bob"; await expect(work.result()).rejects.toMatchObject({ staleIdentity: true });
  });
  await heldOperation(controlled("retained API ACK", api), boundary => { hold = boundary; return api.write("put", "notes/Note", { content: "dirty" }); }, async work => {
    await work.reached(); scope = "charlie"; expect(await work.result()).toEqual({ path: "Note", content: "committed" });
  });
  expect(invalidated).toEqual([]);
});
it("authority failure belongs only to the originating credential attempt", async () => {
  let scope = "alice", hold; const error = { response: { status: 401 } }, invalidated = [];
  const api = createIdentityApi({ tokens: { getStoredToken: () => "opaque" }, sessionKey: () => scope,
    http: { get: async () => { await hold(); throw error; } }, onAuthorityFailure: value => invalidated.push(value) });
  await heldOperation(controlled("old failure", api), boundary => { hold = boundary; return api.read("index"); }, async work => {
    await work.reached(); scope = "bob"; await expect(work.result()).rejects.toBe(error);
  });
  expect(invalidated).toEqual([]);
  const current = createIdentityApi({ tokens: { getStoredToken: () => "opaque" }, sessionKey: () => scope, http: { get: async () => { throw error; } }, onAuthorityFailure: value => invalidated.push(value) });
  await expect(current.read("index")).rejects.toBe(error); expect(invalidated).toEqual([error]); expect(invalidated[0]).toBe(error);
});

it.each([401, 403])("the default transport lets initial recovery own a %s refusal", async status => {
  const error = { response: { status } }, failed = vi.fn();
  const get = vi.fn(async () => { throw error; });
  const session = createIdentityAppSession({ config: () => ({}), setConfig: vi.fn(), tokens: { getStoredToken: () => "old" }, http: { get }, failed });
  cleanups.push(() => session.dispose());
  expect(await session.load()).toBe(false);
  expect([get.mock.calls.length, failed.mock.calls, session.state.ready, session.state.valid]).toEqual([1, [[error]], false, false]);
});

it("the default transport cannot deliver a pre-outage read after the same projection recovers", async () => {
  let hold;
  const original = projection(), current = ref(original);
  const session = createIdentityAppSession({ config: () => current.value, setConfig: value => { current.value = value; },
    tokens: { getStoredToken: () => "same" }, stopRuntime() {}, applyBrand() {}, http: { async get(path) {
      if (path === "config") return { data: original };
      await hold(); return { data: ["retired reply"] };
    } } });
  cleanups.push(() => session.dispose());
  session.adopt(original);
  const key = session.key(), api = session.transport;
  await heldOperation(controlled("pre-outage read", api), boundary => { hold = boundary; return api.read("index"); }, async work => {
    await work.reached();
    session.invalidate(); expect(session.key()).toBeNull();
    expect(await session.refresh()).toBe(true); expect(session.key()).toBe(key);
    await expect(work.result()).rejects.toMatchObject({ staleIdentity: true });
  });
});
it("retired index, search and sidebar reads cannot repopulate another identity", async () => {
  const identity = ref("alice"), store = { notePaths: [], noteMeta: [], recentlyOpened: [] }; let hold;
  const index = createIdentityNoteIndex({ sessionKey: () => identity.value, canRead: () => true, store, read: async () => { await hold(); return [{ path: "alice-private" }]; }, subscribeAction: () => () => {}, subscribeChanges: () => () => {} });
  cleanups.push(() => index.dispose()); index.setSession("alice");
  await heldOperation(controlled("old index", index), boundary => { hold = boundary; return index.refresh(); }, async work => {
    await work.reached(); identity.value = "bob"; index.setSession("bob"); await work.result(); expect(store).toEqual({ notePaths: [], noteMeta: [], recentlyOpened: [] });
  });
  let scope = "alice";
  const search = createSearchResults({ sessionKey: () => scope, query: () => ({ searchTerm: "*" }), loadNotes: async () => { await hold(); return [{ path: "private", score: 1 }]; }, preferences: { includeNested: ref(true), setIncludeNested() {} } });
  cleanups.push(() => search.dispose());
  await heldOperation(controlled("old search", search), boundary => { hold = boundary; return search.init(); }, async work => {
    await work.reached(); scope = "bob"; await work.result(); expect(search.snapshot().results).toEqual([]);
  });
});
it("drafts are prefix/account/vault qualified and do not import ambiguous legacy text", () => {
  localStorage.setItem("globnotes:draft:Note", "legacy-private");
  const make = (prefix, account, vault = "vault-one") => createIdentityNoteDraftStore({ prefix, identity: () => ({ ...projection(account), vaultId: vault }), tokens: { isCurrentTokenStored: () => true } });
  const alice = make("/one", "alice"); expect(alice.load("Note", 0)).toBeNull(); alice.save("Note", "alice-dirty", 1);
  for (const other of [make("/one", "bob"), make("/one", null), make("/two", "alice"), make("/one", "alice", "other-vault")]) { expect(other.load("Note", 0)).toBeNull(); other.clear(); }
  expect(alice.load("Note", 1)).toBe("alice-dirty"); expect(localStorage.getItem("globnotes:draft:Note")).toBe("legacy-private");
});
it("runtime contributions and vault cursors remain bound to their original safe identity", async () => {
  let identity = "alice", hold;
  const runtime = createIdentityPluginRuntime({ sessionKey: () => identity, readCatalog: async () => { await hold(); return { plugins: [{ id: "old", enabled: true, runtime: { client: true } }] }; }, openEvents: async () => () => {}, createSdk: () => ({}), removeOwner() {} });
  cleanups.push(() => runtime.stop());
  await heldOperation(controlled("old runtime", runtime), boundary => { hold = boundary; return runtime.start("alice"); }, async work => { await work.reached(); identity = "bob"; runtime.stop(); await work.result(); expect(runtime.catalog.value).toBeNull(); });
  const opens = [], events = [];
  const changes = createVaultChanges({ sessionKey: () => identity, open: async options => { opens.push(options); return () => {}; }, publish: (...args) => events.push(args) });
  cleanups.push(() => changes.dispose()); changes.setSession("bob"); const release = changes.acquire(); await changes.settle();
  const old = opens.at(-1); identity = "alice"; changes.setSession("alice"); await changes.settle();
  old.onEvent({ event: "change", data: { seq: 9, path: "bob-private" } }); expect(events).toEqual([]); expect(opens.at(-1).since).toBe(0);
  changes.setSession(null); release();
});
it("vault session replacement cannot overwrite a newer identity installed by cancellation", async () => {
  let identity = "alice";
  const opens = [], events = [];
  const changes = createVaultChanges({ sessionKey: () => identity, publish: (...args) => events.push(args), open: async options => {
    const key = identity; opens.push({ key, ...options });
    if (key === "alice") options.signal.addEventListener("abort", () => { identity = "bob"; changes.setSession("bob"); }, { once: true });
    return () => {};
  } });
  cleanups.push(() => changes.dispose()); changes.setSession("alice"); const release = changes.acquire(); await changes.settle();
  identity = "intermediate"; changes.setSession("intermediate"); await changes.settle();
  opens.at(-1).onEvent({ event: "change", data: { seq: 3, path: "Bob note" } });
  expect(opens.map(value => [value.key, value.since])).toEqual([["alice", 0], ["bob", 0]]);
  expect(changes.state().seq).toBe(3);
  expect(events).toEqual([["vault:change", { seq: 3, path: "Bob note" }]]);
  release();
});
it("a late successful save keeps its known-committed outcome without applying it to Bob's UI", async () => {
  let hold; const applied = [], drafts = { clearAcknowledged: vi.fn() };
  const state = { identity: "alice", canEdit: true, isNewNote: false, note: { path: "Note", content: "base" }, requestedPath: "Note", contentRevision: 1, pathRevision: 1 };
  const owner = createNoteSaveOwner({ ownerId: "fixture", getState: () => state, getBuffer: () => "dirty", isContentChanged: () => true,
    update: async () => { await hold(); return { path: "Note", content: "dirty" }; }, applyNote: value => applied.push(value), applyPath() {}, applyContentAcknowledgement() {}, restoreContent() {}, publishTitle() {}, setMovedFiles() {}, drafts, urlSync: { canonicalSaveRoute() {} }, updateRenamedLinks() {}, requestDecision() {} });
  cleanups.push(() => owner.dispose()); owner.start();
  await heldOperation(controlled("original save", owner), boundary => { hold = boundary; return owner.save().completion; }, async work => {
    await work.reached(); state.identity = "bob"; await work.result(); expect(applied).toEqual([]); expect(drafts.clearAcknowledged).not.toHaveBeenCalled();
    expect([owner.queueState().failure.certainty, owner.queueState().unresolved, owner.queueState().acknowledged]).toEqual(["known-committed", true, { path: "Note", content: "dirty" }]);
  });
});

it("app adoption drives the real scoped index while a previous read is still pending", async () => {
  let session, hold, calls = 0;
  const current = ref(projection()), store = { notePaths: [], noteMeta: [], recentlyOpened: [] };
  const index = createIdentityNoteIndex({ store, sessionKey: () => session.key(), canRead: () => current.value.capabilities.canRead,
    read: async () => { if (++calls === 1) { await hold(); return [{ path: "Alice private" }]; } return [{ path: "Bob note" }]; }, subscribeAction: () => () => {}, subscribeChanges: () => () => {} });
  let reading;
  session = createIdentityAppSession({ config: () => current.value, setConfig: next => { current.value = next; }, tokens: { getStoredToken: () => null }, transport: {}, stopRuntime() {}, applyBrand() {},
    setBrowseSession: index.setSession, refreshNotes: () => { reading = index.refresh(); } });
  cleanups.push(() => session.dispose(), () => index.dispose());
  await heldOperation(controlled("app index read", index), boundary => { hold = boundary; session.adopt(current.value); return reading; }, async work => {
    await work.reached(); session.adopt(projection("bob")); await reading;
    expect(store.notePaths).toEqual(["Bob note"]); await work.result(); expect(store.notePaths).toEqual(["Bob note"]);
    session.adopt(projection("bob", "none")); expect(store).toEqual({ notePaths: [], noteMeta: [], recentlyOpened: [] });
  });
});
it("View conflict browsing rejects a delayed reply after becoming None", async () => {
  const current = ref(projection()); let hold;
  const inbox = createConflictInbox({ read: async () => { await hold(); return { conflicts: [{ id: "private" }], total: 1, revision: 1 }; }, token: () => null, subscribe: () => () => {}, acquireChanges: () => () => {} });
  cleanups.push(() => inbox.dispose());
  await heldOperation(controlled("conflict read", inbox), boundary => {
    hold = boundary;
    const release = inbox.bindContext({ config: () => current.value, configReady: () => true, routeName: () => "note" }); cleanups.push(release);
    return inbox.refresh();
  }, async work => {
    await work.reached(); expect(inbox.state.available).toBe(true); current.value = projection("alice", "none"); await nextTick(); await work.result();
    expect([inbox.state.available, inbox.state.rows]).toEqual([false, []]);
  });
});
it("loaded-session recovery outlives a retired stream without taking the initial-load failure path", async () => {
  const current = ref(projection()), failed = vi.fn(); let unavailable = true;
  const session = createIdentityAppSession({ config: () => current.value, setConfig: value => { current.value = value; }, tokens: { getStoredToken: () => "alice.jwt" },
    transport: { getConfig: async () => { if (unavailable) throw new Error("offline"); return projection("alice", "view", 2); } }, stopRuntime() {}, applyBrand() {}, failed });
  cleanups.push(() => session.dispose()); session.adopt(current.value); const before = session.key();
  expect(await session.refresh()).toBe(false); expect(session.state.valid).toBe(false); expect(failed).not.toHaveBeenCalled();
  unavailable = false; expect(await session.refresh()).toBe(true); expect(session.key()).not.toBe(before); expect(current.value).toEqual(projection("alice", "view", 2));
});
it("prepared stream transport does not require AbortSignal.any on baseline browsers", async () => {
  const saved = AbortSignal.any; let opening;
  const controller = new AbortController(), events = [];
  const api = createIdentityApi({ tokens: { getStoredToken: () => null }, sessionKey: () => "guest", fetch: async () => Response.json({ entries: [{ seq: 1, path: "Note" }], next: 1 }) });
  try { AbortSignal.any = undefined; opening = api.openVaultChanges({ poll: true, signal: controller.signal, onEvent: value => events.push(value) }); }
  finally { AbortSignal.any = saved; }
  const close = await opening;
  try { expect(events).toEqual([{ event: "change", data: { seq: 1, path: "Note" } }, { event: "cursor", data: { next: 1 } }]); controller.abort(); }
  finally { await close(); }
});

it("replacement credentials keep old reads in original-work settlement and disposal", async () => {
  let hold;
  const f = app({ transport: { getConfig: async () => { await hold(); return projection("alice"); } } });
  await heldOperation(controlled("retired credential read", f.session), boundary => { hold = boundary; return f.session.refresh(); }, async work => {
    await work.reached(); f.session.acceptToken("bob.jwt", false); f.session.adopt(projection("bob"));
    expect(f.session.hasWork()).toBe(true);
    const settlement = f.session.settle(), disposal = f.session.dispose();
    expect(f.session.dispose()).toBe(disposal);
    expect(await work.result()).toBe(false);
    expect((await settlement).map(result => result.status)).toEqual(["rejected"]);
    expect((await disposal).errors).toEqual([]);
    expect(f.current.value).toEqual(projection("bob")); expect(f.tokens.getStoredToken()).toBe("bob.jwt");
  });
});
it("a reentrant projection consumer cannot start stale runtimes after replacement", () => {
  const current = ref(projection()), started = [];
  let session, replacing = false;
  session = createIdentityAppSession({ config: () => current.value, tokens: { getStoredToken: () => "opaque" }, transport: {}, stopRuntime() {}, applyBrand() {},
    setConfig(value) {
      current.value = value;
      if (!replacing) { replacing = true; session.adopt(projection("bob")); }
    }, startRuntime: key => started.push(key) });
  cleanups.push(() => session.dispose());
  expect(session.adopt(projection("alice"))).toBe(false);
  expect(current.value).toEqual(projection("bob")); expect(started).toEqual([identitySessionKey(projection("bob"))]);
});
it("SSE response admission cannot deliver old-identity bytes or callbacks", async () => {
  let scope = "alice", hold; const delivered = [], closed = vi.fn(), cancelled = vi.fn();
  const api = createIdentityApi({ tokens: { getStoredToken: () => "opaque" }, sessionKey: () => scope,
    fetch: async () => { await hold(); return new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "text/event-stream" } }); } });
  await heldOperation(controlled("old SSE response", api), boundary => { hold = boundary; return api.openVaultChanges({ onEvent: event => delivered.push(event), onClose: closed }); }, async work => {
    await work.reached(); scope = "bob"; const close = await work.result(); await close();
    expect(delivered).toEqual([]); expect(closed).not.toHaveBeenCalled(); expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
it.each(["openVaultChanges", "openPluginHostEvents"])("%s retires stale response admission without joining an unrelated tee peer", async method => {
  let scope = "alice", hold, requestSignal;
  const delivered = [], closed = vi.fn(), cancelled = vi.fn();
  const [body, peer] = new ReadableStream({ cancel: cancelled }).tee();
  const api = createIdentityApi({ tokens: { getStoredToken: () => "opaque" }, sessionKey: () => scope,
    fetch: async (_, options) => { requestSignal = options.signal; await hold(); return new Response(body, { headers: { "Content-Type": "text/event-stream" } }); } });
  try {
    await heldOperation(controlled("stale tee admission", api), boundary => { hold = boundary; return api[method]({ onEvent: event => delivered.push(event), onClose: closed }); }, async work => {
      try {
        await work.reached(); scope = "bob";
        const opening = work.result(), completed = vi.fn();
        opening.then(completed, completed);
        await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
        const close = await opening; await close();
        expect([requestSignal.aborted, delivered, closed.mock.calls, cancelled.mock.calls]).toEqual([true, [], [], []]);
      } finally { await peer.cancel(); }
    });
  } finally { await peer.cancel(); }
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("pending Settings writes settle independently without giving Bob the old acknowledgement or draft", async () => {
  let identity = "alice", hold; const writes = [];
  const page = { id: "plugin:p:settings", owner: "p", available: true, descriptor: { fields: [{ key: "text", type: "text", default: "" }] } };
  const settings = createSettingsPageState({ getSession: () => identity, confirm: async () => "cancel", registry: {
    find: () => page, read: async () => ({ values: { text: `${identity} base` }, revision: 1 }),
    commit: async (page, values, revision) => { writes.push({ identity, values, revision }); await hold(); return { values, revision: 2 }; },
  } });
  cleanups.push(() => settings.dispose()); await settings.load(page.id); settings.edit(page.id, "text", "A");
  await heldOperation(controlled("original Settings write", settings), boundary => { hold = boundary; return settings.commit(page.id); }, async work => {
    await work.reached(); settings.edit(page.id, "text", "newer retained text"); identity = "bob";
    expect(settings.pageIds()).toEqual([]);
    expect([settings.snapshot(page.id).committed, settings.snapshot(page.id).drafts]).toEqual([{}, {}]);
    await settings.load(page.id);
    expect(settings.snapshot(page.id).committed).toEqual({ text: "bob base" });
    expect(await work.result()).toBe(true);
    const state = settings.snapshot(page.id);
    expect([state.committed, state.drafts, state.dirty]).toEqual([{ text: "bob base" }, {}, false]);
    expect(writes).toEqual([{ identity: "alice", values: { text: "A" }, revision: 1 }]);
    expect(await settings.resolveDeparture([page.id], "logout")).toBe(true);
    identity = "alice";
    expect(settings.snapshot(page.id).committed).toEqual({});
    expect(settings.snapshot(page.id).drafts).toEqual({});
  });
});

it.each(["same Admin", "same login, different account", "demoted", "different vault"])("Settings recovery after re-sign-in: %s", async outcome => {
  const page = { id: "plugin:p:settings", available: true, descriptor: { fields: [{ key: "text", type: "text" }, { key: "other", type: "text" }] } };
  const original = { account: "alice-id", login: "alice", vault: "vault", admin: true, credential: "first" };
  const current = ref(original), writes = [], reads = [];
  let hold;
  const settings = createSettingsPageState({
    getSession: () => current.value?.credential ?? "guest",
    isGuest: () => current.value === null,
    getRecoveryScope: () => current.value?.admin ? JSON.stringify([current.value.account, current.value.vault]) : null,
    canRead: () => current.value?.admin === true, canWrite: () => current.value?.admin === true,
    registry: { find: () => page, async read() {
      reads.push(current.value.credential);
      return current.value.credential === "first" ? { values: { text: "old", other: "old" }, revision: 1 } : { values: { text: "fresh", other: "fresh" }, revision: 5 };
    }, async commit(_, values, revision) {
      writes.push([current.value.credential, values, revision]);
      if (writes.length === 1) await hold();
      return { values, revision: revision + 1 };
    } },
  });
  cleanups.push(() => settings.dispose());
  await settings.load(page.id);
  settings.edit(page.id, "other", "already submitted");
  await heldOperation(controlled("original Settings PUT", settings), boundary => { hold = boundary; return settings.commit(page.id); }, async work => {
    await work.reached();
    settings.edit(page.id, "text", "unsent");
    current.value = null;
    expect(settings.snapshot(page.id).drafts).toEqual({});
    current.value = { ...original, credential: "fresh", ...({
      "same Admin": {}, "same login, different account": { account: "bob-id" }, demoted: { admin: false }, "different vault": { vault: "different" },
    })[outcome] };
    expect(settings.snapshot(page.id).drafts).toEqual({});
    await settings.load(page.id);
    const snapshot = settings.snapshot(page.id);
    expect(snapshot.drafts).toEqual(outcome === "same Admin" ? { text: "unsent" } : {});
    expect(snapshot.committed).toEqual(outcome === "demoted" ? {} : { text: "fresh", other: "fresh" });
    expect(await work.result()).toBe(true);
    expect(writes).toEqual([["first", { text: "old", other: "already submitted" }, 1]]);
    if (outcome === "same Admin") {
      expect(await settings.commit(page.id, "text")).toBe(false);
      expect(await settings.commit(page.id)).toBe(true);
      expect(writes[1]).toEqual(["fresh", { text: "unsent", other: "fresh" }, 5]);
    } else {
      current.value = { ...original, credential: "return" };
      await settings.load(page.id);
      expect(settings.snapshot(page.id).drafts).toEqual({});
    }
    expect(reads).toEqual(outcome === "same Admin" ? ["first", "fresh"] : outcome === "demoted" ? ["first", "return"] : ["first", "fresh", "return"]);
  });
});
it("a retired Settings read cannot publish private settings under its replacement", async () => {
  let identity = "alice", hold;
  const page = { id: "plugin:p:settings", owner: "p", available: true, descriptor: { fields: [] } };
  const settings = createSettingsPageState({ getSession: () => identity, registry: { find: () => page,
    read: async () => { await hold(); return { values: { private: "Alice secret" }, revision: 1 }; } } });
  cleanups.push(() => settings.dispose());
  await heldOperation(controlled("old Settings read", settings), boundary => { hold = boundary; return settings.load(page.id); }, async work => {
    await work.reached(); identity = "bob"; await work.result();
    expect(settings.snapshot(page.id).committed).toEqual({});
  });
});
