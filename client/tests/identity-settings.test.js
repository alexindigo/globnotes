import { afterEach, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { heldOperation } from "../../tests/helpers/owned_operation.ts";
import { createIdentityAccountPage, createIdentitySettingsControllers } from "../identitySettings.js";
import { createIdentityAppSession } from "../appSession.js";
import { identitySessionKey } from "../appSessionPolicy.js";
import AccountSettings from "../components/settings/AccountSettings.vue";
import AccessSettings from "../components/settings/AccessSettings.vue";
import { registerSessionParticipant, resolveParticipants } from "../sessionActions.js";
import { createIdentityApplication } from "../identityApplication.js";

const closes = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const configFor = (account = "alice", revision = 0, level = "admin") => ({
  accountId: account, principal: { kind: "account", id: account, login: account }, sessionGeneration: `session-${account}`,
  vaultId: "vault", authorityRevision: revision, capabilities: { canRead: true, canManageVault: level === "admin" },
});
const accountView = login => ({ id: login, login, credentialRevision: 0, totpEnabled: false });
const accessView = login => ({ revision: 0, signature: "signature", everybody: "view", grants: { [login]: "admin" }, named: [{ id: login, login }], declaredAdmin: null });
const controlled = (label, owner) => ({ label, owner: () => owner, progress: { kind: "controlled", clock: "external" } });
function fixture(options = {}) {
  const config = ref(configFor()); let token = "alice-token";
  const account = { read: vi.fn(async () => accountView(config.value.accountId)), write: vi.fn(), enrol: vi.fn() };
  const access = { read: vi.fn(async () => accessView(config.value.accountId)), write: vi.fn(), createAccount: vi.fn() };
  const session = { key: () => identitySessionKey(config.value), snapshot: () => config.value,
    tokens: { getStoredToken: () => token, clearStoredToken: vi.fn(() => { token = null; }) },
    refresh: vi.fn(async () => true), invalidate: vi.fn(), logout: vi.fn(), beginCredentialHandoff: () => () => {}, ...options.session };
  const navigate = vi.fn(), toast = { add: vi.fn() };
  const controllers = createIdentitySettingsControllers({ session, account, access, navigate, toast,
    confirmDeparture: async () => "discard", ...options });
  closes.push(controllers.dispose);
  return { config, account, access, session, controllers, navigate, toast,
    replace(name = "bob", revision = 0) { token = `${name}-token`; config.value = configFor(name, revision); } };
}
it.each([[AccountSettings, "account"], [AccessSettings, "access"]])("clean replacement renders only the new owner in %s", async (View, kind) => {
  const f = fixture(); await f.controllers[kind].load();
  const wrapper = mount(View, { props: { controller: f.controllers[kind] } }); closes.push(() => wrapper.unmount());
  expect(wrapper.text()).toContain("alice"); f.replace(); await nextTick();
  await vi.waitFor(() => expect(f.controllers[kind].state.view).not.toBeNull());
  await wrapper.setProps({ controller: f.controllers[kind] });
  expect([wrapper.text().includes("alice"), wrapper.text().includes("bob")]).toEqual([false, true]);
});
it("clean full-identity replacement fences the original held Account read", async () => {
  const f = fixture(), old = f.controllers.account; let hold;
  f.account.read.mockImplementationOnce(async () => { await hold(); return accountView("obsolete"); });
  await heldOperation(controlled("old account read", old), boundary => { hold = boundary; return old.load(); }, async work => {
    await work.reached(); f.replace("alice", 1); await nextTick();
    expect(f.controllers.account).not.toBe(old); await f.controllers.account.load();
    expect(await work.result()).toBeNull();
    expect([old.state.view, f.controllers.account.state.view.login]).toEqual([null, "alice"]);
  });
});
it("dirty Account retains its text until explicit local discard, with no replacement read", async () => {
  const f = fixture(), old = f.controllers.account; await old.load(); old.setField("newPassword", "retained");
  f.replace(); await nextTick(); expect(f.controllers.account).toBe(old); expect(await old.load()).toBeNull();
  expect(old.state.newPassword).toBe("retained");
  expect(await f.controllers.resolveDeparture("changing accounts", "discard")).toBe(true);
  expect(f.account.read.mock.calls).toEqual([[{ token: "alice-token" }]]);
  expect(f.controllers.account).not.toBe(old); await f.controllers.account.load(); expect(f.controllers.account.state.view.login).toBe("bob");
});
it("excluded Access submitter remains retained while another participant settles", async () => {
  const f = fixture({ resolve: resolveParticipants }); await f.controllers.access.load();
  const access = f.controllers.access; let hold;
  closes.push(registerSessionParticipant("i14b-held-note", { hasUnsavedChanges: () => true, requestDecision: async () => "save", save: async () => { await hold(); return true; } }));
  access.setEverybody("none"); f.access.write.mockRejectedValueOnce({ response: { status: 409 } });
  await heldOperation(controlled("note settlement", access), boundary => { hold = boundary; return access.requestCommit(); }, async work => {
    await work.reached(); f.config.value = configFor("alice", 1); await nextTick();
    expect(f.controllers.work()).toEqual([]); expect(f.controllers.retainedWork()).toEqual(["access"]);
    expect(f.controllers.access).toBe(access); expect(f.access.write).not.toHaveBeenCalled();
    expect(await work.result()).toBe(false);
    expect(f.access.write.mock.calls.map(([payload, options]) => [payload.everybody, options])).toEqual([["none", { token: "alice-token" }]]);
    expect([access.state.needsReview, access.state.everybody]).toEqual([true, "none"]);
  });
});
it("self-demotion projection cannot dispose its original late Access acknowledgment", async () => {
  const f = fixture(); await f.controllers.access.load(); const access = f.controllers.access; let hold;
  access.setLevel("alice", "view"); await access.requestCommit();
  f.access.write.mockImplementationOnce(async payload => { await hold(); return { committed: true, updateId: payload.updateId, capabilities: { canManageVault: false } }; });
  await heldOperation(controlled("original ACL wire", access), boundary => { hold = boundary; return access.confirmChange(); }, async work => {
    await work.reached(); f.config.value = { ...configFor("alice", 2, "view"), vaultId: null }; await nextTick();
    expect(f.controllers.access).toBe(access); expect(await work.result()).toBe(true);
    expect([access.state.status, access.state.unknown, access.state.mutable]).toEqual(["Access saved.", false, false]);
    expect(f.access.write.mock.calls.map(([, options]) => options)).toEqual([{ token: "alice-token" }]);
  });
});
it.each(["demotion", "replacement"])("retained Access work does not render old Admin rows after %s", async change => {
  const f = fixture(); const original = f.controllers.access;
  await original.load(); original.setEverybody("none");
  const wrapper = mount(AccessSettings, { props: { controller: original } }); closes.push(() => wrapper.unmount());
  expect(wrapper.get('[data-account-row="alice"]').text()).toContain("alice");
  if (change === "demotion") f.config.value = configFor("alice", 1, "view");
  else f.replace();
  await nextTick();
  expect([f.controllers.access === original, original.state.dirty, wrapper.findAll('[data-account-row]').length,
    wrapper.find('[data-everybody-row]').exists()]).toEqual([true, true, 0, false]);
});
it("instance Account keeps its own read through vault policy changes, but not account replacement", async () => {
  const f = fixture(); let hold;
  const page = createIdentityAccountPage({ session: f.session, account: f.account, navigate: f.navigate, toast: f.toast }); closes.push(page.dispose);
  f.account.read.mockImplementationOnce(async () => { await hold(); return accountView("alice"); });
  await heldOperation(controlled("instance account", page), boundary => { hold = boundary; return page.load(); }, async work => {
    await work.reached(); f.config.value = { ...configFor("alice", 1), vaultId: null };
    expect((await work.result()).login).toBe("alice"); f.replace(); expect(await page.load()).toBeNull();
  });
});
it("credential handoff defers expected authority failure until the admitted change signs out", async () => {
  const config = ref(configFor()); let token = "alice-token", hold;
  const session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; },
    tokens: { getStoredToken: () => token, clearStoredToken: () => { token = null; } },
    transport: { getConfig: vi.fn() }, stopRuntime() {}, applyBrand() {} }); closes.push(() => session.dispose()); session.adopt(config.value);
  const write = vi.fn(async payload => { await hold(); return { requiresLogin: true, updateId: payload.updateId }; }), navigate = vi.fn();
  const controllers = createIdentitySettingsControllers({ session, navigate, toast: { add() {} }, resolve: async () => "proceed",
    account: { read: async () => accountView("alice"), write } }); closes.push(controllers.dispose);
  const page = controllers.account; await page.load(); page.setField("currentPassword", "old"); page.setField("newPassword", "new"); page.setField("confirmPassword", "new"); await page.requestChange();
  await heldOperation(controlled("credential PATCH", page), boundary => { hold = boundary; return page.confirmChange(); }, async work => {
    await work.reached(); expect(await session.authorityChanged({ status: 401 })).toBe(false);
    config.value = { ...config.value, authorityRevision: 1 }; await nextTick(); expect(controllers.account).toBe(page);
    expect(await work.result()).toBe(true); expect(token).toBeNull(); expect(navigate.mock.calls).toEqual([[{ name: "login" }]]);
    expect(write.mock.calls.map(([, options]) => options)).toEqual([{ token: "alice-token" }]);
  });
});
it("clean forms wait for the new projection instead of reading during token retirement", async () => {
  const config = ref(configFor()), token = ref("alice-token");
  const session = createIdentityAppSession({ config: () => config.value, setConfig: value => { config.value = value; },
    tokens: { getStoredToken: () => token.value, storeToken: value => { token.value = value; } }, transport: {}, stopRuntime() {}, applyBrand() {} });
  closes.push(() => session.dispose()); session.adopt(config.value);
  const read = vi.fn(async () => accountView(config.value.accountId));
  const controllers = createIdentitySettingsControllers({ session, navigate: vi.fn(), toast: { add() {} }, account: { read } }); closes.push(controllers.dispose);
  await controllers.account.load(); const old = controllers.account;
  session.acceptToken("bob-token", false);
  expect([session.key(), read.mock.calls, controllers.account === old]).toEqual([null, [[{ token: "alice-token" }]], true]);
  session.adopt(configFor("bob")); await vi.waitFor(() => expect(controllers.account.state.view?.login).toBe("bob"));
  expect(read.mock.calls).toEqual([[{ token: "alice-token" }], [{ token: "bob-token" }]]);
});
it("group disposal fences every form before a sibling's original read finishes draining", async () => {
  const f = fixture({ resolve: async () => "proceed" }), page = f.controllers.account;
  await page.load(); page.setField("currentPassword", "old"); page.setField("newPassword", "new"); page.setField("confirmPassword", "new"); await page.requestChange();
  let holdWrite, holdRead;
  f.account.write.mockImplementationOnce(async payload => { await holdWrite(); return { requiresLogin: true, updateId: payload.updateId }; });
  f.access.read.mockImplementationOnce(async () => { await holdRead(); return accessView("alice"); });
  await heldOperation(controlled("disposing credential wire", page), boundary => { holdWrite = boundary; return page.confirmChange(); }, async writing => {
    await writing.reached();
    await heldOperation(controlled("disposing Access read", f.controllers), boundary => { holdRead = boundary; return f.controllers.access.load(); }, async reading => {
      await reading.reached(); const closing = f.controllers.dispose(); expect(f.controllers.dispose()).toBe(closing);
      const result = await writing.result();
      try { expect([result, f.navigate.mock.calls, f.session.tokens.clearStoredToken.mock.calls]).toEqual([false, [], []]); }
      finally { await reading.result(); expect((await closing).errors).toEqual([]); }
    });
  });
});
it("prepared application hands setup to the accepted account and reader catalog, without a manifest request", async () => {
  const config = ref({ ...configFor(null), setupRequired: true, principal: { kind: "guest" }, sessionGeneration: "guest", capabilities: { canRead: false } });
  let token = null;
  const read = vi.fn(async path => path === "note-index" ? [] : ({ plugins: [{ id: "on", name: "On", enabled: true, version: "1", client: { editor: true }, manifest: "private" }, { id: "off", enabled: false }] }));
  const submit = vi.fn(async () => ({ access_token: "alice-token" })), navigate = vi.fn();
  const app = createIdentityApplication({ config: () => config.value, setConfig: value => { config.value = value; },
    tokens: { getStoredToken: () => token, storeToken: value => { token = value; } },
    transport: { read, getConfig: async () => configFor(), openPluginHostEvents: async () => () => {}, openVaultChanges: async () => () => {} },
    store: { notePaths: [], noteMeta: [], recentlyOpened: [] }, index: { subscribeAction: () => () => {}, subscribeChanges: () => () => {} },
    runtime: { createSdk: () => ({}), importModule: async () => ({}), removeOwner() {} },
    setup: { submit }, navigate, toast: { add() {} }, applyBrand() {}, resolve: async () => "proceed" }); closes.push(app.dispose);
  expect(read.mock.calls).toEqual([]); app.session.adopt(config.value);
  app.setup.setField("username", "alice"); app.setup.setField("password", "password"); app.setup.setField("everybody", "none");
  expect(await app.setup.finish()).toBe(true);
  expect([token, app.session.state.valid, navigate.mock.calls, app.setup.state.password]).toEqual(["alice-token", true, [[{ name: "home" }]], ""]);
  expect(submit.mock.calls.map(([payload]) => [payload.username, payload.password, payload.everybody])).toEqual([["alice", "password", "none"]]);
  expect(await app.readerPlugins()).toEqual([{ id: "on", name: "On", version: "1", client: { editor: true } }]);
  expect(read.mock.calls).toEqual([["plugin-host"], ["note-index"], ["plugin-host"]]);
  const closing = app.dispose(); expect(app.dispose()).toBe(closing); expect((await closing).errors).toEqual([]);
});
