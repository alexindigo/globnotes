import { afterEach, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { heldOperation } from "../../tests/helpers/owned_operation.ts";
import { done, READINESS_MS, waitUntil } from "../../tests/helpers/wait.ts";
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
import { createNoteController } from "../noteController.js";
import { createConflictInbox } from "../conflictInbox.js";
import { canCreateNote } from "../noteCreation.js";
import { registerSessionParticipant, resolveParticipants } from "../sessionActions.js";
import { createSettingsPageState } from "../settingsPageState.js";
import { reauthenticationRequest, requestReauthentication } from "../reauthentication.js";
import * as pluginRuntime from "../pluginRuntime.js";
import { createIdentityNoteController } from "../noteController.js";

const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  localStorage.clear(); sessionStorage.clear();
});
const projection = (account = "alice", level = "view", revision = 1) => ({
  principal: account ? { kind: "account", id: account, login: account } : { kind: "guest" }, accountId: account,
  sessionGeneration: account ? `session-${account}` : "guest", vaultId: level === "none" ? null : "vault-one", authorityRevision: revision,
  capabilities: { canRead: level !== "none", canEdit: ["edit", "admin"].includes(level), canManageVault: level === "admin", canManageOwnAccount: !!account, canCreateVault: !!account },
  setupRequired: false, brand: { name: "Fixture" },
});
const controlled = (label, owner) => ({ label, owner: () => owner, progress: { kind: "controlled", clock: "external" } });
it("initial config adopts branding and starts the reader only after publishing readiness", async () => {
  const accepted = projection("alice", "admin"), stored = ref({});
  const events = [], failed = vi.fn();
  const session = createIdentityAppSession({ config: () => stored.value, setConfig: value => { stored.value = value; events.push(["config", session.state.ready]); },
    tokens: { getStoredToken: () => "alice-token" }, transport: { getConfig: async () => accepted }, stopRuntime() {}, failed,
    applyBrand: brand => events.push(["brand", brand, session.state.ready]),
    refreshNotes: () => events.push(["notes", session.state.ready, stored.value.principal.id]),
  });
  cleanups.push(() => session.dispose());
  expect(session.state.ready).toBe(false);
  expect(await session.load()).toBe(true);
  expect([stored.value, events, failed.mock.calls]).toEqual([accepted, [["config", false], ["brand", accepted.brand, true], ["notes", true, "alice"]], []]);
});
it("an initial configuration failure reports its original error without publishing readiness or starting readers", async () => {
  const error = Error("first config failed"), failed = vi.fn(), setConfig = vi.fn(), applyBrand = vi.fn(), refreshNotes = vi.fn();
  const session = createIdentityAppSession({ config: () => ({}), setConfig, stopRuntime() {}, applyBrand, refreshNotes, failed,
    tokens: { getStoredToken: () => null }, transport: { getConfig: async () => { throw error; } },
  });
  cleanups.push(() => session.dispose());
  expect([await session.load(), session.state.ready, session.state.valid, failed.mock.calls, setConfig.mock.calls, applyBrand.mock.calls, refreshNotes.mock.calls]).toEqual([false, false, false, [[error]], [], [], []]);
});
it("concurrent startup consumers share remembered-token refusal and adopt a usable guest shell", async () => {
  const stored = ref({}), guest = projection(null, "none"), failed = vi.fn(), navigate = vi.fn();
  const tokens = createIdentityTokenStorage({ prefix: "/one", setCookie() {} });
  tokens.storeToken("expired.jwt", true);
  const getConfig = vi.fn(async () => {
    if (tokens.getStoredToken()) throw { response: { status: 401 } };
    return guest;
  });
  const session = createIdentityAppSession({ config: () => stored.value, setConfig: value => { stored.value = value; },
    tokens, transport: { getConfig }, stopRuntime() {}, failed, navigate });
  cleanups.push(() => session.dispose());
  const status = vi.fn(() => getConfig()), guard = createIdentityRouteGuard({ status, credentials: () => tokens, session: () => session });
  expect(await Promise.all([guard({ name: "note", fullPath: "/private" }), session.load()]))
    .toEqual([{ name: "login", query: { redirect: "/private" } }, true]);
  expect(status).not.toHaveBeenCalled();
  expect([stored.value, session.state.ready, session.state.valid, tokens.getStoredToken(), getConfig.mock.calls.length, failed.mock.calls, navigate.mock.calls])
    .toEqual([guest, true, true, null, 2, [], []]);
});
function app({ resolve = vi.fn(async () => "proceed"), transport, account = "alice", reloadPage = vi.fn(), storageEvents } = {}) {
  const current = ref(projection(account, "edit")), events = [];
  const tokens = createIdentityTokenStorage({ prefix: "/one", storageEvents, setCookie() {} }); tokens.storeToken("old.jwt", true);
  const io = transport ?? { getConfig: vi.fn(async () => projection(null)), getToken: vi.fn(async () => "fresh.jwt") };
  const session = createIdentityAppSession({ config: () => current.value, setConfig: value => { current.value = value; events.push("config"); }, tokens, transport: io, resolve,
    startRuntime: key => events.push(["runtime", key]), stopRuntime: () => events.push("stop"), setChangesSession: key => events.push(["changes", key]),
    clearBrowseData: () => events.push("clear-browse"), refreshNotes: () => events.push("notes"), applyBrand() {}, navigate: target => events.push(target.name), reloadPage,
  });
  cleanups.push(() => session.dispose()); session.adopt(current.value);
  return { session, current, tokens, io, events, resolve, reloadPage };
}
function flow(f, overrides = {}) {
  const adapters = { session: f.session, credentials: () => ({ username: "bob", password: "password", totp: "123456", rememberMe: true }),
    clearCredentials: vi.fn(), redirect: () => null, navigate: vi.fn(), toast: { add: vi.fn() }, ...overrides };
  const login = createIdentityLoginFlow(adapters); cleanups.push(() => login.dispose());
  return { login, ...adapters };
}

it.each(["this tab", "another tab"])("a different account in %s freezes the old note until explicit reload", async source => {
  const storageEvents = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const f = app({ storageEvents, transport: { getToken: async () => "bob.jwt", getConfig: async () => projection("bob", "edit") } });
  const initial = f.current.value;
  const makeDrafts = identity => createIdentityNoteDraftStore({ prefix: "/one", identity, tokens: f.tokens });
  const drafts = makeDrafts(() => f.current.value);
  let buffer = "base", hold;
  const update = vi.fn(async () => { await hold(); return { path: "Note", content: "old receipt" }; });
  const note = createNoteController({ getContext: () => ({ ...f.current.value, path: "Note", query: {} }),
    sessionKey: f.session.key, captureSession: f.session.capture, reloadRequired: () => f.session.state.reloadRequired,
    router: { push: vi.fn(), replace: vi.fn(), options: { history: { base: "" } }, currentRoute: { value: { fullPath: "/Note#source" } } },
    getLocation: () => ({ pathname: "/Note", search: "", hash: "#source" }),
    drafts, read: async () => ({ path: "Note", content: "base" }), saveOwnerFactory: adapters => createNoteSaveOwner({ ...adapters, update }),
    acquireChanges: () => () => {}, setUnload: vi.fn(), subscribe: () => () => {}, publish: vi.fn(),
  });
  cleanups.push(note.dispose);
  await note.mount(); note.setEditMode();
  note.registerEditor({ getMarkdown: () => buffer, applyAcknowledgement: value => { buffer = value; } });
  buffer = "submitted edit"; note.onEditorInput();
  await heldOperation(controlled("old note wire", note), boundary => { hold = boundary; return note.saveHandler().completion; }, async work => {
    await work.reached();
    buffer = "newer unsaved edit"; note.onEditorInput();
    f.events.length = 0;
    if (source === "this tab") {
      const login = flow(f);
      await login.login.logIn();
      expect(login.navigate).not.toHaveBeenCalled();
    } else {
      const { key } = f.tokens.scope;
      localStorage.setItem(key, "bob.jwt");
      const [[, receive]] = storageEvents.addEventListener.mock.calls;
      receive({ storageArea: localStorage, key, newValue: "bob.jwt" });
      expect(f.session.key()).toBeNull();
      await f.session.settle();
    }
    const notice = f.session.state.reloadRequired;
    expect(notice).toEqual({ detail: "You're now signed in as bob. Reload to continue.", actionLabel: "Reload", action: expect.any(Function) });
    expect(f.current.value).toEqual(initial);
    expect(f.tokens.getStoredToken()).toBe("bob.jwt");
    expect([note.state.editMode, note.state.editorReadOnly, note.state.canModify, note.currentBuffer()]).toEqual([true, true, false, "newer unsaved edit"]);
    expect(note.saveHandler()).toBeNull();
    expect(makeDrafts(() => initial).load("Note", 0)).toBe("newer unsaved edit");
    expect(makeDrafts(() => projection("bob")).load("Note", 0)).toBeNull();
    expect(await work.result()).toMatchObject({ result: { path: "Note", content: "old receipt" } });
    expect([note.state.note.content, note.currentBuffer(), update.mock.calls, f.events.filter(event => ["notes", "config"].includes(event))])
      .toEqual(["base", "newer unsaved edit", [["Note", "Note", "submitted edit", "none", "base"]], []]);
    expect(f.reloadPage).not.toHaveBeenCalled();
    expect(await f.session.refresh()).toBe(false);
    notice.action();
    expect(f.reloadPage).toHaveBeenCalledExactlyOnceWith();
  });
});

it("accepting a renewed credential for the same account does not require reload", async () => {
  const f = app({ transport: { getToken: async () => "alice-renewed.jwt",
     getConfig: async () => ({ ...projection("alice", "edit"), sessionGeneration: "renewed" }) } });
  const authenticated = vi.fn(), fresh = flow(f, { authenticated, credentials: () => ({ username: "alice", password: "password" }) });
  await fresh.login.logIn();
  expect(authenticated).toHaveBeenCalledExactlyOnceWith();
  expect([f.current.value.sessionGeneration, f.session.state.reloadRequired, f.reloadPage.mock.calls]).toEqual(["renewed", null, []]);
});

it.each(["alice", "bob"])("after Alice signs out to guest, signing in as %s respects the document's account", async login => {
  let f;
  const getConfig = vi.fn(async () => f.tokens.getStoredToken() ? projection(login, "edit") : projection(null));
  f = app({ transport: { getToken: vi.fn(async () => `${login}.next`), getConfig } });
  expect(await f.session.logout()).toBe(true);
  await waitUntil(() => f.current.value.principal.kind === "guest" ? done() : pending(f.current.value.principal), { label: "guest projection after logout" });
  expect(f.session.state.reloadRequired).toBeNull();
  const authenticated = vi.fn();
  await flow(f, { credentials: () => ({ username: login, password: "password" }), authenticated }).login.logIn();
  const different = login === "bob";
  expect([f.current.value.principal, f.session.state.valid, authenticated.mock.calls, f.reloadPage.mock.calls]).toEqual(different
    ? [{ kind: "guest" }, false, [], []] : [projection("alice").principal, true, [[]], []]);
  expect(f.session.state.reloadRequired).toEqual(different
    ? { detail: "You're now signed in as bob. Reload to continue.", actionLabel: "Reload", action: expect.any(Function) } : null);
});

it("a replacement installed while the logout clears storage owns the next transition", async () => {
  let token = "original", session, clearing;
  const tokens = { getStoredToken: () => token, storeToken(value) { token = value; }, clearStoredToken() {
    token = null;
    if (clearing) return;
    clearing = true;
    session.acceptToken("renewed", false);
  } };
  const current = ref(projection()), navigate = vi.fn(), getConfig = vi.fn(async () => projection(null));
  session = createIdentityAppSession({ config: () => current.value, setConfig: value => { current.value = value; },
    tokens, transport: { getConfig }, resolve: async () => "proceed", navigate, applyBrand() {}, stopRuntime() {},
  });
  cleanups.push(() => session.dispose()); session.adopt(current.value);
  expect(await session.logout()).toBe(false);
  expect([token, navigate.mock.calls, getConfig.mock.calls]).toEqual(["renewed", [], []]);
  expect(await session.logout()).toBe(true);
  await session.settle();
  expect([token, navigate.mock.calls, current.value.accountId]).toEqual([null, [[{ name: "login" }]], null]);
});

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
    retainForAuthentication() { session.adopt(projection("alice", "view", 2)); } }));
  await expect(session.transport.read("notes")).rejects.toBe(refusal);
  expect([session.state.valid, current.value.authorityRevision, get.mock.calls.map(([path]) => path)]).toEqual([true, 2, ["notes"]]);
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
  let hold, logout;
  const f = app({ transport: { getConfig: async () => { await hold(); return projection(null); } } });
  await heldOperation(controlled("logout recovery", f.session), boundary => {
    hold = boundary;
    logout = f.session.logout();
    return logout.finally(() => f.session.settle());
  }, async work => {
    expect(f.session.logout()).toBe(logout);
    await work.reached();
    expect(f.events.filter(value => value === "login")).toEqual(["login"]);
    expect(await waitUntil(async () => done(await logout), { label: "logout completion while recovery is held" })).toBe(true);
    f.session.acceptToken("alice.jwt", false); f.session.adopt(projection("alice"));
    await work.result();
  });
  expect([f.current.value.accountId, f.tokens.getStoredToken()]).toEqual(["alice", "alice.jwt"]);
}, 3 * READINESS_MS);

it("awaits and reports an asynchronous accepted login callback rejection", async () => {
  let resolveEntered, rejectCallback;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const callback = new Promise((_, reject) => { rejectCallback = reject; });
  // Keep the test-owned promise observed even in the broken flow.
  callback.catch(() => {});
  const failure = Error("navigation rejected"), reportError = vi.fn();
  const f = app({ account: null, transport: { getToken: async () => "bob.jwt", getConfig: async () => projection("bob") } });
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
  expect([readerRuntimeEligibility(true, view, "home"), permissionEligibility(true, view, "home"), permissionEligibility(true, admin, "home")]).toEqual([true, false, true]);
  expect([canCreateNote(view), canCreateNote(projection("alice", "edit"))]).toEqual([false, true]);
  const key = identitySessionKey({ ...view, authType: "anything", token: "raw-token" });
  expect(key).toBe(identitySessionKey(view));
  expect([projection("bob"), projection(null), { ...view, vaultId: "other-vault" }, projection("alice", "view", 2), { ...view, sessionGeneration: "new" }].map(identitySessionKey)).toEqual([
    '[["account","bob"],"session-bob","vault-one",1]', '[["guest"],"guest","vault-one",1]', '[["account","alice"],"session-alice","other-vault",1]', '[["account","alice"],"session-alice","vault-one",2]', '[["account","alice"],"new","vault-one",1]',
  ]);
});
it("the real permission owner starts View runtime without reading Admin requests", async () => {
  const current = ref(projection()), ready = ref(false), start = vi.fn(), readPending = vi.fn(async () => []);
  const permissions = createAppPermissions({ config: () => current.value, configReady: () => ready.value, routeName: () => "home", setupRequested: () => false, refreshConfig() {},
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
    await work.reached(); f.session.invalidate(); f.session.adopt(projection("alice", "none"));
    expect(await work.result()).toBe(false);
    expect(f.current.value).toEqual(projection("alice", "none")); expect(asked).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
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
  const f = app({ account: null, resolve: vi.fn(async () => "cancel") }), login = flow(f);
  await login.login.logIn();
  expect(f.io.getToken).not.toHaveBeenCalled(); expect(login.clearCredentials).not.toHaveBeenCalled(); expect(f.tokens.getStoredToken()).toBe("old.jwt");
  expect(await createIdentityRouteGuard({ status: () => projection(null) })({ name: "login" })).toBe(true);
  expect(await createIdentityRouteGuard({ status: () => projection("bob", "none") })({ name: "account" })).toBe(true);
});
it.each(["view", "none"])("dialog sign-in lands according to the accepted account's %s capability", async level => {
  const f = app({ account: null, transport: { getConfig: async () => projection("bob", level), getToken: async () => "fresh.jwt" } });
  const authenticated = vi.fn();
  const login = flow(f, { authenticated });
  await login.login.logIn();
  expect([authenticated.mock.calls, login.navigate.mock.calls]).toEqual(level === "view" ? [[[]], []] : [[[]], [[{ name: "account" }]]]);
});
it.each([["view", { name: "home" }], ["edit", true]])("new-note navigation requires Edit (%s)", async (level, expected) => {
  const guard = createIdentityRouteGuard({ status: () => projection(null, level) });
  expect(await guard({ name: "new", fullPath: "/_/new" })).toEqual(expected);
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
  const f = app({ account: null, resolve: async () => { events.push("resolve"); await hold(); return "proceed"; }, transport: {
    getToken: vi.fn(async () => { events.push("prove"); return "bob.jwt"; }), getConfig: async () => projection("bob", "none") } }), login = flow(f);
  await heldOperation(controlled("sign-in departure", f.session), boundary => { hold = boundary; return login.login.logIn(); }, async work => {
    await work.reached(); expect(events).toEqual(["resolve"]); expect(f.tokens.getStoredToken()).toBe("old.jwt"); await work.result();
    expect(events).toEqual(["resolve", "prove"]); expect(f.tokens.getStoredToken()).toBe("bob.jwt"); expect(f.current.value).toEqual(projection("bob", "none"));
    expect(login.navigate).toHaveBeenCalledExactlyOnceWith({ name: "account" });
  });
});
it("a logout's delayed anonymous config cannot clear or navigate over a replacement sign-in", async () => {
  let hold; const f = app({ transport: { getConfig: async () => { await hold(); return projection(null); } } });
  await heldOperation(controlled("anonymous logout config", f.session), boundary => { hold = boundary; return f.session.logout(); }, async work => {
    await work.reached(); expect(f.tokens.getStoredToken()).toBeNull(); expect(f.events.filter(value => value === "login")).toEqual(["login"]);
    f.session.acceptToken("alice.jwt", false); f.session.adopt(projection("alice", "none"));
    expect(await work.result()).toBe(true); await f.session.settle();
    expect(f.current.value).toEqual(projection("alice", "none")); expect(f.tokens.getStoredToken()).toBe("alice.jwt"); expect(f.events.filter(value => value === "login")).toEqual(["login"]);
  });
});
it("Logout navigation remains owned by the signed-out generation when other config work settles first", async () => {
  let hold;
  const guest = projection(null), staleAlice = projection("alice", "admin", 99);
  const read = vi.fn().mockImplementationOnce(async () => { await hold(); return guest; }).mockResolvedValue(guest);
  const f = app({ transport: { getConfig: read } });
  await heldOperation(controlled("logout config", f.session), boundary => { hold = boundary; return f.session.logout(); }, async logout => {
    await logout.reached();
    expect(f.tokens.getStoredToken()).toBeNull();
    expect(await f.session.refresh()).toBe(true);
    expect(await logout.result()).toBe(true);
    expect([f.current.value, f.events.filter(event => event === "login")]).toEqual([guest, ["login"]]);
  });
  // A real transport may complete after the old owner has ended; not even a
  // higher server revision can restore the old account from its reply.
  f.session.acceptToken("old.jwt", true); f.session.adopt(projection("alice", "edit"));
  read.mockImplementationOnce(async () => { await hold(); return staleAlice; });
  await heldOperation(controlled("pre-logout config", f.session), boundary => { hold = boundary; return f.session.refresh(); }, async stale => {
    await stale.reached(); expect(await f.session.logout()).toBe(true);
    const after = f.events.slice();
    expect(await stale.result()).toBe(false);
    expect([f.current.value, f.tokens.getStoredToken(), f.events]).toEqual([guest, null, after]);
  });
});
it("a held authority refresh cannot absorb a renewed credential's authority failure", async () => {
  let hold;
  const denied = Object.assign(new Error("Token expired"), { status: 401 });
  const read = vi.fn().mockImplementationOnce(async () => { await hold(); return projection("alice", "admin"); }).mockRejectedValueOnce(denied);
  const f = app({ transport: { getConfig: read } });
  await heldOperation(controlled("old authority read", f.session), boundary => { hold = boundary; return f.session.authorityChanged({ status: 403 }); }, async stale => {
    await stale.reached(); f.session.acceptToken("alice-renewed.jwt", false); f.session.adopt(projection("alice"));
    const checking = f.session.authorityChanged(denied);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await checking).toBe(false);
    expect([f.tokens.getStoredToken(), f.session.key(), f.events.filter(event => event === "login")]).toEqual([null, null, ["login"]]);
    expect(await stale.result()).toBe(false);
  });
});
it("a renewed credential logs out independently while the previous guest read is held", async () => {
  let hold, firstLogout;
  const guest = projection(null);
  const read = vi.fn().mockImplementationOnce(async () => { await hold(); return guest; }).mockResolvedValue(guest);
  const f = app({ transport: { getConfig: read } });
  await heldOperation(controlled("previous Logout", f.session), boundary => { hold = boundary; return firstLogout = f.session.logout(); }, async stale => {
    await stale.reached(); f.session.acceptToken("alice-renewed.jwt", false); f.session.adopt(projection("alice"));
    const logout = f.session.logout();
    expect(logout).not.toBe(firstLogout);
    expect(f.session.logout()).toBe(logout);
    expect(await logout).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await stale.result()).toBe(true);
    await f.session.settle();
    expect([f.current.value, f.tokens.getStoredToken(), f.events.filter(event => event === "login")]).toEqual([guest, null, ["login", "login"]]);
  });
});
it("a rejected Logout participant releases the original reservation without clearing its token", async () => {
  const error = Error("save barrier failed"), resolve = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("proceed");
  const f = app({ resolve }); f.events.length = 0;
  const first = f.session.logout(); expect(f.session.logout()).toBe(first);
  await expect(first).rejects.toBe(error);
  expect([f.tokens.getStoredToken(), f.events]).toEqual(["old.jwt", []]);
  const next = f.session.logout(); expect(next).not.toBe(first); expect(await next).toBe(true);
  expect([resolve.mock.calls, f.tokens.getStoredToken(), f.events.filter(event => event === "login")]).toEqual([[['logout'], ['logout']], null, ["login"]]);
});
it("a credential change still draining cannot defer a renewed credential's authority failure", async () => {
  const denied = { response: { status: 401 } };
  const f = app({ transport: { getConfig: vi.fn().mockRejectedValue(denied) } });
  const finish = f.session.beginCredentialHandoff();
  try {
    expect(await f.session.authorityChanged(denied)).toBe(false);
    expect(f.io.getConfig).not.toHaveBeenCalled();
    f.session.acceptToken("alice-renewed.jwt", false); f.session.adopt(projection("alice"));
    expect(await f.session.authorityChanged(denied)).toBe(false);
    expect([f.tokens.getStoredToken(), f.events.filter(event => event === "login")]).toEqual([null, ["login"]]);
  } finally { finish(); }
  expect(f.io.getConfig).toHaveBeenCalledTimes(1);
});
it.each([200, 401])("a route check from the old credential cannot reopen a note or clear the next credential (%s)", async status => {
  const f = app(); let hold;
  const old = projection("alice", "admin");
  const read = vi.fn(async () => {
    await hold();
    if (status === 401) throw { response: { status } };
    return old;
  });
  const guard = createIdentityRouteGuard({ status: read, credentials: () => f.tokens });
  await heldOperation(controlled("retired note route check", f.session), boundary => {
    hold = boundary; return guard({ name: "note", fullPath: "/private" });
  }, async stale => {
    await stale.reached(); expect(await f.session.logout()).toBe(true);
    // The original token bytes may recur; the browser generation has ended.
    f.session.acceptToken("old.jwt", false); f.session.adopt(old);
    expect(await stale.result()).toBe(false);
    expect([await guard({ name: "login" }), read.mock.calls, f.tokens.getStoredToken()]).toEqual([true, [[]], "old.jwt"]);
  });
});
it("a retained Note's fragment update cannot turn into a sign-in departure", async () => {
  const f = app();
  const status = vi.fn(async () => projection(null, "none"));
  const guard = createIdentityRouteGuard({ status, credentials: () => f.tokens });
  const route = (url, hash = "") => ({ name: "note", fullPath: url + hash, hash });
  const from = route("/private", "#source:L6");
  expect(await guard(route("/private", "#source:L2"), from)).toBe(false);
  expect(status.mock.calls).toEqual([[]]);
  // Opening another note, changing route data, or arriving from outside the
  // already mounted editor still requires ordinary admission.
  for (const [to, previous] of [
    [route("/other", "#source:L2"), from], [route("/private?new=1", "#source:L2"), from],
    [route("/private", "#source:L2"), { name: "login", fullPath: "/_/login", hash: "" }],
  ]) expect(await guard(to, previous)).toEqual({ name: "login", query: { redirect: to.fullPath } });
  expect(status.mock.calls).toEqual([[], [], [], []]);
  status.mockResolvedValue(projection("alice", "admin"));
  expect(await guard(route("/private", "#source:L2"), from)).toBe(true);
});
it("a retired Note load cannot install the old text or report an old 401", async () => {
  let hold;
  const f = app({ transport: { getConfig: async () => projection(null, "none") } });
  const failed = vi.fn(), publish = vi.fn();
  const read = vi.fn(async () => { await hold(); throw { response: { status: 401 } }; });
  const note = createIdentityNoteController({ session: f.session, read, failed, publish,
    getContext: () => ({ path: "Alice private", query: {}, capabilities: f.current.value.capabilities }),
    router: { push: vi.fn(), replace: vi.fn() }, getLocation: () => ({ hash: "" }),
    subscribe: () => () => {}, registerParticipant: () => () => {}, acquireChanges: () => () => {}, setUnload() {} });
  cleanups.push(note.dispose);
  await heldOperation(controlled("old Note load", note), boundary => { hold = boundary; return note.mount(); }, async stale => {
    await stale.reached(); expect(await f.session.logout()).toBe(true);
    const afterRetirement = publish.mock.calls.slice();
    await stale.result(); await note.init();
    expect([note.state.note, note.state.loadStatus, read.mock.calls, failed.mock.calls, publish.mock.calls]).toEqual([
      {}, "loading", [["Alice private"]], [], afterRetirement,
    ]);
  });
});
it("logout keeps its shared completion and reaches ordinary sign-in when the anonymous refresh fails", async () => {
  const error = new Error("offline");
  const getConfig = vi.fn(async () => { throw error; });
  const f = app({ transport: { getConfig } });
  const pending = f.session.logout();
  expect(f.session.logout()).toBe(pending); expect(await pending).toBe(true);
  await f.session.settle();
  expect(getConfig).toHaveBeenCalledExactlyOnceWith({ signal: undefined });
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
  const error = { response: { status } }, failed = vi.fn(), navigate = vi.fn();
  const guest = projection(null, "none"), config = ref({});
  const tokens = createIdentityTokenStorage({ prefix: "/one", setCookie() {} });
  tokens.storeToken("old", true);
  const get = vi.fn(async () => { if (tokens.getStoredToken()) throw error; return { data: guest }; });
  const session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; }, tokens, http: { get }, failed, navigate, retainedWork: () => false });
  cleanups.push(() => session.dispose());
  expect(await session.load()).toBe(status === 401);
  expect([get.mock.calls.length, failed.mock.calls, session.state.ready, session.state.valid, navigate.mock.calls]).toEqual(status === 401
    ? [2, [], true, true, []]
    : [1, [[error]], false, false, []]);
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
    expect(await session.refresh()).toBe(true); expect(session.key()).not.toBe(key);
    await expect(work.result()).rejects.toMatchObject({ staleIdentity: true });
  });
});

it.each(["first-read-first", "newest-read-first"])("sign-in follows the accepted account across concurrent refreshes (%s)", async order => {
  let first, second, reads = 0;
  const f = app({ account: null, transport: { getToken: async () => "bob.jwt", getConfig: async () => {
    const number = reads++; await (number === 0 ? first() : second()); return projection("bob", number === 0 ? "admin" : "view");
  } } });
  const login = flow(f), completed = vi.fn();
  await heldOperation(controlled("sign-in projection", f.session), boundary => { first = boundary; return login.login.logIn().then(completed); }, async original => {
    await original.reached();
    await heldOperation(controlled("newer projection", f.session), boundary => { second = boundary; return f.session.refresh(); }, async newest => {
      await newest.reached();
      if (order === "first-read-first") {
        original.release();
      }
      expect(await newest.result()).toBe(true); await original.result();
      expect(login.navigate.mock.calls).toEqual([[{ name: "home" }]]);
      expect(f.current.value).toEqual(projection("bob", "view"));
    });
  });
});
it.each(["different-account", "revoked"])("a superseding %s cannot complete an old sign-in", async winner => {
  let hold, reads = 0;
  const f = app({ account: null, transport: { getToken: async () => "bob.jwt", getConfig: async () => {
    if (reads++ === 0) { await hold(); return projection("bob", "admin"); }
    if (winner === "revoked") throw Object.assign(new Error("revoked"), { status: 401 });
    return projection("charlie", "view");
  } } });
  const login = flow(f);
  await heldOperation(controlled("old sign-in", f.session), boundary => { hold = boundary; return login.login.logIn(); }, async original => {
    await original.reached(); await f.session.refresh(); await original.result();
    expect(login.navigate.mock.calls).toEqual([]);
    expect([f.current.value.principal, f.session.state.valid, f.session.state.reloadRequired]).toEqual([
      projection(winner === "revoked" ? null : "charlie").principal, winner !== "revoked", null,
    ]);
  });
});
it.each([401, 503])("a %s after credential retirement still withdraws the old capabilities", async status => {
  const f = app({ transport: { getConfig: async () => { throw Object.assign(new Error("unavailable"), { status }); } } });
  const initial = f.current.value;
  expect(f.session.acceptToken("alice-renewed.jwt", false)).toBe(true);
  expect([f.session.key(), f.current.value]).toEqual([null, initial]);
  expect(await f.session.refresh()).toBe(false);
  expect([f.session.key(), f.current.value, f.session.state.reloadRequired]).toEqual([null,
    { ...initial, capabilities: { canRead: false, canEdit: false, canManageVault: false, canManageOwnAccount: false, canCreateVault: false } }, null]);
});
it("config rejection stays with the original refresh instead of recursively reporting authority", async () => {
  const error = Object.assign(new Error("invalid token"), { status: 401 }), authority = vi.fn();
  const tokens = createIdentityTokenStorage({ prefix: "/one", setCookie() {} });
  tokens.storeToken("bad", true);
  const api = createIdentityApi({ tokens, sessionKey: () => null,
    http: { get: async () => { throw error; } }, onAuthorityFailure: authority });
  await expect(api.getConfig()).rejects.toBe(error); expect(authority.mock.calls).toEqual([]);
  const fresh = ref(projection()), navigate = vi.fn(), failed = vi.fn();
  const session = createIdentityAppSession({ config: () => fresh.value, setConfig: value => { fresh.value = value; },
    tokens, transport: api, navigate, failed, stopRuntime() {} }); cleanups.push(() => session.dispose());
  expect(await session.load()).toBe(false);
  expect([session.state.ready, session.state.valid, navigate.mock.calls, failed.mock.calls]).toEqual([false, false, [], [[error]]]);
  expect([tokens.getStoredToken(), localStorage.getItem(tokens.scope.key)]).toEqual([null, null]);
});
it("loaded-session recovery uses the existing reconnect owner with no live stream or retained capabilities", async () => {
  let session, unavailable = true;
  const timers = [], clears = [], opened = [], failed = vi.fn(), fresh = ref(projection()), token = "alice.jwt";
  const changes = createVaultChanges({ sessionKey: () => session.key(), open: async () => { opened.push(session.key()); return () => {}; },
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimer: value => clears.push(value) });
  cleanups.push(() => changes.dispose());
  session = createIdentityAppSession({ config: () => fresh.value, setConfig: value => { fresh.value = value; },
    tokens: { getStoredToken: () => token }, transport: { getConfig: async () => {
      if (unavailable) throw Object.assign(new Error("restart"), { status: 503 }); return projection("alice", "edit", 2);
    } }, failed, stopRuntime() {}, applyBrand() {}, setChangesSession: changes.setSession, recover: changes.revalidate });
  cleanups.push(() => session.dispose()); session.adopt(fresh.value);
  expect(await session.refresh()).toBe(false); await changes.settle();
  expect([session.state.valid, fresh.value.capabilities, failed.mock.calls, timers.map(timer => timer.delay), opened]).toEqual([
    false, { canRead: false, canEdit: false, canManageVault: false, canManageOwnAccount: false, canCreateVault: false }, [], [500], [],
  ]);
  unavailable = false; timers[0].callback(); await changes.settle();
  expect([session.state.valid, fresh.value, opened]).toEqual([true, projection("alice", "edit", 2), []]);
  expect(clears).toEqual([]);
});
it("a superseded recovery keeps the retry slot when its replacement is also unavailable", async () => {
  const fresh = ref(projection()), retry = Object.assign(Error("restart"), { status: 503 });
  const held = Promise.withResolvers(), entered = Promise.withResolvers(), timers = [];
  const getConfig = vi.fn().mockRejectedValueOnce(retry).mockImplementationOnce(() => { entered.resolve(); return held.promise; })
    .mockRejectedValueOnce(retry).mockResolvedValueOnce(projection("alice", "edit", 2));
  const changes = createVaultChanges({ setTimer(fn, delay) { timers.push({ fn, delay }); return fn; }, clearTimer() {} });
  const session = createIdentityAppSession({ config: () => fresh.value, setConfig: value => { fresh.value = value; },
    tokens: { getStoredToken: () => "alice" }, transport: { getConfig }, stopRuntime() {}, applyBrand() {},
    recover: changes.revalidate, setChangesSession: changes.setSession });
  cleanups.push(changes.dispose, session.dispose); session.adopt(fresh.value);
  try {
    expect(await session.refresh()).toBe(false); await entered.promise;
    expect(await session.refresh()).toBe(false);
    held.reject(retry); await changes.settle();
    expect(timers.map(timer => timer.delay)).toEqual([500]);
    timers[0].fn(); await changes.settle();
    expect([session.state.valid, fresh.value, getConfig.mock.calls.length]).toEqual([true, projection("alice", "edit", 2), 4]);
  } finally { held.reject(retry); }
});
it("ordinary EOF reconnects with the last vault cursor and does not retire live config", async () => {
  let session, source; const fresh = ref(projection()), scheduled = [], requests = [];
  const api = createIdentityApi({ tokens: { getStoredToken: () => "alice" }, sessionKey: () => session.key(),
    fetch: async input => { requests.push(new URL(input, "http://fixture").searchParams.get("since"));
      return new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "Content-Type": "text/event-stream" } }); },
    onAuthorityFailure: vi.fn(() => session.invalidate()) });
  const changes = createVaultChanges({ sessionKey: () => session.key(), open: api.openVaultChanges,
    setTimer(fn, delay) { scheduled.push({ fn, delay }); return fn; }, clearTimer() {} });
  session = createIdentityAppSession({ config: () => fresh.value, setConfig: value => { fresh.value = value; },
    tokens: { getStoredToken: () => "alice" }, transport: api, applyBrand() {}, stopRuntime() {}, setChangesSession: changes.setSession });
  cleanups.push(changes.dispose, session.dispose); session.adopt(fresh.value);
  const release = changes.acquire(); cleanups.push(release);
  await changes.settle();
  source.enqueue(new TextEncoder().encode('event: change\ndata: {"seq":7}\n\n')); source.close();
  await vi.waitFor(() => expect(scheduled.map(entry => entry.delay)).toEqual([500]));
  scheduled[0].fn(); await changes.settle(); source.close();
  await vi.waitFor(() => expect(scheduled.map(entry => entry.delay)).toEqual([500, 1000]));
  expect([session.state.valid, requests]).toEqual([true, ["0", "7"]]);
});
it("identity reauthentication restores only the runtime owned by the accepted projection", async () => {
  const legacyStart = vi.spyOn(pluginRuntime, "startPluginRuntime"), legacyStop = vi.spyOn(pluginRuntime, "stopPluginRuntime");
  const fresh = ref(projection()), startRuntime = vi.fn(); let token = "old";
  const getConfig = vi.fn().mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce(projection("alice", "edit", 2));
  const session = createIdentityAppSession({ config: () => fresh.value, setConfig: value => { fresh.value = value; },
    tokens: { getStoredToken: () => token, storeToken: value => { token = value; }, clearStoredToken: () => { token = null; } },
    transport: { getConfig }, stopRuntime() {}, applyBrand() {}, retainedWork: () => true, startRuntime });
  cleanups.push(session.dispose); session.adopt(fresh.value);
  try {
    const legacy = requestReauthentication();
    await vi.waitFor(() => expect(reauthenticationRequest.value).not.toBeNull());
    const obsolete = reauthenticationRequest.value;
    legacyStop.mockClear();
    expect(await session.refresh()).toBe(false);
    await vi.waitFor(() => expect(reauthenticationRequest.value?.id).toBeGreaterThan(obsolete.id));
    const form = reauthenticationRequest.value;
    expect(await obsolete.authenticated()).toBe(false);
    expect(await legacy).toBe(false);
    expect(await requestReauthentication()).toBe(false);
    expect((await session.signIn("new", { login: "alice" })).current()).toBe(true);
    expect(await form.authenticated()).toBe(true);
    expect([startRuntime.mock.calls.length, legacyStart.mock.calls, legacyStop.mock.calls, reauthenticationRequest.value]).toEqual([2, [], [], null]);
  } finally { reauthenticationRequest.value?.cancel(); legacyStart.mockRestore(); legacyStop.mockRestore(); }
});
it("denied optional Admin work revalidates a live reader without restarting its runtime", async () => {
  const f = app({ transport: { getConfig: vi.fn(async () => projection("alice", "view")) } });
  f.session.adopt(projection("alice", "view")); const before = f.session.key(), events = [...f.events];
  expect(await f.session.authorityChanged({ status: 403 })).toBe(true);
  expect([f.session.key(), f.session.state.valid, f.events.slice(events.length)]).toEqual([before, true, ["config"]]);
  expect(f.io.getConfig.mock.calls).toEqual([[{ signal: undefined }]]);
});
it("a current 401 retires the reader and fences the older optional Admin recheck", async () => {
  let hold;
  const denied = Object.assign(Error("revoked"), { status: 401 });
  const getConfig = vi.fn().mockImplementationOnce(async () => { await hold(); return projection("alice", "admin", 9); }).mockRejectedValueOnce(denied);
  const f = app({ transport: { getConfig } });
  await heldOperation(controlled("obsolete Admin recheck", f.session), boundary => {
    hold = boundary; return f.session.authorityChanged({ status: 403 });
  }, async old => {
    await old.reached();
    expect(f.session.state.valid).toBe(true);
    const refusal = f.session.authorityChanged(denied);
    expect([f.session.key(), f.current.value.capabilities.canRead, getConfig.mock.calls.length]).toEqual([null, false, 2]);
    expect(await refusal).toBe(false);
    expect(await old.result()).toBe(false);
    expect([f.session.state.valid, f.current.value.authorityRevision]).toEqual([false, 1]);
  });
});
it("replacement credentials cancel held recovery and cannot adopt its old projection", async () => {
  let session, hold, token = "alice.jwt", reads = 0;
  const fresh = ref(projection()), timers = [];
  const changes = createVaultChanges({ sessionKey: () => session.key(), setTimer: (callback, delay) => { timers.push({ callback, delay }); return callback; }, clearTimer() {} });
  cleanups.push(() => changes.dispose());
  session = createIdentityAppSession({ config: () => fresh.value, setConfig: value => { fresh.value = value; },
    tokens: { getStoredToken: () => token, storeToken: value => { token = value; } }, transport: { getConfig: async () => {
      if (reads++ === 0) throw Object.assign(new Error("restart"), { status: 503 });
      await hold(); return projection("alice", "admin", 9);
    } }, stopRuntime() {}, applyBrand() {}, setChangesSession: changes.setSession, recover: changes.revalidate });
  cleanups.push(() => session.dispose()); session.adopt(fresh.value);
  await heldOperation(controlled("held recovery", session), boundary => { hold = boundary; return session.refresh().then(async result => { await changes.settle(); return result; }); }, async work => {
    await work.reached(); session.acceptToken("alice-renewed.jwt", false); session.adopt(projection("alice", "view", 2));
    expect(await work.result()).toBe(false);
    expect([token, session.state.valid, fresh.value, timers]).toEqual(["alice-renewed.jwt", true, projection("alice", "view", 2), []]);
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

it("the app stops the real scoped index instead of adopting a different account", async () => {
  let session, hold, calls = 0;
  const current = ref(projection()), store = { notePaths: [], noteMeta: [], recentlyOpened: [] };
  const index = createIdentityNoteIndex({ store, sessionKey: () => session.key(), canRead: () => current.value.capabilities.canRead,
    read: async () => { if (++calls === 1) { await hold(); return [{ path: "Alice private" }]; } return [{ path: "Bob note" }]; }, subscribeAction: () => () => {}, subscribeChanges: () => () => {} });
  let reading;
  session = createIdentityAppSession({ config: () => current.value, setConfig: next => { current.value = next; }, tokens: { getStoredToken: () => null }, transport: {}, stopRuntime() {}, applyBrand() {},
    setBrowseSession: index.setSession, refreshNotes: () => { reading = index.refresh(); } });
  cleanups.push(() => session.dispose(), () => index.dispose());
  await heldOperation(controlled("app index read", index), boundary => { hold = boundary; session.adopt(current.value); return reading; }, async work => {
    await work.reached(); session.adopt(projection("bob"));
    expect(store.notePaths).toEqual([]); await work.result(); expect(store.notePaths).toEqual([]);
    expect(calls).toBe(1); expect(session.adopt(projection("alice"))).toBe(false);
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
    expect(f.current.value).toEqual(projection("alice", "edit")); expect(f.tokens.getStoredToken()).toBe("bob.jwt");
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
  expect(current.value).toEqual(projection("bob")); expect(started).toEqual([session.key()]);
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
  let identity = "alice", hold; const writes = [], outcomes = [];
  const page = { id: "plugin:p:settings", owner: "p", available: true, descriptor: { fields: [{ key: "text", type: "text", default: "" }] } };
  const settings = createSettingsPageState({ getSession: () => identity, confirm: async () => "cancel", registry: {
    find: () => page, read: async () => ({ values: { text: `${identity} base` }, revision: 1 }),
    commit: async (page, values, revision) => { writes.push({ identity, values, revision }); await hold(); outcomes.push("wire returned"); return { values, revision: 2 }; },
  } });
  cleanups.push(() => settings.dispose()); await settings.load(page.id); settings.edit(page.id, "text", "A");
  await heldOperation(controlled("original Settings write", settings), boundary => { hold = boundary; return settings.commit(page.id); }, async work => {
    await work.reached(); settings.edit(page.id, "text", "newer retained text"); identity = "bob";
    expect(settings.pageIds()).toEqual([]);
    const settlement = settings.settle().then(ok => { outcomes.push(["settled", ok]); });
    expect([settings.snapshot(page.id).committed, settings.snapshot(page.id).drafts]).toEqual([{}, {}]);
    await settings.load(page.id);
    expect(settings.snapshot(page.id).committed).toEqual({ text: "bob base" });
    expect(await work.result()).toBe(true);
    await settlement;
    expect(outcomes).toEqual(["wire returned", ["settled", true]]);
    const state = settings.snapshot(page.id);
    expect([state.committed, state.drafts, state.dirty]).toEqual([{ text: "bob base" }, {}, false]);
    expect(writes).toEqual([{ identity: "alice", values: { text: "A" }, revision: 1 }]);
    expect(await settings.resolveDeparture([page.id], "logout")).toBe(true);
    identity = "alice";
    expect(settings.snapshot(page.id).committed).toEqual({});
    expect(settings.snapshot(page.id).drafts).toEqual({});
  });
});

it.each([false, true])("a retired Settings failure requires read-back after two same-owner renewals (intervening write: %s)", async intervening => {
  const generation = ref("first"), writes = [];
  const initial = { values: { text: "base", other: "base" }, revision: 1 };
  const changed = { values: { text: "changed elsewhere", other: "base" }, revision: 2 };
  let remote = initial;
  const page = { id: "plugin:p:settings", available: true, descriptor: { fields: [{ key: "text", type: "text" }, { key: "other", type: "text" }] } };
  let hold;
  const settings = createSettingsPageState({ getSession: () => generation.value, getRecoveryScope: () => "alice/vault", registry: {
    find: () => page, read: async () => remote,
    async commit(_, values, revision) {
      writes.push([generation.value, values, revision]);
      if (writes.length === 1) { await hold(); throw Error("Lost write response"); }
      return { values, revision: revision + 1 };
    },
  } });
  cleanups.push(() => settings.dispose()); await settings.load(page.id);
  settings.edit(page.id, "text", "submitted"); settings.edit(page.id, "other", "old typing");
  await heldOperation(controlled("old Settings failure", settings), boundary => { hold = boundary; return settings.commit(page.id); }, async work => {
    await work.reached(); settings.edit(page.id, "other", "newer typing"); generation.value = "fresh";
    await settings.load(page.id);
    const settlement = settings.settle();
    expect(await work.result()).toBe(false);
    expect(await settlement).toBe(false);
    const snapshot = () => {
      const { committed, drafts, message, recovery } = settings.snapshot(page.id);
      return [committed, drafts, message, recovery];
    };
    const retained = { text: "submitted", other: "newer typing" };
    const recovery = { visible: true, label: "Check current status" };
    expect(snapshot()).toEqual([initial.values, retained, "Lost write response", recovery]);
    if (intervening) remote = changed;
    generation.value = "renewed again";
    await settings.load(page.id);
    expect(snapshot()).toEqual([remote.values, retained, "Lost write response", recovery]);
    expect(await settings.settle()).toBe(false);
    expect(await settings.commit(page.id)).toBe(false);
    expect(await settings.retry(page.id)).toBe(!intervening);
    const original = ["first", { text: "submitted", other: "old typing" }, 1];
    expect(writes).toEqual(intervening ? [original] : [original, ["renewed again", retained, 1]]);
    expect(settings.snapshot(page.id).drafts).toEqual(intervening ? retained : {});
    if (intervening) expect(settings.snapshot(page.id).message).toBe("Settings changed elsewhere. Your draft is retained.");
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
    captureCredential: () => { const credential = current.value?.credential; return () => current.value?.credential === credential; },
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
