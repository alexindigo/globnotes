import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { registerSessionParticipant, resolveParticipants, hasUnsavedWork } from "../sessionActions.js";
import Modal from "../components/Modal.vue";
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

describe("modal ownership", () => {
  it("only the newest same-labelled dialog handles Escape", async () => {
    const lower = mountOwned(Modal, { props: { modelValue: true, name: "confirm" } });
    const top = mountOwned(Modal, { props: { modelValue: true, name: "confirm" } });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await nextTick();
    expect(top.emitted("update:modelValue")).toEqual([[false]]);
    expect(lower.emitted("update:modelValue")).toBeUndefined();
  });
});
