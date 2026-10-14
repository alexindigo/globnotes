import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { registerSessionParticipant, resolveParticipants, hasUnsavedWork } from "../sessionActions.js";
import SetupModal from "../components/SetupModal.vue";
import Modal from "../components/Modal.vue";
import { postSetup, putAccessSettings, resetSetup } from "../api.js";

vi.mock("../api.js", () => ({ postSetup: vi.fn(async () => ({})), resetSetup: vi.fn(), postTotpEnrolment: vi.fn(),
  getAccessSettings: vi.fn(async () => ({ mode: "password", username: "alice", totpEnabled: false, settingsWritable: true, revision: 0, signature: "initial", pinned: {} })),
  putAccessSettings: vi.fn(async () => ({ view: { mode: "password", username: "alice", settingsWritable: true, revision: 1, pinned: {} }, requiresLogin: true })),
  postAccessTotpEnrolment: vi.fn(), getConfig: vi.fn() }));
const disposers = [];
const wrappers = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});
const register = (id, callbacks) => {
  const dispose = registerSessionParticipant(id, callbacks);
  disposers.push(dispose);
  return dispose;
};
const mountOwned = (component, options) => {
  const wrapper = mount(component, { attachTo: document.body, ...options });
  wrappers.push(wrapper);
  return wrapper;
};

describe("session ownership and permission", () => {
  it("an obsolete disposer cannot unregister a newer Note", () => {
    const old = register("note", { hasUnsavedChanges: () => false });
    register("note", { hasUnsavedChanges: () => true });
    old();
    expect(hasUnsavedWork()).toBe(true);
  });

  it("collects all decisions before applying a discard", async () => {
    const discard = vi.fn();
    register("settings", { hasUnsavedChanges: () => true, requestDecision: async () => "discard", discard });
    register("note", { hasUnsavedChanges: () => true, requestDecision: async () => "cancel" });
    expect(await resolveParticipants("logout")).toBe("cancel");
    expect(discard).not.toHaveBeenCalled();
  });

  it("deduplicates repeated handoff requests", async () => {
    let decide;
    const requestDecision = vi.fn(() => new Promise(resolve => { decide = resolve; }));
    const save = vi.fn(async () => true);
    register("note", { hasUnsavedChanges: () => true, requestDecision, save });
    const first = resolveParticipants("logout");
    const second = resolveParticipants("logout");
    await flushPromises();
    expect(requestDecision).toHaveBeenCalledTimes(1);
    decide("save");
    expect(await first).toBe("proceed");
    expect(await second).toBe("proceed");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("participant teardown resolves an abandoned prompt as Cancel", async () => {
    const dispose = register("note", { hasUnsavedChanges: () => true, requestDecision: () => new Promise(() => {}) });
    const result = resolveParticipants("access");
    dispose();
    expect(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve("hung"), 100))])).toBe("cancel");
  });
});

describe("wizard before-commit permission", () => {
  async function wizard(beforeCommit) {
    const wrapper = mountOwned(SetupModal, { props: { dismissible: true, beforeCommit } });
    await flushPromises();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("new-secret");
    await wrapper.find("#access-current-password").setValue("old-secret");
    return wrapper;
  }

  it("Cancel retains the wizard and credentials without resetting access", async () => {
    const beforeCommit = vi.fn(async () => false);
    const wrapper = await wizard(beforeCommit);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(beforeCommit).toHaveBeenCalledTimes(1);
    expect(resetSetup).not.toHaveBeenCalled();
    expect(postSetup).not.toHaveBeenCalled();
    expect(wrapper.find("#setup-password").element.value).toBe("new-secret");
    expect(wrapper.find("button[type=submit]").element.disabled).toBe(false);
  });

  it("waits for permission with current credentials and single-flight Finish", async () => {
    let allow;
    const beforeCommit = vi.fn(() => new Promise(resolve => { allow = resolve; }));
    const wrapper = await wizard(beforeCommit);
    await wrapper.find("form").trigger("submit");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(beforeCommit).toHaveBeenCalledTimes(1);
    expect(resetSetup).not.toHaveBeenCalled();
    allow(true);
    await flushPromises();
    expect(resetSetup).not.toHaveBeenCalled();
    expect(postSetup).not.toHaveBeenCalled();
    expect(putAccessSettings).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("only the newest same-labelled dialog handles Escape", async () => {
    const lower = mountOwned(Modal, { props: { modelValue: true, name: "confirm" } });
    const top = mountOwned(Modal, { props: { modelValue: true, name: "confirm" } });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await nextTick();
    expect(top.emitted("update:modelValue")).toEqual([[false]]);
    expect(lower.emitted("update:modelValue")).toBeUndefined();
  });
});
