// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { createIdentityAccessSettingsState } from "../identityAccessSettingsState.js";
import { registerSessionParticipant, resolveParticipants } from "../sessionActions.js";

const active = [], replies = [];
function heldResponse() { const held = Promise.withResolvers(); replies.push(held); return held; }
afterEach(async () => {
  // Release controlled transport replies even if an assertion fails first.
  for (const reply of replies.splice(0)) reply.resolve(null);
  await Promise.all(active.splice(0).map(controller => controller.dispose())); vi.useRealTimers();
});
const view = () => ({ vaultId: "vault", revision: 2, signature: "captured", updateId: "before", everybody: "view",
  grants: { alice: "admin", sam: "edit" }, named: [{ id: "alice", login: "alex", level: "admin" }, { id: "sam", login: "sam", level: "edit" }], declaredAdmin: { accountId: null, login: null, pinned: false, pending: false } });
async function fixture(options = {}) {
  let saved = view(), manage = true;
  const read = vi.fn(async () => structuredClone(saved));
  const completed = vi.fn(result => { manage = result.capabilities?.canManageVault !== false; });
  const write = vi.fn(async request => { saved = { ...saved, ...request, revision: saved.revision + 1, signature: "next" }; return { updateId: request.updateId, committed: true, capabilities: { canManageVault: true } }; });
  const controller = createIdentityAccessSettingsState({ read, write, completed, canManage: () => manage, token: () => "alice-token", sessionKey: () => "alice", currentAccount: () => ({ id: "alice", login: "alex" }), ...options });
  active.push(controller); await controller.load(); return { controller, read, write, completed, saved: () => saved };
}
async function creating(f) {
  await f.controller.openDialog("create"); f.controller.setField("login", "jordan"); f.controller.setField("temporaryPassword", "temporary");
}
it("identity ACL commit does not depend on the obsolete settingsWritable auth-mode field", async () => {
  const write = vi.fn(async request => ({ updateId: request.updateId, committed: true }));
  const controller = createIdentityAccessSettingsState({ read: async () => view(), write, canManage: () => true, token: () => "token" });
  active.push(controller); await controller.load(); controller.setEverybody("edit");
  expect(await controller.requestCommit()).toBe(true); expect(write).toHaveBeenCalledOnce();
});
it("server-set Admin is static and saving another row preserves its underlying saved grant", async () => {
  const original = { ...view(), grants: { alice: "view", sam: "edit" }, declaredAdmin: { accountId: "alice", login: "alex", pinned: true } };
  const write = vi.fn(async request => ({ updateId: request.updateId, committed: true }));
  const f = await fixture({ read: async () => original, write });
  expect(f.controller.state.rows[0]).toMatchObject({ serverSet: true, level: "admin", canEdit: false });
  expect([f.controller.setLevel("alice", "none"), f.controller.remove("alice")]).toEqual([false, false]);
  f.controller.setLevel("sam", "view"); await f.controller.requestCommit();
  expect(write.mock.calls).toEqual([[expect.objectContaining({ grants: { alice: "view", sam: "view" } }), { token: "alice-token" }]]);
});
it("self-demotion names the account, levels, consequences and restoration; cancel sends no PUT", async () => {
  const beforeCommit = vi.fn(async () => true), f = await fixture({ beforeCommit }); f.controller.setLevel("alice", "view");
  await f.controller.requestCommit(); expect(f.write).not.toHaveBeenCalled(); expect(beforeCommit).toHaveBeenCalledOnce();
  expect(f.controller.state.confirmation).toMatchObject({ login: "alex", current: "Admin", next: "View", confirmLabel: "Change my access to View" });
  expect(f.controller.state.confirmation.consequence).toContain("not edit"); f.controller.cancelConfirmation();
  expect(f.controller.state.grants.alice).toBe("view"); expect(f.write).not.toHaveBeenCalled();
});
it("self-demotion acknowledges safely without reopening the full ACL", async () => {
  const f = await fixture({ write: async request => ({ updateId: request.updateId, committed: true, capabilities: { canManageVault: false } }) });
  f.controller.setLevel("alice", "none"); await f.controller.requestCommit(); expect(await f.controller.confirmChange()).toBe(true);
  expect(f.read).toHaveBeenCalledOnce(); expect(f.controller.state.status).toBe("Access saved."); expect(f.controller.state.mutable).toBe(false);
});
it("a dirty list cannot be refreshed or replaced by an independent create dialog", async () => {
  const f = await fixture({ confirmDeparture: async () => "cancel" }); f.controller.setLevel("sam", "none");
  expect(await f.controller.load()).toBeNull(); expect(await f.controller.openDialog("create")).toBe(false);
  expect(f.controller.state.grants.sam).toBe("none"); expect(f.controller.state.dialog).toBeNull(); expect(f.read).toHaveBeenCalledOnce();
});
it("explicitly saving retained edits before Add refreshes the actual new revision", async () => {
  const f = await fixture({ confirmDeparture: async () => "save" }); f.controller.setLevel("sam", "view");
  expect(await f.controller.openDialog("existing")).toBe(true); expect(f.write).toHaveBeenCalledOnce(); expect(f.controller.state.view.revision).toBe(3); expect(f.controller.state.grants.sam).toBe("view");
});
it("atomic creation clears the temporary password and refreshes the list with one normal message", async () => {
  let saved = view(); const notify = vi.fn(), createAccount = vi.fn(async request => {
    saved = { ...saved, revision: 3, grants: { ...saved.grants, jordan: "edit" }, named: [...saved.named, { id: "jordan", login: "jordan", level: "edit" }] };
    return { operationId: request.operationId, accountId: "jordan", committed: true };
  });
  const f = await fixture({ read: async () => saved, createAccount, notify }); await creating(f);
  expect(await f.controller.submitDialog()).toBe(true); expect(createAccount).toHaveBeenCalledOnce();
  expect(f.controller.state.rows.map(row => [row.login, row.level])).toEqual([["alex", "admin"], ["sam", "edit"], ["jordan", "edit"]]);
  expect([f.controller.state.temporaryPassword, f.controller.state.dialog]).toEqual(["", null]); expect(notify).toHaveBeenCalledOnce();
});
it("lost create response checks the same operation ID and never sends another POST", async () => {
  const createAccount = vi.fn(async () => { throw Error("lost"); }), readCreation = vi.fn(async operationId => ({ operationId, committed: true, accountId: "created" }));
  const f = await fixture({ createAccount, readCreation }); await creating(f);
  expect(await f.controller.submitDialog()).toBe(true); expect(readCreation.mock.calls).toEqual([[createAccount.mock.calls[0][0].operationId, { token: "alice-token" }]]); expect(createAccount).toHaveBeenCalledOnce(); expect(f.controller.state.provisioningUnknown).toBe(false);
});
it("unreadable creation outcome retains ID, rejects replay and resolves only by a later receipt read", async () => {
  const createAccount = vi.fn(async () => { throw Error("lost"); }), readCreation = vi.fn().mockRejectedValueOnce(Error("offline")).mockImplementationOnce(async operationId => ({ operationId, committed: true, accountId: "created" }));
  const f = await fixture({ createAccount, readCreation }); await creating(f); await f.controller.submitDialog(); expect(f.controller.state.provisioningUnknown).toBe(true);
  expect(await f.controller.submitDialog()).toBe(false); expect(await f.controller.reviewCreation()).toBe(true);
  expect(readCreation.mock.calls).toEqual([[createAccount.mock.calls[0][0].operationId, { token: "alice-token" }], [createAccount.mock.calls[0][0].operationId, { token: "alice-token" }]]); expect(createAccount).toHaveBeenCalledOnce();
});
it("conclusive noncommit preserves nonsecret choices, clears the password and permits an explicit renewed attempt", async () => {
  const createAccount = vi.fn().mockRejectedValueOnce(Error("lost"))
    .mockImplementationOnce(async ({ operationId }) => ({ operationId, accountId: "created", committed: true }));
  const readCreation = vi.fn().mockRejectedValueOnce(Error("offline"))
    .mockImplementationOnce(async operationId => ({ operationId, committed: false, settled: true }));
  const f = await fixture({ createAccount, readCreation });
  await creating(f); f.controller.setField("level", "view"); await f.controller.submitDialog();
  expect(f.controller.state.provisioningUnknown).toBe(true);
  expect(await f.controller.reviewCreation()).toBe(false);
  expect(f.controller.state).toMatchObject({ login: "jordan", level: "view", temporaryPassword: "", provisioningUnknown: false }); expect(createAccount).toHaveBeenCalledOnce();
  f.controller.cancelDialog();
  expect(f.controller.state.dialog).toBeNull();
  await creating(f);
  expect(await f.controller.submitDialog()).toBe(true);
  const [failedId, renewedId] = createAccount.mock.calls.map(([data]) => data.operationId);
  expect(renewedId).not.toBe(failedId);
  expect(readCreation.mock.calls).toEqual([[failedId, { token: "alice-token" }], [failedId, { token: "alice-token" }]]);
});
it.each(["ordinary", "self-demotion"])("a synchronous preflight failure leaves the %s draft retryable", async kind => {
  const beforeCommit = vi.fn().mockImplementationOnce(() => { throw Error("preflight failed"); }).mockReturnValue(true);
  const f = await fixture({ beforeCommit, confirmDeparture: () => "cancel" }), c = f.controller;
  const id = kind === "ordinary" ? "sam" : "alice";
  c.setLevel(id, "view");
  expect(await c.requestCommit()).toBe(false);
  expect([c.state.pending, c.state.canSave, c.state.grants[id], f.write.mock.calls]).toEqual([false, true, "view", []]);
  expect(await c.resolveDeparture("close")).toBe(false);
  expect(await c.requestCommit()).toBe(true);
  if (kind === "self-demotion") expect(await c.confirmChange()).toBe(true);
  expect(beforeCommit.mock.calls).toEqual([[], []]); expect(f.write).toHaveBeenCalledOnce();
});
it("a later writer obscuring an ACL outcome is not permission to replay", async () => {
  const f = await fixture({ write: vi.fn(async () => { throw Error("lost"); }), readStatus: async () => ({ matched: false }) });
  f.controller.setLevel("sam", "view"); await f.controller.requestCommit(); expect(f.controller.state.unknown).toBe(true);
  expect(await f.controller.review()).toBe(false); expect(f.controller.state.grants.sam).toBe("view"); expect(await f.controller.requestCommit()).toBe(false);
});
it("known ACL outcome acknowledges the original ID after self-demotion without another write", async () => {
  const write = vi.fn(async () => { throw Error("lost"); }), completed = vi.fn(), f = await fixture({ write, completed, readStatus: async () => ({ matched: true, capabilities: { canManageVault: false } }) });
  f.controller.setLevel("alice", "view"); await f.controller.requestCommit(); await f.controller.confirmChange();
  expect(await f.controller.review()).toBe(true); expect(completed).toHaveBeenCalledWith(expect.objectContaining({ recovered: true, updateId: write.mock.calls[0][0].updateId })); expect(write).toHaveBeenCalledOnce();
});
it("definite stale-CAS rejection refreshes authorized revision while preserving choices for explicit retry", async () => {
  let saved = view(); const write = vi.fn(async () => { saved = { ...view(), revision: 3, signature: "foreign" }; throw { response: { status: 409 } }; });
  const f = await fixture({ write, read: async () => saved }); f.controller.setLevel("sam", "view"); await f.controller.requestCommit();
  expect([f.controller.state.needsReview, f.controller.state.canReview]).toEqual([true, true]); expect(await f.controller.review()).toBe(true);
  expect(f.controller.state.grants.sam).toBe("view"); expect(f.controller.state.view.signature).toBe("foreign"); expect(f.controller.state.canSave).toBe(true); expect(write).toHaveBeenCalledOnce();
});
it.each(["untouched", "changed", "removed"])("Review rebases row operations, not the stale grants map (Sam %s)", async outcome => {
  const initial = { ...view(), grants: { ...view().grants, jordan: "view" } };
  let saved = initial;
  const write = vi.fn().mockRejectedValueOnce({ response: { status: 409 } }).mockImplementation(async request => ({ updateId: request.updateId, committed: true }));
  const { controller } = await fixture({ read: async () => saved, write });
  controller.setLevel("sam", "view"); controller.setEverybody("edit");
  const peer = { alice: "admin", jordan: "edit", morgan: "view", ...({ untouched: { sam: "edit" }, changed: { sam: "none" }, removed: {} })[outcome] };
  saved = { ...initial, revision: 3, signature: "peer", everybody: "none", grants: peer,
    named: Object.keys(peer).map(id => ({ id, login: id.toUpperCase() })) };
  expect(await controller.requestCommit()).toBe(false);
  expect(await controller.review()).toBe(true);
  const expected = outcome === "untouched" ? { ...peer, sam: "view" } : peer;
  expect(controller.state.grants).toEqual(expected);
  expect(controller.state.everybody).toBe("none");
  expect(controller.state.status).toBe(`Updated by someone else: ${outcome === "untouched" ? "" : "sam, "}Everybody else.`);
  expect(write).toHaveBeenCalledOnce();
  // Include another explicit local edit so the overlap/removal cases send a
  // real replacement PUT too, rather than passing because Save did nothing.
  controller.setLevel("jordan", "none");
  expect(await controller.requestCommit()).toBe(true);
  expect(write.mock.calls[1]).toEqual([{ revision: 3, signature: "peer", updateId: expect.any(String),
    everybody: "none", grants: { ...expected, jordan: "none" } }, { token: "alice-token" }]);
});
it("settled unknown reaches the coordinated Discard decision without replay", async () => {
  const write = vi.fn(async () => { throw Error("lost"); });
  const f = await fixture({ write, readStatus: async () => ({ matched: false }) });
  const c = f.controller, requestDecision = vi.fn(async () => "discard");
  const unregister = registerSessionParticipant("Access", { settlePending: c.settle, hasUnsavedChanges: c.hasWork,
    requestDecision, discard: c.discard });
  try {
    c.setLevel("sam", "view"); await c.requestCommit(); expect(await c.review()).toBe(false);
    expect(await resolveParticipants("logout")).toBe("proceed");
    expect([requestDecision.mock.calls, write.mock.calls.length, c.state.unknown, c.state.grants]).toEqual([[["logout"]], 1, false, view().grants]);
  } finally { unregister(); }
});
it("departure observation is bounded while the original wire retains its exact ACK", async () => {
  vi.useFakeTimers();
  const held = heldResponse(), write = vi.fn(() => held.promise), completed = vi.fn();
  const { controller: c } = await fixture({ write, completed, timeoutMs: 20 });
  c.setLevel("sam", "view"); const attempt = c.requestCommit(); await vi.advanceTimersByTimeAsync(20);
  expect(await attempt).toBe(false);
  const leaving = c.settle(); await vi.advanceTimersByTimeAsync(20);
  expect(await leaving).toBe(false);
  expect(await c.discard()).toBe(false);
  const [{ updateId }] = write.mock.calls[0];
  held.resolve({ updateId, committed: true, capabilities: { canManageVault: false } });
  expect(await c.settle()).toBe(true);
  expect([write.mock.calls.length, completed.mock.calls, c.state.status]).toEqual([1, [[{ updateId, committed: true, capabilities: { canManageVault: false } }]], "Access saved."]);
});
it("a timeout keeps the original ACL wire and accepts its late committed reply without replay", async () => {
  vi.useFakeTimers(); const held = heldResponse(); let saved = view();
  const write = vi.fn(() => held.promise), f = await fixture({ write, read: async () => saved, timeoutMs: 20 });
  f.controller.setLevel("sam", "view"); const attempt = f.controller.requestCommit(); await vi.advanceTimersByTimeAsync(21);
  expect(await attempt).toBe(false); expect([f.controller.state.inFlight, f.controller.state.unknown]).toEqual([true, true]);
  saved = { ...saved, grants: { alice: "admin", sam: "view" }, revision: 3, signature: "committed" };
  held.resolve({ updateId: write.mock.calls[0][0].updateId, committed: true, capabilities: { canManageVault: true } }); await f.controller.settle();
  expect(f.controller.state.unknown).toBe(false); expect(f.controller.state.view.signature).toBe("committed"); expect(write).toHaveBeenCalledOnce();
});
it("a late acknowledged PUT leaves no stale review to overwrite its success", async () => {
  vi.useFakeTimers();
  const put = heldResponse(), didComplete = Promise.withResolvers();
  const write = vi.fn(() => put.promise), readStatus = vi.fn().mockRejectedValue(Error("review should never start"));
  const { controller: c } = await fixture({ write, readStatus, completed: didComplete.resolve, timeoutMs: 20 });
  c.setLevel("sam", "view"); const attempt = c.requestCommit(); await vi.advanceTimersByTimeAsync(20);
  expect(await attempt).toBe(false);
  expect(await c.review()).toBe(false);
  const { updateId } = write.mock.calls[0][0];
  put.resolve({ updateId, committed: true });
  expect(await didComplete.promise).toEqual({ updateId, committed: true });
  expect(await c.settle()).toBe(true);
  expect(await c.review()).toBe(false);
  expect(readStatus.mock.calls).toEqual([]);
  expect(c.state).toMatchObject({ status: "Access saved.", error: "", dirty: false, unknown: false });
});
it("observation timeout does not admit any Access intent ahead of the original PUT", async () => {
  vi.useFakeTimers();
  const held = heldResponse(), admitted = Promise.withResolvers();
  const write = vi.fn(request => { admitted.resolve(request); return held.promise; });
  const readStatus = vi.fn(async () => ({ matched: true, capabilities: { canManageVault: false } }));
  const { controller, read, completed } = await fixture({ write, readStatus, timeoutMs: 20 });
  controller.setLevel("sam", "view");
  const attempt = controller.requestCommit(), request = await admitted.promise;
  await vi.advanceTimersByTimeAsync(20);
  expect(await attempt).toBe(false);
  const { canReview, canSave, mutable, inFlight, unknown } = controller.state;
  const intents = [await controller.review(), await controller.discard(), await controller.resolveDeparture("close", "discard"),
    await controller.requestCommit(), await controller.load({ retain: true }), await controller.openDialog("existing")];
  expect({ canReview, canSave, mutable, inFlight, unknown, intents }).toEqual({
    canReview: false, canSave: false, mutable: false, inFlight: true, unknown: true,
    intents: [false, false, false, false, null, false],
  });
  expect([readStatus.mock.calls, completed.mock.calls]).toEqual([[], []]);
  held.reject(Error("original PUT response lost"));
  expect(await controller.settle()).toBe(true); // settled wire, still unknown until explicit Review
  expect(controller.state).toMatchObject({ inFlight: false, canReview: true, unknown: true });
  expect(await controller.review()).toBe(true);
  expect(readStatus.mock.calls).toEqual([[request.updateId, { token: "alice-token" }]]);
  expect(completed.mock.calls).toEqual([[expect.objectContaining({ updateId: request.updateId, recovered: true })]]);
  expect(write).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
});
it.each(["acl", "create"])("%s dispatch cannot borrow a replacement identity in its queued microtask", async kind => {
  let scope = "alice"; const createAccount = vi.fn(), f = await fixture({ sessionKey: () => scope, createAccount });
  if (kind === "create") { await creating(f); const pending = f.controller.submitDialog(); scope = "bob"; await pending; }
  else { f.controller.setLevel("sam", "view"); const pending = f.controller.requestCommit(); queueMicrotask(() => { scope = "bob"; }); await pending; }
  expect(f.write).not.toHaveBeenCalled(); expect(createAccount).not.toHaveBeenCalled();
});
it("a timed-out create retains its original wire and ID through two early negative reads and one late ACK", async () => {
  vi.useFakeTimers(); const held = heldResponse(), createAccount = vi.fn(() => held.promise), readCreation = vi.fn(async operationId => ({ operationId, committed: false })), notify = vi.fn();
  const f = await fixture({ createAccount, readCreation, notify, timeoutMs: 20 }); await creating(f);
  const pending = f.controller.submitDialog(); await vi.advanceTimersByTimeAsync(21); await pending;
  expect(f.controller.state.provisioningUnknown).toBe(true); expect(f.controller.state.temporaryPassword).toBe("temporary");
  await f.controller.reviewCreation(); const id = createAccount.mock.calls[0][0].operationId;
  expect(readCreation.mock.calls).toEqual([[id, { token: "alice-token" }], [id, { token: "alice-token" }]]);
  held.resolve({ operationId: id, accountId: "jordan", committed: true }); await f.controller.settle();
  expect(f.controller.state).toMatchObject({ provisioningUnknown: false, status: "Account created and added.", temporaryPassword: "" }); expect(createAccount).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
});
it("a negative receipt produced before POST admission cannot conclude noncommit after a lost wire", async () => {
  vi.useFakeTimers();
  const post = heldResponse(), receipt = heldResponse(), entered = Promise.withResolvers();
  const createAccount = vi.fn(() => post.promise), notify = vi.fn();
  const readCreation = vi.fn().mockImplementationOnce(id => { entered.resolve(id); return receipt.promise; })
    .mockImplementationOnce(async operationId => ({ operationId, committed: true, accountId: "created" }));
  const f = await fixture({ createAccount, readCreation, notify, timeoutMs: 20 }), c = f.controller; await creating(f);
  const attempt = c.submitDialog(); await vi.advanceTimersByTimeAsync(20);
  const operationId = await entered.promise;
  post.reject(Error("POST reply lost after server commit"));
  await vi.advanceTimersByTimeAsync(0); // Drain the rejected wire before delivering the earlier receipt.
  receipt.resolve({ operationId, committed: false });
  expect(await attempt).toBe(false);
  expect(c.state).toMatchObject({ provisioningUnknown: true, temporaryPassword: "temporary", error: "The original account creation is still pending. Check its outcome again before continuing." });
  expect(await c.submitDialog()).toBe(false);
  expect(await c.reviewCreation()).toBe(true);
  expect(readCreation.mock.calls).toEqual([[operationId, { token: "alice-token" }], [operationId, { token: "alice-token" }]]);
  expect([createAccount.mock.calls.length, notify.mock.calls.length, c.state.status]).toEqual([1, 1, "Account created and added."]);
});
it("a late POST response cannot unlock or change a newer creation", async () => {
  vi.useFakeTimers();
  const first = heldResponse(), second = heldResponse(), entered = Promise.withResolvers();
  const createAccount = vi.fn().mockReturnValueOnce(first.promise).mockImplementationOnce(request => { entered.resolve(request); return second.promise; });
  const readCreation = vi.fn(async operationId => ({ operationId, committed: true, accountId: "first" })), notify = vi.fn();
  const f = await fixture({ createAccount, readCreation, notify, timeoutMs: 20 }), c = f.controller;
  await creating(f); const a = c.submitDialog(); await vi.advanceTimersByTimeAsync(20); expect(await a).toBe(true);
  await creating(f); c.setField("login", "next"); const b = c.submitDialog(); const request = await entered.promise;
  const firstId = createAccount.mock.calls[0][0].operationId;
  first.resolve({ operationId: firstId, committed: true, accountId: "first" });
  await vi.advanceTimersByTimeAsync(0); // Drain only the released POST, not B's observation deadline.
  expect([c.state.provisioning, c.state.mutable, c.state.login]).toEqual([true, false, "next"]);
  expect(await c.submitDialog()).toBe(false);
  second.resolve({ operationId: request.operationId, committed: true, accountId: "second" }); expect(await b).toBe(true);
  expect(createAccount.mock.calls.map(([input]) => [input.operationId, input.login])).toEqual([[firstId, "jordan"], [request.operationId, "next"]]);
  expect(notify.mock.calls.map(([notice]) => notice.detail.split(" ")[0])).toEqual(["jordan", "next"]);
});
it("an already-resolved departure saves without recursively asking the departure owner", async () => {
  const beforeCommit = vi.fn(async () => false), f = await fixture({ beforeCommit }); f.controller.setLevel("sam", "view");
  expect(await f.controller.resolveDeparture("leaving", "save")).toBe(true); expect(beforeCommit).not.toHaveBeenCalled(); expect(f.write).toHaveBeenCalledOnce();
});
it("explicit discard of a retired Access owner succeeds without reading the replacement scope", async () => {
  let scope = "alice"; const f = await fixture({ sessionKey: () => scope }); f.controller.setLevel("sam", "view"); scope = "bob";
  expect(await f.controller.discard()).toBe(true); expect(f.controller.state.dirty).toBe(false); expect(f.read).toHaveBeenCalledOnce();
});
it("an absent Access owner cannot read or admit changes", async () => {
  const f = await fixture({ sessionKey: () => null }); expect(f.read).not.toHaveBeenCalled(); expect(f.controller.state.view).toBeNull();
});
it("Add existing sends the exact login and selected level with original CAS and credential", async () => {
  const f = await fixture(); await f.controller.openDialog("existing"); f.controller.setField("login", " Morgan "); f.controller.setField("level", "view");
  expect(await f.controller.submitDialog()).toBe(true);
  const request = f.write.mock.calls[0][0];
  expect(f.write.mock.calls).toEqual([[{ everybody: "view", grants: { alice: "admin", sam: "edit" }, additions: [{ login: " Morgan ", level: "view" }], revision: 2, signature: "captured", updateId: request.updateId }, { token: "alice-token" }]]);
  expect(f.controller.state.dialog).toBeNull();
});
it.each(["acl", "create"])("%s admits a retained ACK after permission retirement without reading a replacement session", async kind => {
  let scope = "alice", managed = true; const held = heldResponse(), entered = Promise.withResolvers();
  const write = vi.fn(request => { entered.resolve(request); return held.promise; }), createAccount = vi.fn(request => { entered.resolve(request); return held.promise; });
  const notify = vi.fn(), f = await fixture({ sessionKey: () => scope, canManage: () => managed, write, createAccount, notify });
  let attempt;
  if (kind === "acl") { f.controller.setLevel("sam", "view"); attempt = f.controller.requestCommit(); }
  else { await creating(f); attempt = f.controller.submitDialog(); }
  const request = await entered.promise; managed = false; f.controller.revoke(); scope = "bob";
  held.resolve(kind === "acl" ? { updateId: request.updateId, committed: true, capabilities: { canManageVault: true } } : { operationId: request.operationId, accountId: "jordan", committed: true });
  expect(await attempt).toBe(true); await f.controller.settle();
  expect(f.read).toHaveBeenCalledOnce(); expect(f.controller.state.status).toBe(kind === "acl" ? "Access saved." : "Account created and added.");
  expect([f.completed.mock.calls, notify.mock.calls]).toEqual([[], []]);
  expect([...write.mock.calls, ...createAccount.mock.calls].map(call => call[1])).toEqual([{ token: "alice-token" }]);
});
it("receipt recovery remains independent of retired Admin permission", async () => {
  const readCreation = vi.fn().mockRejectedValueOnce(Error("offline")).mockImplementation(async operationId => ({ operationId, committed: true, accountId: "jordan" }));
  const f = await fixture({ createAccount: async () => { throw Error("lost"); }, readCreation }); await creating(f); await f.controller.submitDialog();
  f.controller.revoke(); expect(await f.controller.reviewCreation()).toBe(true); expect(f.read).toHaveBeenCalledOnce();
  expect(f.controller.state).toMatchObject({ status: "Account created and added.", temporaryPassword: "", provisioningUnknown: false });
});
it("a mismatched receipt cannot clear the original ID or password or send another POST", async () => {
  const createAccount = vi.fn(async () => { throw Error("lost"); }), readCreation = vi.fn(async () => ({ operationId: "foreign", committed: true, accountId: "foreign" }));
  const f = await fixture({ createAccount, readCreation }); await creating(f); expect(await f.controller.submitDialog()).toBe(false);
  expect(f.controller.state).toMatchObject({ provisioningUnknown: true, temporaryPassword: "temporary", status: "" });
  expect(await f.controller.submitDialog()).toBe(false); expect(await f.controller.reviewCreation()).toBe(false);
  expect(readCreation.mock.calls.map(call => call[0])).toEqual([createAccount.mock.calls[0][0].operationId, createAccount.mock.calls[0][0].operationId]); expect(createAccount).toHaveBeenCalledOnce();
});
it("a missing ACL acknowledgment retains unknown work instead of permitting a new write", async () => {
  const write = vi.fn(async () => ({ committed: true, updateId: "foreign" })), f = await fixture({ write });
  f.controller.setLevel("sam", "view"); expect(await f.controller.requestCommit()).toBe(false);
  expect(f.controller.state).toMatchObject({ unknown: true, dirty: true, status: "" }); expect(await f.controller.requestCommit()).toBe(false); expect(write).toHaveBeenCalledOnce();
});
it("confirmation freezes its original choices and cannot borrow a replacement token", async () => {
  let token = "alice-token"; const f = await fixture({ token: () => token }); f.controller.setLevel("alice", "view"); await f.controller.requestCommit();
  expect(f.controller.setLevel("alice", "admin")).toBe(false); token = "bob-token";
  expect(await f.controller.confirmChange()).toBe(false); expect(f.write).not.toHaveBeenCalled(); expect(f.controller.state.grants.alice).toBe("view");
});
it("late reads cannot erase choices edited after their observation deadline", async () => {
  vi.useFakeTimers(); const held = heldResponse(); let reads = 0;
  const f = await fixture({ read: () => ++reads === 1 ? view() : held.promise, timeoutMs: 20 });
  const loading = f.controller.load(); await vi.advanceTimersByTimeAsync(21); expect(await loading).toBeNull();
  f.controller.setLevel("sam", "none"); held.resolve({ ...view(), revision: 3, signature: "later" }); await f.controller.settle();
  expect([f.controller.state.grants.sam, f.controller.state.view.signature, f.controller.state.dirty]).toEqual(["none", "captured", true]);
});
it("an initial Access read timeout is not an unknown write and admits no submission", async () => {
  vi.useFakeTimers(); const held = heldResponse(), read = vi.fn(() => held.promise), write = vi.fn(), completed = vi.fn();
  const controller = createIdentityAccessSettingsState({ read, write, completed, canManage: () => true, token: () => "alice-token", timeoutMs: 20 });
  active.push(controller); const loading = controller.load();
  expect([controller.state.loading, controller.state.mutable, await controller.requestCommit()]).toEqual([true, false, false]);
  await vi.advanceTimersByTimeAsync(20);
  expect([await loading, controller.state.loading, controller.state.unknown, controller.state.canReview, write.mock.calls, completed.mock.calls]).toEqual([null, false, false, false, [], []]);
});
it("a stalled receipt read ends observation but preserves the proposal and forbids replay", async () => {
  vi.useFakeTimers(); const held = heldResponse(), readStatus = vi.fn(() => held.promise);
  const write = vi.fn(async () => { throw Error("lost"); }), completed = vi.fn();
  const f = await fixture({ write, readStatus, completed, timeoutMs: 20 });
  f.controller.setLevel("sam", "none"); expect(await f.controller.requestCommit()).toBe(false);
  const review = f.controller.review(); expect(f.controller.state.reviewing).toBe(true);
  await vi.advanceTimersByTimeAsync(20);
  expect([await review, f.controller.state.reviewing, f.controller.state.unknown, f.controller.state.grants.sam, await f.controller.requestCommit()]).toEqual([false, false, true, "none", false]);
  held.resolve({ matched: true }); await f.controller.settle();
  expect([write.mock.calls.length, readStatus.mock.calls, completed.mock.calls]).toEqual([1, [[write.mock.calls[0][0].updateId, { token: "alice-token" }]], []]);
});
it("failed stale-review read keeps the literal proposal and does not resolve participants again", async () => {
  const original = view();
  const read = vi.fn().mockResolvedValueOnce(original).mockRejectedValueOnce(Error("read failed"));
  const write = vi.fn(async () => { throw { status: 409 }; });
  const beforeCommit = vi.fn(async () => true), completed = vi.fn();
  const f = await fixture({ read, write, beforeCommit, completed });
  f.controller.setLevel("sam", "none"); expect(await f.controller.requestCommit()).toBe(false);
  expect([await f.controller.review(), f.controller.state.needsReview, f.controller.state.view, f.controller.state.grants.sam, await f.controller.requestCommit()]).toEqual([false, true, original, "none", false]);
  expect([beforeCommit.mock.calls, write.mock.calls.length, completed.mock.calls]).toEqual([[[]], 1, []]);
});
it.each(["acl", "create"])("%s whole disposal joins original work, caches its join and prevents late success", async kind => {
  const held = heldResponse(), entered = Promise.withResolvers(), completed = vi.fn(), notify = vi.fn();
  const transport = request => { entered.resolve(request); return held.promise; };
  const f = await fixture({ write: transport, createAccount: transport, completed, notify }); let attempt;
  if (kind === "acl") { f.controller.setLevel("sam", "view"); attempt = f.controller.requestCommit(); } else { await creating(f); attempt = f.controller.submitDialog(); }
  const request = await entered.promise, closing = f.controller.dispose(); expect(f.controller.dispose()).toBe(closing); expect(f.controller.state.temporaryPassword).toBe("");
  held.resolve(kind === "acl" ? { updateId: request.updateId, committed: true } : { operationId: request.operationId, accountId: "jordan", committed: true });
  expect(await attempt).toBe(false); await closing; expect([completed.mock.calls, notify.mock.calls, f.controller.state.status]).toEqual([[], [], ""]);
});
it("reentrant final result inspection cannot publish success after disposal", async () => {
  let controller;
  const f = await fixture({ createAccount: async request => ({ operationId: request.operationId, accountId: "jordan", get committed() { void controller.dispose(); return true; } }) }); controller = f.controller;
  await creating(f); expect(await f.controller.submitDialog()).toBe(false); expect(f.controller.state.status).toBe("");
});
it("a retired form refuses later reads and fences the already admitted old view", async () => {
  let scope = "alice", reads = 0; const held = heldResponse();
  const f = await fixture({ sessionKey: () => scope, read: () => ++reads === 1 ? view() : held.promise });
  const loading = f.controller.load(); scope = "bob"; held.resolve({ ...view(), signature: "foreign" });
  expect(await loading).toBeNull(); expect(await f.controller.load()).toBeNull(); expect(f.controller.state.view.signature).toBe("captured");
  // The queued second read was refused before entering transport.
  expect(reads).toBe(1);
});
it("final permission evaluation cannot change owner and still dispatch an admitted write", async () => {
  let scope = "alice", retire = false;
  const f = await fixture({ sessionKey: () => scope, canManage: () => { if (retire) scope = "bob"; return true; } });
  f.controller.setLevel("sam", "view"); retire = true;
  expect(await f.controller.requestCommit()).toBe(false); expect(f.write).not.toHaveBeenCalled(); expect(f.controller.state.grants.sam).toBe("view");
});
it("completion snapshots capability getters once before final delivery and refresh decisions", async () => {
  let reads = 0;
  const f = await fixture({ write: async request => ({ updateId: request.updateId, committed: true, get capabilities() { reads++; return { canManageVault: false }; } }) });
  f.controller.setLevel("sam", "view"); expect(await f.controller.requestCommit()).toBe(true);
  expect(reads).toBe(1); expect(f.read).toHaveBeenCalledOnce(); expect(f.completed.mock.calls).toEqual([[expect.objectContaining({ capabilities: { canManageVault: false } })]]);
});
it("final view permission evaluation cannot replace the form and still disclose its view", async () => {
  let scope = "alice", reads = 0, retire = false;
  const f = await fixture({ sessionKey: () => scope, read: () => { if (++reads === 2) retire = true; return { ...view(), signature: reads === 1 ? "captured" : "retired" }; }, canManage: () => { if (retire) scope = "bob"; return true; } });
  expect(await f.controller.load()).toBeNull(); expect(f.controller.state.view.signature).toBe("captured"); expect(reads).toBe(2);
});
