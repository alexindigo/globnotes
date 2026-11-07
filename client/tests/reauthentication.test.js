import { describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createReauthentication } from "../reauthentication.js";
import { createLoginFlow } from "../loginFlow.js";
import { registerSessionParticipant, retainUnsavedWork } from "../sessionActions.js";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
describe("in-place reauthentication owner", () => {
  it("deduplicates requests, retires authority before showing, and restores before releasing saves", async () => {
    const invalidated = deferred(), restored = deferred(), changes = [];
    const owner = createReauthentication({ invalidate: () => invalidated.promise, restored: () => restored.promise, changed: value => changes.push(value) });
    const first = owner.request(), second = owner.request();
    expect(second).toBe(first); await flushPromises(); expect(changes).toEqual([]);
    invalidated.resolve(); await flushPromises();
    const form = changes.at(-1); expect(form.isCurrent()).toBe(true);
    let saved = false; first.then(accepted => { saved = accepted; });
    const accepted = form.authenticated(); await flushPromises(); expect(saved).toBe(false);
    restored.resolve(); await accepted; expect(await first).toBe(true); expect(await second).toBe(true);
    expect(changes.at(-1)).toBeNull(); expect(form.isCurrent()).toBe(false);
  });
  it("cancel retains the owner callbacks and fences an obsolete form from its replacement", async () => {
    const changes = [], owner = createReauthentication({ changed: value => changes.push(value) });
    const first = owner.request(); await flushPromises(); const old = changes.at(-1);
    old.cancel(); expect(await first).toBe(false);
    const second = owner.request(); await flushPromises(); const current = changes.at(-1);
    expect(await old.authenticated()).toBe(false); old.cancel(); expect(current.isCurrent()).toBe(true);
    current.cancel(); expect(await second).toBe(false);
  });
  it("a cancelled login's late acknowledgement cannot persist credentials or navigate", async () => {
    const token = deferred(), persistToken = vi.fn(), navigate = vi.fn(), changes = [];
    const owner = createReauthentication({ changed: value => changes.push(value) });
    const outcome = owner.request(); await flushPromises(); const form = changes.at(-1);
    const flow = createLoginFlow({ credentials: () => ({ username: "a", password: "b" }), requestToken: () => token.promise,
      persistToken, navigate, isCurrent: form.isCurrent, authenticated: form.authenticated });
    const sending = flow.logIn(); form.cancel(); token.resolve("late token"); await sending;
    expect(await outcome).toBe(false); expect(persistToken).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it("flushes existing dirty participants without invoking their departure or save callbacks", () => {
    const retainForAuthentication = vi.fn(), requestDecision = vi.fn(), save = vi.fn(), discard = vi.fn();
    const dirty = registerSessionParticipant("auth-dirty", { hasUnsavedChanges: () => true, retainForAuthentication, requestDecision, save, discard });
    const cleanRetention = vi.fn(), clean = registerSessionParticipant("auth-clean", { hasUnsavedChanges: () => false, retainForAuthentication: cleanRetention });
    try {
      retainUnsavedWork(); expect(retainForAuthentication).toHaveBeenCalledTimes(1);
      expect(cleanRetention).not.toHaveBeenCalled(); expect(requestDecision).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
    } finally { dirty(); clean(); }
  });
});
