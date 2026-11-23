// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { createAccountSettingsState } from "../accountSettingsState.js";
import { createIdentitySetupFormState } from "../setupFormState.js";

const candidate = { key: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", qr: "data:image/png;base64,qr" };
const controllers = [];
afterEach(async () => { for (const c of controllers.splice(0)) await c.dispose(); });
const owned = c => { controllers.push(c); return c; };
it("alternate loads of a restricted account retain the form-owned proof and draft", async () => {
  const consumeProof = vi.fn().mockReturnValueOnce({ username: "alice", password: "temporary" }).mockReturnValue(null);
  const controller = owned(createAccountSettingsState({ read: async () => ({ id: "alice", login: "alice", passwordChangeRequired: true }),
    token: () => "token", consumeProof, clearToken: vi.fn() }));
  await controller.load(); controller.setField("newPassword", "draft"); await controller.load();
  expect([consumeProof.mock.calls.length, controller.state.newPassword, controller.state.currentPassword]).toEqual([1, "draft", "temporary"]);
});

it("setup coalesces login edits behind the original enrollment wire", async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), requests = [];
  const controller = owned(createIdentitySetupFormState({ async enrol(name) {
    requests.push(name);
    if (name === "first") { entered.resolve(); await release.promise; }
    return { ...candidate, secret: name };
  } }));
  controller.setField("username", "first");
  const first = controller.toggleAuthenticator(); await entered.promise;
  const second = controller.setField("username", "intermediate"), newest = controller.setField("username", "latest");
  expect([requests, controller.state.enrollment.candidate]).toEqual([["first"], null]);
  release.resolve();
  expect(await Promise.all([first, second, newest])).toEqual([false, false, true]);
  expect([requests, controller.state.enrollment.candidate.secret]).toEqual([["first", "latest"], "latest"]);
});
async function account(options = {}) {
  const write = vi.fn(async data => ({ requiresLogin: true, updateId: data.updateId }));
  let token = "old-token";
  const clearToken = vi.fn(() => { token = null; }), signedOut = vi.fn(), retire = vi.fn();
  const read = vi.fn(async () => ({ id: "alice-id", login: "alice", credentialRevision: 4, totpEnabled: false, passwordChangeRequired: false }));
  const controller = owned(createAccountSettingsState({ read, write, enrol: async () => candidate,
    token: () => token, sessionKey: () => token, clearToken, signedOut, retire, resolve: async () => "proceed", ...options }));
  await controller.load();
  const password = () => { controller.setField("currentPassword", "old"); controller.setField("newPassword", "new"); controller.setField("confirmPassword", "new"); };
  return { controller, write: options.write ?? write, read: options.read ?? read, clearToken, signedOut, retire, password, changeIdentity() { token = "other"; } };
}

it("confirmation follows departure; cancel retains fields and candidate without PATCH", async () => {
  const resolve = vi.fn(async () => "proceed"), f = await account({ resolve });
  f.password(); await f.controller.beginAuthenticator("enable"); f.controller.setField("newTotpCode", "123456");
  expect(await f.controller.requestChange("enable")).toBe(true);
  expect(resolve.mock.calls).toEqual([["changing your credentials"]]); expect(f.write.mock.calls).toEqual([]);
  expect(f.controller.state.confirmation.message).toContain("other devices");
  f.controller.cancelConfirmation();
  expect([f.controller.state.dialog, f.controller.state.currentPassword, f.controller.state.enrollment.candidate]).toEqual(["enable", "old", candidate]);
  expect(f.clearToken.mock.calls).toEqual([]);
});
it("cancelled departure never opens a confirmation or changes credentials", async () => {
  const f = await account({ resolve: async () => "cancel" }); f.password();
  expect(await f.controller.requestChange()).toBe(false);
  expect([f.controller.state.confirmation, f.write.mock.calls, f.controller.state.newPassword]).toEqual([null, [], "new"]);
});
it("one admitted credential change clears secrets and goes to normal sign-in", async () => {
  const f = await account(); f.password(); await f.controller.requestChange();
  const first = f.controller.confirmChange(), second = f.controller.confirmChange(); expect(second).toBe(first);
  expect(await first).toBe(true);
  const payload = f.write.mock.calls[0][0];
  expect(f.write.mock.calls).toEqual([[{ revision: 4, updateId: payload.updateId, currentPassword: "old", newPassword: "new" }, { token: "old-token" }]]);
  expect([f.clearToken.mock.calls, f.retire.mock.calls, f.signedOut.mock.calls]).toEqual([[[]], [[]], [[{ uncertain: false, message: "Sign in again with your new credentials." }]]]);
  expect([f.controller.state.newPassword, f.controller.state.currentPassword, f.controller.state.confirmation]).toEqual(["", "", null]);
});
for (const committed of [true, false]) it(`lost PATCH (${committed}) asks ordinary sign-in without replay`, async () => {
  let actualPassword = "old";
  const write = vi.fn(async request => { if (committed) actualPassword = request.newPassword; throw Error("connection lost"); });
  const f = await account({ write }); f.password(); await f.controller.requestChange();
  expect(await f.controller.confirmChange()).toBe(false);
  expect(write.mock.calls).toHaveLength(1);
  expect([actualPassword, f.controller.state.newPassword, f.signedOut.mock.calls]).toEqual([committed ? "new" : "old", "", [[{ uncertain: true, message: "Connection lost. Sign in again." }]]]);
});
for (const kind of ["enable", "replace", "remove"]) it(`${kind} echoes the issued candidate and fresh proof`, async () => {
  const f = await account({ read: async () => ({ login: "alice", credentialRevision: 2, totpEnabled: kind !== "enable" }) });
  await f.controller.beginAuthenticator(kind); f.controller.setField("currentPassword", "old"); f.controller.setField("currentTotp", "654321"); f.controller.setField("newTotpCode", "123456");
  await f.controller.requestChange(kind); expect(f.write.mock.calls).toEqual([]); await f.controller.confirmChange();
  const payload = f.write.mock.calls[0][0];
  expect(payload).toEqual({ revision: 2, updateId: payload.updateId, currentPassword: "old", ...(kind === "enable" ? {} : { currentTotp: "654321" }),
    totp: kind === "remove" ? { enabled: false } : { enabled: true, key: candidate.key, code: "123456" } });
  expect(f.controller.state.enrollment.candidate).toBeNull();
});
it("one departure resolution captures the form before waiting", async () => {
  const held = Promise.withResolvers(), resolve = vi.fn(() => held.promise), f = await account({ resolve }); f.password();
  const first = f.controller.requestChange(); expect(await f.controller.requestChange()).toBe(false);
  f.controller.setField("newPassword", "changed"); held.resolve("proceed"); await first;
  expect(resolve.mock.calls).toEqual([["changing your credentials"]]); expect(f.controller.state.newPassword).toBe("new");
});
it("a replacement identity cannot submit a retained confirmation", async () => {
  const f = await account(); f.password(); await f.controller.requestChange(); f.changeIdentity();
  expect(await f.controller.confirmChange()).toBe(false); expect([f.write.mock.calls, f.clearToken.mock.calls]).toEqual([[], []]);
});
it("a retired form cannot read a replacement account", async () => {
  const f = await account(); f.changeIdentity(); expect(await f.controller.load()).toBeNull();
  expect(f.read.mock.calls).toEqual([[{ token: "old-token" }]]); expect(f.controller.state.view.login).toBe("alice");
});
it("an absent owner reads and admits nothing", async () => {
  const read = vi.fn(), f = await account({ read, sessionKey: () => null });
  expect([f.controller.state.view, read.mock.calls, await f.controller.requestChange()]).toEqual([null, [], false]);
});
it("a late original acknowledgment cannot sign out a replacement", async () => {
  const held = Promise.withResolvers(), f = await account({ write: vi.fn(() => held.promise) }); f.password(); await f.controller.requestChange();
  const result = f.controller.confirmChange(); f.changeIdentity(); held.resolve({ requiresLogin: true, updateId: f.write.mock.calls[0][0].updateId });
  await result; expect([f.clearToken.mock.calls, f.signedOut.mock.calls]).toEqual([[], []]);
});
it("expected self-revocation retains exactly the original acknowledgment", async () => {
  const held = Promise.withResolvers(), write = vi.fn(() => held.promise), f = await account({ write }); f.password(); await f.controller.requestChange();
  const result = f.controller.confirmChange(); const updateId = write.mock.calls[0][0].updateId;
  f.controller.revoke(); held.resolve({ requiresLogin: true, updateId });
  expect(await result).toBe(true); expect(f.signedOut.mock.calls).toEqual([[{ uncertain: false, message: "Sign in again with your new credentials." }]]);
});
it("whole-form disposal ends even an admitted completion", async () => {
  const held = Promise.withResolvers(), write = vi.fn(() => held.promise), f = await account({ write }); f.password(); await f.controller.requestChange();
  const result = f.controller.confirmChange(), closing = f.controller.dispose(); held.resolve({ requiresLogin: true, updateId: write.mock.calls[0][0].updateId });
  await result; await closing; expect([f.clearToken.mock.calls, f.signedOut.mock.calls]).toEqual([[], []]);
});
it("definite rejection retains the current form and token", async () => {
  const f = await account({ write: async () => { throw { response: { status: 422 } }; } }); f.password(); await f.controller.requestChange(); await f.controller.confirmChange();
  expect([f.clearToken.mock.calls, f.controller.state.newPassword, f.controller.state.error]).toEqual([[], "new", "Your credentials could not be changed. Check your details and try again."]);
});
it("late enrollment cannot be adopted by a replacement", async () => {
  const held = Promise.withResolvers(), f = await account({ enrol: () => held.promise });
  const loading = f.controller.beginAuthenticator("enable"); f.changeIdentity(); held.resolve(candidate); await loading;
  expect(f.controller.state.enrollment.candidate).toBeNull();
});
it("required-password reload without the transient proof asks normal sign-in", async () => {
  const f = await account({ read: async () => ({ login: "alice", passwordChangeRequired: true }), consumeProof: () => null });
  expect(f.signedOut.mock.calls).toEqual([[{ message: "Sign in again to choose your password.", uncertain: false }]]); expect(f.clearToken.mock.calls).toEqual([[]]);
});
it("temporary completion requires matching transient proof and no voluntary confirmation", async () => {
  const f = await account({ read: async () => ({ login: "alice", credentialRevision: 0, passwordChangeRequired: true, totpEnabled: false }) });
  f.controller.setField("newPassword", "private"); f.controller.setField("confirmPassword", "private");
  expect(await f.controller.completeRequired()).toBe(false); expect(f.controller.acceptTemporaryProof({ username: "bob", password: "temporary" })).toBe(false);
  expect(f.controller.acceptTemporaryProof({ username: "alice", password: "temporary" })).toBe(true); await f.controller.completeRequired();
  const payload = f.write.mock.calls[0][0]; expect(payload).toEqual({ revision: 0, updateId: payload.updateId, currentPassword: "temporary", newPassword: "private" });
  expect(f.controller.state.confirmation).toBeNull();
});
it("a normalized login at sign-in still carries the proven temporary password", async () => {
  const f = await account({ read: async () => ({ login: "alice", credentialRevision: 0, passwordChangeRequired: true, totpEnabled: false }) });
  expect(f.controller.acceptTemporaryProof({ username: " ALICE ", password: "temporary" })).toBe(true);
  f.controller.setField("newPassword", "private"); f.controller.setField("confirmPassword", "private");
  await f.controller.completeRequired(); expect(f.write.mock.calls[0][0].currentPassword).toBe("temporary");
});
it("a reentrant transport cannot admit the same confirmation twice", async () => {
  let controller, duplicate;
  const write = vi.fn(data => { duplicate = controller.confirmChange(); return { requiresLogin: true, updateId: data.updateId }; });
  const f = await account({ write }); controller = f.controller; f.password(); await controller.requestChange();
  expect(await controller.confirmChange()).toBe(true); expect(await duplicate).toBe(false); expect(write.mock.calls).toHaveLength(1);
});
it("CLI-reset authenticator prompts a fresh code directly for PATCH, and cancel retains the form", async () => {
  const f = await account({ read: async () => ({ login: "alice", credentialRevision: 1, passwordChangeRequired: true, totpEnabled: true }) });
  f.controller.acceptTemporaryProof({ username: "alice", password: "temporary" }); f.controller.setField("newPassword", "private"); f.controller.setField("confirmPassword", "private");
  await f.controller.completeRequired(); expect([f.controller.state.dialog, f.write.mock.calls]).toEqual(["required-proof", []]);
  f.controller.cancelDialog(); expect(f.controller.state.newPassword).toBe("private"); await f.controller.completeRequired();
  f.controller.setField("currentTotp", "654321"); await f.controller.completeRequired(); expect(f.write.mock.calls[0][0].currentTotp).toBe("654321");
});
for (const everybody of ["edit", "view", "none"]) it(`setup sends the displayed ${everybody} and acknowledges before notes`, async () => {
  const submit = vi.fn(async () => ({ access_token: "token" })), completed = vi.fn();
  const c = owned(createIdentitySetupFormState({ submit, completed })); expect(c.state.everybody).toBe("view");
  c.setField("username", "alice"); c.setField("password", "password"); c.setField("everybody", everybody); await c.finish();
  const payload = submit.mock.calls[0][0]; expect(submit.mock.calls).toEqual([[{ username: "alice", password: "password", everybody, updateId: payload.updateId }]]);
  expect([completed.mock.calls, c.state.password]).toEqual([[[{ access_token: "token" }]], ""]);
});
it("lost setup reply checks readiness without replay", async () => {
  const submit = vi.fn(async () => { throw Error("lost"); }), signIn = vi.fn(), readStatus = vi.fn(async () => ({ setupRequired: false }));
  const c = owned(createIdentitySetupFormState({ submit, signIn, readStatus })); c.setField("username", "alice"); c.setField("password", "password"); await c.finish();
  expect([submit.mock.calls.length, readStatus.mock.calls, signIn.mock.calls, c.state.password]).toEqual([1, [[]], [["Setup finished. Sign in to continue."]], ""]);
});
it("setup candidate follows the displayed login, not a late earlier enrollment", async () => {
  const held = Promise.withResolvers(), fresh = { ...candidate, key: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" };
  const submit = vi.fn(async () => ({ access_token: "token" }));
  const c = owned(createIdentitySetupFormState({ enrol: name => name === "old" ? held.promise : fresh, submit }));
  c.setField("username", "old"); c.setField("password", "password"); const first = c.toggleAuthenticator();
  await c.setField("username", "new"); held.resolve(candidate); await first;
  expect(c.state.enrollment.candidate).toEqual(fresh); c.setField("totpCode", "123456"); await c.finish();
  expect(submit.mock.calls[0][0].totp).toEqual({ key: fresh.key, code: "123456" });
});
it("copy is single-admission and disposal hides late feedback", async () => {
  const held = Promise.withResolvers(), copy = vi.fn(() => held.promise), f = await account({ copy });
  await f.controller.beginAuthenticator("enable"); const first = f.controller.copyKey(); expect(await f.controller.copyKey()).toBe(false);
  const closing = f.controller.dispose(); held.resolve(); await first; await closing;
  expect([copy.mock.calls, f.controller.state.enrollment.feedback]).toEqual([[[candidate.secret]], ""]);
});
