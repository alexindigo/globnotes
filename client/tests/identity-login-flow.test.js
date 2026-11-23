// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { createIdentityLoginFlow, createIdentityLoginState } from "../loginFlow.js";
import { createIdentityAppSession } from "../appSession.js";

const controllers = [];
afterEach(async () => { for (const c of controllers.splice(0)) await c.dispose(); });
const owned = c => { controllers.push(c); return c; };
function session(request = async () => "token") {
  const accepted = { principal: { passwordChangeRequired: true }, current: () => true };
  return { transport: { getToken: vi.fn(request) }, acceptToken: vi.fn(), acceptProjection: vi.fn(async () => accepted), accepted,
    beforeSignIn: async () => true, capture: () => () => true, retainLoginProof: vi.fn() };
}
it("temporary sign-in hands off the exact just-proven password, then clears the form", async () => {
  const s = session(), navigate = vi.fn(), fields = { username: "jordan", password: "temporary" }, clear = vi.fn(() => { fields.password = ""; });
  const c = owned(createIdentityLoginFlow({ session: s, credentials: () => fields, clearCredentials: clear, navigate, redirect: () => "/note", toast: { add: vi.fn() } }));
  await c.logIn(); expect([s.retainLoginProof.mock.calls, navigate.mock.calls, fields.password]).toEqual([[[{ username: "jordan", password: "temporary" }, s.accepted]], [[{ name: "account" }]], ""]);
});
it("safe authenticator step preserves the password and is not an authority failure", async () => {
  const error = { response: { status: 401, data: { code: "authenticator_required" } } }, s = session(async () => { throw error; });
  const clear = vi.fn(), challenge = vi.fn(() => true), reportError = vi.fn();
  const c = owned(createIdentityLoginFlow({ session: s, credentials: () => ({ username: "alice", password: "password" }), clearCredentials: clear, challenge, reportError, toast: { add: vi.fn() } }));
  await c.logIn(); expect([challenge.mock.calls, clear.mock.calls, reportError.mock.calls, s.acceptToken.mock.calls]).toEqual([[[error]], [], [], []]);
});
it("rejected code clears only the attempted code, then the next submission keeps the password", async () => {
  const challenge = { response: { status: 401, data: { code: "authenticator_required" } } }, rejected = { response: { status: 401 } };
  const s = session(); s.transport.getToken.mockRejectedValueOnce(challenge).mockRejectedValueOnce(rejected).mockResolvedValueOnce("token");
  const c = owned(createIdentityLoginState({ session: s, navigate: vi.fn(), toast: { add: vi.fn() } }));
  c.setField("username", "alice"); c.setField("password", "password"); await c.submit();
  c.setField("totp", "111111"); await c.submit();
  expect([c.state.step, c.state.password, c.state.totp]).toEqual(["authenticator", "password", ""]);
  c.setField("totp", "222222"); await c.submit();
  expect(s.transport.getToken.mock.calls).toEqual([["alice", "password", ""], ["alice", "password", "111111"], ["alice", "password", "222222"]]);
  expect([c.state.password, c.state.totp]).toEqual(["", ""]);
});
it("Use another account erases the transient password/code", async () => {
  const s = session(async () => { throw { code: "authenticator_required" }; });
  const c = owned(createIdentityLoginState({ session: s, navigate: vi.fn(), toast: { add: vi.fn() } }));
  c.setField("username", "alice"); c.setField("password", "password"); await c.submit(); c.useAnotherAccount();
  expect([c.state.username, c.state.password, c.state.totp, c.state.step]).toEqual(["", "", "", "password"]);
});
it("the actual session handoff is one-use and cannot survive replacement or retirement", async () => {
  let token = "restricted", config;
  const projection = id => ({ principal: { kind: "account", id, passwordChangeRequired: true }, sessionGeneration: `session-${id}`,
    vaultId: null, authorityRevision: 1, capabilities: { canRead: false, canManageOwnAccount: true } });
  const c = owned(createIdentityAppSession({ config: () => config, setConfig: value => { config = value; },
    tokens: { getStoredToken: () => token }, transport: {}, stopRuntime() {}, applyBrand() {} }));
  c.adopt(projection("alice")); const proof = { username: "alice", password: "temporary" };
  c.retainLoginProof(proof); expect(c.consumeLoginProof()).toEqual(proof); expect(c.consumeLoginProof()).toBeNull();
  c.retainLoginProof(proof); token = "replacement"; expect(c.consumeLoginProof()).toBeNull();
  c.retainLoginProof(proof); c.adopt(projection("bob")); expect(c.consumeLoginProof()).toBeNull();
  c.retainLoginProof({ username: "bob", password: "other" }); c.invalidate(); expect(c.consumeLoginProof()).toBeNull();
});
it("disposing a sign-in form during its refresh cannot navigate the replacement page", async () => {
  const entered = Promise.withResolvers(), refresh = Promise.withResolvers(), s = session();
  s.acceptProjection = () => { entered.resolve(); return refresh.promise; };
  const navigate = vi.fn(), c = owned(createIdentityLoginState({ session: s, navigate, toast: { add: vi.fn() } }));
  c.setField("username", "alice"); c.setField("password", "password"); const result = c.submit();
  await entered.promise; const retained = c.hasWork();
  const closing = c.dispose(); refresh.resolve(s.accepted); await result; await closing;
  expect([retained, navigate.mock.calls, s.retainLoginProof.mock.calls, c.state.password]).toEqual([true, [], [], ""]);
});

it("delivers only the sign-in projection accepted before the original refresh completed", async () => {
  const entered = Promise.withResolvers(), completion = Promise.withResolvers(), s = session();
  let live = true;
  const accepted = { ...s.accepted, current: () => live };
  s.acceptProjection = async () => { entered.resolve(); await completion.promise; return accepted; };
  const navigate = vi.fn(), c = owned(createIdentityLoginFlow({ session: s, credentials: () => ({ username: "alice", password: "temporary" }), clearCredentials() {}, navigate }));
  const result = c.logIn(); await entered.promise;
  live = false; completion.resolve(); await result;
  expect([navigate.mock.calls, s.retainLoginProof.mock.calls]).toEqual([[], []]);
});
