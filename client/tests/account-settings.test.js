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
it("a held departure refuses dialog cancellation and keeps the captured enrollment intact", async () => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers();
  const resolve = vi.fn(() => { entered.resolve(); return held.promise; });
  const { controller: c, write } = await account({ resolve });
  await c.beginAuthenticator("enable");
  c.setField("currentPassword", "old"); c.setField("newTotpCode", "123456");
  const attempt = c.requestChange("enable");
  let whileResolving, allowed;
  try {
    await entered.promise;
    allowed = [c.cancelDialog(), c.cancelConfirmation(), c.setField("newTotpCode", "000000"), await c.confirmChange()];
    whileResolving = [c.state.activity, c.state.dialog, c.state.newTotpCode, c.state.enrollment.candidate, c.state.confirmation];
  } finally { held.resolve("proceed"); }
  expect(await attempt).toBe(true);
  expect(allowed).toEqual([false, false, false, false]);
  expect(whileResolving).toEqual([{ kind: "resolving", message: "Preparing to change your credentials..." }, "enable", "123456", candidate, null]);
  expect(c.cancelConfirmation()).toBe(true);
  expect([c.state.activity, c.state.dialog, c.state.newTotpCode, c.state.enrollment.candidate, write.mock.calls]).toEqual([{ kind: "idle" }, "enable", "123456", candidate, []]);
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
  expect([f.clearToken.mock.calls, f.controller.state.newPassword, f.controller.state.activity]).toEqual([[], "new",
    { kind: "refused", reason: "write-rejected", message: "Your credentials could not be changed. Check your details and try again." }]);
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
it("a replaced account cannot be retired by the temporary-proof reader", async () => {
  let token = "old-token";
  const retire = vi.fn(), clearToken = vi.fn(), signedOut = vi.fn();
  const c = owned(createAccountSettingsState({ token: () => token, retire, clearToken, signedOut,
    read: async () => ({ login: "alice", passwordChangeRequired: true }),
    consumeProof: () => { token = "replacement"; return null; } }));
  expect([await c.load(), token, retire.mock.calls, clearToken.mock.calls, signedOut.mock.calls]).toEqual([null, "replacement", [], [], []]);
});
it("temporary completion requires matching transient proof and no voluntary confirmation", async () => {
  const f = await account({ read: async () => ({ login: "alice", credentialRevision: 0, passwordChangeRequired: true, totpEnabled: false }) });
  f.controller.setField("newPassword", "private"); f.controller.setField("confirmPassword", "private");
  expect(await f.controller.completeRequired()).toBe(false); expect(f.controller.acceptTemporaryProof({ username: "bob", password: "temporary" })).toBe(false);
  expect(f.controller.acceptTemporaryProof({ username: "alice", password: "temporary" })).toBe(true); await f.controller.completeRequired();
  const payload = f.write.mock.calls[0][0]; expect(payload).toEqual({ revision: 0, updateId: payload.updateId, currentPassword: "temporary", newPassword: "private" });
  expect(f.controller.state.confirmation).toBeNull();
});
it.each([undefined, () => ({ username: "bob", password: "temporary" })])("required completion reports missing proof even after matching passwords are entered (%#)", async consumeProof => {
  const f = await account({ read: async () => ({ login: "alice", passwordChangeRequired: true, totpEnabled: false }), consumeProof });
  const { controller: c } = f;
  c.setField("newPassword", "private"); c.setField("confirmPassword", "private");
  expect(await c.completeRequired()).toBe(false);
  expect([c.state.activity, c.state.dialog, f.write.mock.calls]).toEqual([
    { kind: "refused", reason: "temporary-proof", message: "Sign in again to choose your password." }, null, [],
  ]);
});
it.each([false, true])("a rejected required password change restores only the proof dialog the account uses (%s)", async totpEnabled => {
  const write = vi.fn(async () => { throw { status: 422 }; });
  const f = await account({ read: async () => ({ login: "alice", passwordChangeRequired: true, credentialRevision: 1, totpEnabled }),
    consumeProof: () => ({ username: "alice", password: "temporary" }), write });
  const { controller: c } = f;
  c.setField("newPassword", "private"); c.setField("confirmPassword", "private");
  if (totpEnabled) {
    expect(await c.completeRequired()).toBe(false);
    c.setField("currentTotp", "654321");
  }
  expect(await c.completeRequired()).toBe(false);
  const payload = write.mock.calls[0][0];
  expect([c.state.dialog, c.state.activity, write.mock.calls]).toEqual([
    totpEnabled ? "required-proof" : null,
    { kind: "refused", reason: "write-rejected", message: "Your credentials could not be changed. Check your details and try again." },
    [[{ revision: 1, updateId: payload.updateId, currentPassword: "temporary", newPassword: "private", ...(totpEnabled ? { currentTotp: "654321" } : {}) }, { token: "old-token" }]],
  ]);
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
it("setup validates both credentials and the optional six-digit proof before any publication", async () => {
  const beforeCommit = vi.fn(async () => true), submit = vi.fn(), readStatus = vi.fn();
  const c = owned(createIdentitySetupFormState({ beforeCommit, submit, readStatus, enrol: async () => candidate }));
  expect([c.state.username, c.state.password, c.state.everybody, c.state.totpEnabled, c.state.busy]).toEqual(["", "", "view", false, false]);
  for (const [username, password] of [["", ""], ["", "literal"], ["alice", ""]]) {
    c.setField("username", username); c.setField("password", password);
    expect([await c.finish(), c.state.error]).toEqual([false, "Enter a login name and password."]);
  }
  c.setField("password", "literal"); await c.toggleAuthenticator(); c.setField("totpCode", "12345");
  expect([await c.finish(), c.state.error, c.state.enrollment.candidate]).toEqual([false, "Confirm the new authenticator with its six-digit code.", candidate]);
  for (const level of ["none", "edit", "view"]) c.setField("everybody", level);
  expect([c.state.username, c.state.password, c.state.totpCode, beforeCommit.mock.calls, submit.mock.calls, readStatus.mock.calls]).toEqual(["alice", "literal", "12345", [], [], []]);
});
it("setup owns one literal submission through preparation, wire and handoff", async () => {
  const authorization = Promise.withResolvers(), wire = Promise.withResolvers(), handoff = Promise.withResolvers();
  const sent = Promise.withResolvers(), acknowledged = Promise.withResolvers();
  const submit = vi.fn(payload => { sent.resolve(payload); return wire.promise; });
  const completed = vi.fn(result => { acknowledged.resolve(result); return handoff.promise; });
  const c = owned(createIdentitySetupFormState({ beforeCommit: () => authorization.promise, submit, completed, enrol: async () => candidate }));
  c.setField("username", " Alice "); c.setField("password", " literal "); c.setField("everybody", "edit");
  await c.toggleAuthenticator(); c.setField("totpCode", "012345");
  const attempt = c.finish();
  try {
    expect([c.finish(), c.state.busy, submit.mock.calls]).toEqual([attempt, true, []]);
    c.setField("password", "discarded edit"); expect(await c.toggleAuthenticator()).toBe(false);
    authorization.resolve(true); const payload = await sent.promise;
    expect(submit.mock.calls).toEqual([[{ username: " Alice ", password: " literal ", everybody: "edit", updateId: payload.updateId, totp: { key: candidate.key, code: "012345" } }]]);
    expect(c.finish()).toBe(attempt);
    wire.resolve({ access_token: "new" }); await acknowledged.promise;
    expect([c.state.busy, c.finish(), completed.mock.calls]).toEqual([true, attempt, [[{ access_token: "new" }]]]);
  } finally { authorization.resolve(false); wire.resolve(null); handoff.resolve(); }
  expect([await attempt, c.state.busy, c.state.password, c.state.enrollment.candidate]).toEqual([true, false, "", null]);
});
it.each([false, true])("setup never sends after cancelled preparation or disposal (%s)", async dispose => {
  const authorization = Promise.withResolvers(), submit = vi.fn(), completed = vi.fn();
  const c = owned(createIdentitySetupFormState({ beforeCommit: () => authorization.promise, submit, completed }));
  c.setField("username", "alice"); c.setField("password", "literal"); const result = c.finish();
  const closing = dispose ? c.dispose() : null;
  authorization.resolve(dispose);
  expect([await result, c.state.busy, c.state.username, c.state.password, submit.mock.calls, completed.mock.calls]).toEqual([false, false, "alice", dispose ? "" : "literal", [], []]);
  await closing;
});
it("definite setup rejection retains the credentials, guest choice and issued candidate for correction", async () => {
  const submit = vi.fn(async () => { throw { status: 422 }; }), readStatus = vi.fn(), completed = vi.fn();
  const c = owned(createIdentitySetupFormState({ submit, readStatus, completed, enrol: async () => candidate }));
  c.setField("username", "alice"); c.setField("password", "literal"); c.setField("everybody", "none");
  await c.toggleAuthenticator(); c.setField("totpCode", "111111");
  expect(await c.finish()).toBe(false);
  expect(c.state).toMatchObject({ busy: false, error: "Setup could not finish. Check your details and try again.", username: "alice", password: "literal", everybody: "none", enrollment: { candidate } });
  c.setField("totpCode", "222222"); expect(c.state.totpCode).toBe("222222");
  expect([submit.mock.calls.length, readStatus.mock.calls, completed.mock.calls]).toEqual([1, [], []]);
});
it("disabled setup enrollment retires its pending candidate and permits only the new candidate", async () => {
  const entered = Promise.withResolvers(), stale = Promise.withResolvers(), fresh = { ...candidate, qr: "data:image/png;base64,fresh" };
  const enrol = vi.fn().mockImplementationOnce(() => { entered.resolve(); return stale.promise; }).mockResolvedValueOnce(fresh);
  const submit = vi.fn(), c = owned(createIdentitySetupFormState({ enrol, submit }));
  c.setField("username", "alice"); const first = c.toggleAuthenticator();
  try {
    await entered.promise;
    await c.toggleAuthenticator(); expect([c.state.totpEnabled, c.state.enrollment.candidate, c.state.totpCode]).toEqual([false, null, ""]);
    const replacement = c.toggleAuthenticator();
    expect([enrol.mock.calls, c.state.enrollment.candidate]).toEqual([[['alice']], null]);
    stale.resolve(candidate); expect(await first).toBe(false);
    expect(await replacement).toBe(true);
    expect([c.state.totpEnabled, c.state.enrollment.candidate, enrol.mock.calls, submit.mock.calls]).toEqual([true, fresh, [["alice"], ["alice"]], []]);
  } finally { stale.resolve(candidate); }
});
it("an enrollment failure offers a new attempt without exposing a failed candidate", async () => {
  const enrol = vi.fn().mockRejectedValueOnce(Error("refused")).mockResolvedValueOnce(candidate);
  const submit = vi.fn(), c = owned(createIdentitySetupFormState({ enrol, submit }));
  c.setField("username", "alice");
  expect(await c.toggleAuthenticator()).toBe(false);
  expect(c.state.enrollment).toMatchObject({ candidate: null, busy: false, error: "Could not prepare the authenticator. Please try again." });
  await c.toggleAuthenticator(); await c.toggleAuthenticator();
  expect([c.state.enrollment.candidate, c.state.enrollment.error, enrol.mock.calls, submit.mock.calls]).toEqual([candidate, "", [["alice"], ["alice"]], []]);
});
