// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SetupModal from "../components/SetupModal.vue";
import { createAccessSettingsState } from "../accessSettingsState.js";
import { getAccessSettings, getConfig, postAccessTotpEnrolment, postSetup, putAccessSettings } from "../api.js";

vi.mock("../api.js", () => ({ getAccessSettings: vi.fn(), putAccessSettings: vi.fn(), postAccessTotpEnrolment: vi.fn(),
  postSetup: vi.fn(), postTotpEnrolment: vi.fn(), getConfig: vi.fn() }));
const view = () => ({ mode: "password", username: "alice", totpEnabled: false, settingsWritable: true, readOnlySettings: false, revision: 3, signature: "current", pinned: {} });
let wrapper;
beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; getAccessSettings.mockResolvedValue(view()); putAccessSettings.mockResolvedValue({ view: { ...view(), revision: 4 }, requiresLogin: true }); });
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); });

describe("configured Access through the shared mode/enrolment content", () => {
  it("retains the account without requesting a new password when enabling 2FA", async () => {
    postAccessTotpEnrolment.mockResolvedValue({ key: "new-key", secret: "NEWSECRET", qr: "data:image/png;base64,test" });
    wrapper = mount(SetupModal, { props: { dismissible: true }, attachTo: document.body }); await flushPromises();
    expect(wrapper.get("#setup-username").element.value).toBe("alice");
    expect(wrapper.get("#setup-password").element.value).toBe("");
    await wrapper.get("#setup-totp").trigger("click"); await flushPromises();
    expect(postAccessTotpEnrolment).toHaveBeenCalledWith("alice");
    await wrapper.get("#setup-totp-code").setValue("123456");
    await wrapper.get("#access-current-password").setValue("current-password");
    await wrapper.get("form").trigger("submit"); await flushPromises();
    const data = putAccessSettings.mock.calls[0][0];
    expect(data.password).toBeUndefined(); expect(data.username).toBeUndefined();
    expect(data).toMatchObject({ mode: "password", totpEnabled: true, totpKey: "new-key", totpCode: "123456", currentPassword: "current-password", revision: 3, signature: "current" });
    expect(postSetup).not.toHaveBeenCalled();
  });
  it("current and new authenticator proofs remain distinct and the current key is not disclosed", async () => {
    getAccessSettings.mockResolvedValue({ ...view(), totpEnabled: true });
    wrapper = mount(SetupModal, { props: { dismissible: true }, attachTo: document.body }); await flushPromises();
    expect(postAccessTotpEnrolment).not.toHaveBeenCalled();
    expect(wrapper.find("#setup-totp-code").exists()).toBe(false);
    expect(wrapper.find("#access-current-totp").exists()).toBe(true);
    await wrapper.get("#setup-totp").trigger("click");
    await wrapper.get("#access-current-password").setValue("current-password");
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(putAccessSettings).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Confirm your current password and current authenticator code.");
  });
  it("initial setup radio exploration keeps public locking off", async () => {
    wrapper = mount(SetupModal, { attachTo: document.body });
    await wrapper.get("#setup-mode-read_only").setValue(true);
    await wrapper.get("#setup-mode-password").setValue(true);
    await wrapper.get("#setup-mode-none").setValue(true);
    expect(wrapper.get("#setup-read-only-settings").attributes("aria-checked")).toBe("false");
    expect(wrapper.get("#setup-read-only-settings").element.closest('[aria-hidden="true"]')).toBeNull();
  });
  it("saved protected-to-public defaults on and an explicit choice is retained across radios", async () => {
    wrapper = mount(SetupModal, { props: { dismissible: true }, attachTo: document.body }); await flushPromises();
    await wrapper.get("#setup-mode-none").setValue(true);
    expect(wrapper.get("#setup-read-only-settings").attributes("aria-checked")).toBe("true");
    await wrapper.get("#setup-read-only-settings").trigger("click");
    await wrapper.get("#setup-mode-read_only").setValue(true); await wrapper.get("#setup-mode-none").setValue(true);
    expect(wrapper.get("#setup-read-only-settings").attributes("aria-checked")).toBe("false");
    await wrapper.get("#setup-ack").setValue(true); await wrapper.get("#access-current-password").setValue("current-password");
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(putAccessSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "none", readOnlySettings: false, currentPassword: "current-password" }));
  });
  it("a cancelled enrolment cannot publish its late QR into a newer toggle", async () => {
    let respond; postAccessTotpEnrolment.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    wrapper = mount(SetupModal, { props: { dismissible: true }, attachTo: document.body }); await flushPromises();
    await wrapper.get("#setup-totp").trigger("click"); await flushPromises();
    await wrapper.get("#setup-totp").trigger("click");
    respond({ key: "late-key", qr: "data:image/png;base64,late", secret: "late-secret" }); await flushPromises();
    expect(wrapper.find("#setup-totp-qr").exists()).toBe(false); expect(putAccessSettings).not.toHaveBeenCalled();
  });
});

describe("owned Access unknown-wire recovery", () => {
  it("an observation timeout gives recovery guidance once while retaining the submitted wire", async () => {
    vi.useFakeTimers();
    const write = vi.fn(() => new Promise(() => {}));
    const controller = createAccessSettingsState({ read: async () => view(), write, readStatus: vi.fn(), completed: vi.fn(), timeoutMs: 20 });
    try {
      await controller.load();
      const attempt = controller.commit({ mode: "password", currentPassword: "current-password" }, async () => true);
      await vi.advanceTimersByTimeAsync(21);
      expect(await attempt).toBe(false);
      expect(controller.state.error.match(/Access update outcome is unknown\. Review current access before retrying\./g)).toHaveLength(1);
      expect(controller.state.inFlight).toBe(true);
      expect(controller.canDismiss()).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
    } finally { controller.dispose(); }
  });
  it("a read observation timeout cannot claim that an Access update occurred", async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const controller = createAccessSettingsState({ read: () => new Promise(() => {}), write, readStatus: vi.fn(), completed: vi.fn(), timeoutMs: 20 });
    try {
      const loading = controller.load();
      await vi.advanceTimersByTimeAsync(21);
      expect(await loading).toBeNull();
      expect(controller.state.error).not.toContain("Access update outcome is unknown");
      expect(controller.state.unknown).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });
  it("deadline retains the unresolved wire and blocks replay/dismissal until its own late acknowledgement", async () => {
    vi.useFakeTimers(); let resolve;
    const write = vi.fn(() => new Promise(done => { resolve = done; })), completed = vi.fn();
    const controller = createAccessSettingsState({ read: async () => view(), write, readStatus: vi.fn(), completed, timeoutMs: 20 });
    await controller.load();
    const attempt = controller.commit({ mode: "password", currentPassword: "current-password" }, async () => true);
    await vi.advanceTimersByTimeAsync(21); expect(await attempt).toBe(false);
    expect(controller.state.unknown).toBe(true); expect(controller.state.inFlight).toBe(true);
    expect(controller.canDismiss()).toBe(false); expect(await controller.commit({}, async () => true)).toBe(false);
    expect(await controller.review()).toBe(false); expect(write).toHaveBeenCalledTimes(1);
    resolve({ view: { ...view(), revision: 4 }, requiresLogin: true }); await flushPromises();
    expect(completed).toHaveBeenCalledTimes(1); expect(controller.state.unknown).toBe(false); controller.dispose();
  });
  it("public durable receipt identifies its own lost password-change response without replay or secret exposure", async () => {
    const write = vi.fn(async () => { throw Error("receipt lost"); }), completed = vi.fn();
    const readStatus = vi.fn(); const controller = createAccessSettingsState({ read: async () => view(), write, readStatus, completed });
    await controller.load(); await controller.commit({ mode: "password", password: "new-password", currentPassword: "current-password" }, async () => true); await flushPromises();
    expect(controller.state.unknown).toBe(true);
    readStatus.mockResolvedValue({ authType: "password", accessRevision: 4, accessUpdateId: write.mock.calls[0][0].updateId });
    expect(await controller.review()).toBe(true); expect(write).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ recovered: true, requiresLogin: true })); controller.dispose();
  });
  it("read-back of a committed unchanged protected policy does not invent a credential change or logout", async () => {
    const write = vi.fn(async () => { throw Error("receipt lost"); }), completed = vi.fn(), readStatus = vi.fn();
    const controller = createAccessSettingsState({ read: async () => view(), write, readStatus, completed });
    await controller.load(); await controller.commit({ mode: "password", currentPassword: "current-password" }, async () => true); await flushPromises();
    readStatus.mockResolvedValue({ authType: "password", accessRevision: 4, accessUpdateId: write.mock.calls[0][0].updateId });
    expect(await controller.review()).toBe(true); expect(write).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ recovered: true, requiresLogin: false })); controller.dispose();
  });
  it("a different durable receipt plus denied protected read keeps the original uncertainty without acknowledgement or replay", async () => {
    const denied = { response: { status: 401, data: { detail: "Invalid authentication credentials" } } };
    const read = vi.fn().mockResolvedValueOnce(view()).mockRejectedValue(denied);
    const write = vi.fn(async () => { throw Error("receipt lost"); }), completed = vi.fn();
    const controller = createAccessSettingsState({ read, write, readStatus: async () => ({ authType: "password", accessRevision: 4, accessUpdateId: "another-writer" }), completed });
    await controller.load();
    await controller.commit({ mode: "password", password: "intended-password", currentPassword: "current-password" }, async () => true); await flushPromises();
    expect(await controller.review()).toBe(false);
    expect(controller.state.unknown).toBe(true); expect(controller.canDismiss()).toBe(false);
    expect(completed).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
    expect(await controller.commit({}, async () => true)).toBe(false);
    expect(controller.state.error).toBe("Invalid authentication credentials"); controller.dispose();
  });
  it("a superseding writer is reviewed without inventing our acknowledgement and only an explicit submission retries", async () => {
    const fresh = { ...view(), revision: 5, signature: "superseding" };
    const read = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(fresh), completed = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(Error("receipt lost")).mockResolvedValueOnce({ view: { ...fresh, revision: 6 }, requiresLogin: true });
    const controller = createAccessSettingsState({ read, write, readStatus: async () => ({ authType: "password", accessRevision: 5, accessUpdateId: "another-writer" }), completed });
    await controller.load();
    const choices = { mode: "password", password: "retained-proposed-password", currentPassword: "current-password" };
    await controller.commit(choices, async () => true); await flushPromises();
    expect(await controller.review()).toBe(true); expect(controller.state.view).toEqual(fresh);
    expect(controller.state.unknown).toBe(false); expect(completed).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
    expect(choices.password).toBe("retained-proposed-password");
    expect(await controller.commit(choices, async () => true)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toMatchObject({ ...choices, revision: 5, signature: "superseding" });
    expect(write.mock.calls[1][0].updateId).not.toBe(write.mock.calls[0][0].updateId);
    expect(completed).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it("a stalled explicit read-back is bounded while uncertainty and duplicate-write protection remain", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => { throw Error("receipt lost"); }), completed = vi.fn();
    const controller = createAccessSettingsState({ read: async () => view(), write, readStatus: () => new Promise(() => {}), completed, timeoutMs: 20 });
    await controller.load(); await controller.commit({ mode: "password", password: "intended-password", currentPassword: "current-password" }, async () => true); await flushPromises();
    const reviewing = controller.review(); await vi.advanceTimersByTimeAsync(21);
    expect(await reviewing).toBe(false); expect(controller.state.reviewing).toBe(false);
    expect(controller.state.unknown).toBe(true); expect(controller.canDismiss()).toBe(false);
    expect(await controller.commit({}, async () => true)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1); expect(completed).not.toHaveBeenCalled(); controller.dispose();
  });
});

describe("review repairs: R14 Access conflict review ownership", () => {
  const conflict = { response: { status: 409, data: { code: "access_conflict", detail: "Access changed elsewhere." } } };
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  it("review repairs: R14 known CAS conflict blocks stale resubmission until a separate accepted review", async () => {
    const read = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue({ ...view(), revision: 5, signature: "fresh" });
    const write = vi.fn().mockRejectedValue(conflict), beforeCommit = vi.fn(async () => true), completed = vi.fn();
    const state = createAccessSettingsState({ read, write, readStatus: async () => ({}), completed });
    try {
      await state.load();
      expect(await state.commit({ mode: "read_only", currentPassword: "current" }, beforeCommit)).toBe(false);
      expect(await state.commit({ mode: "read_only", currentPassword: "current" }, beforeCommit)).toBe(false);
      expect(write).toHaveBeenCalledTimes(1); expect(beforeCommit).toHaveBeenCalledTimes(1);
      expect(state.state.needsReview).toBe(true);
      expect(await state.review()).toBe(true);
      expect(state.state.view).toMatchObject({ revision: 5, signature: "fresh" });
      expect(state.state.needsReview).toBe(false); expect(completed).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1); expect(beforeCommit).toHaveBeenCalledTimes(1);
    } finally { state.dispose(); }
  });
  it("review repairs: R14 mounted Review retains proposed credentials and bundle without renaming the changed current account", async () => {
    const beforeCommit = vi.fn(async () => true);
    postAccessTotpEnrolment.mockResolvedValue({ key: "retained-key", secret: "RETAINEDSECRET", qr: "data:image/png;base64,retained" });
    putAccessSettings.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ view: { ...view(), username: "bob", totpEnabled: true, revision: 6 }, requiresLogin: true });
    wrapper = mount(SetupModal, { props: { dismissible: true, beforeCommit }, attachTo: document.body }); await flushPromises();
    await wrapper.get("#setup-password").setValue("proposed-new-password");
    await wrapper.get("#setup-totp").trigger("click"); await flushPromises();
    await wrapper.get("#setup-totp-code").setValue("123456");
    await wrapper.get("#access-current-password").setValue("old-current-password");
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(putAccessSettings).toHaveBeenCalledTimes(1);
    const review = wrapper.findAll("button").find(button => button.text() === "Review current access");
    expect(review).toBeDefined();
    getConfig.mockResolvedValue({ accessRevision: 5, accessUpdateId: "other-writer" });
    getAccessSettings.mockResolvedValue({ ...view(), username: "bob", totpEnabled: true, revision: 5, signature: "fresh-account" });
    await review.trigger("click"); await flushPromises();
    expect(wrapper.get("#setup-username").element.value).toBe("bob");
    expect(wrapper.get("#setup-password").element.value).toBe("proposed-new-password");
    expect(wrapper.get("#setup-totp-code").element.value).toBe("123456");
    expect(wrapper.get("#setup-totp-qr img").attributes("src")).toBe("data:image/png;base64,retained");
    expect(wrapper.find("#access-current-totp").exists()).toBe(true);
    expect(postAccessTotpEnrolment).toHaveBeenCalledTimes(1); expect(putAccessSettings).toHaveBeenCalledTimes(1);
    expect(beforeCommit).toHaveBeenCalledTimes(1);
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(putAccessSettings).toHaveBeenCalledTimes(1);
    await wrapper.get("#access-current-password").setValue("fresh-current-password");
    await wrapper.get("#access-current-totp").setValue("654321");
    await wrapper.get("form").trigger("submit"); await flushPromises();
    expect(beforeCommit).toHaveBeenCalledTimes(2); expect(putAccessSettings).toHaveBeenCalledTimes(2);
    expect(putAccessSettings.mock.calls[1][0]).toMatchObject({ mode: "password", password: "proposed-new-password", revision: 5,
      signature: "fresh-account", currentPassword: "fresh-current-password", currentTotp: "654321", totpKey: "retained-key", totpCode: "123456" });
    expect(putAccessSettings.mock.calls[1][0].username).toBeUndefined();
  });
  it("review repairs: R14 review cannot publish across a newer form load", async () => {
    const held = deferred(), current = { ...view(), revision: 8, signature: "new-owner" };
    const read = vi.fn().mockResolvedValueOnce(view()).mockReturnValueOnce(held.promise).mockResolvedValueOnce(current);
    const completed = vi.fn(), state = createAccessSettingsState({ read, write: async () => { throw conflict; }, readStatus: async () => ({}), completed });
    try {
      await state.load(); await state.commit({ mode: "read_only" }, async () => true);
      const reviewing = state.review(); await flushPromises(); await state.load();
      held.resolve({ ...view(), revision: 5, signature: "old-review" });
      expect(await reviewing).toBe(false); expect(state.state.view).toEqual(current); expect(completed).not.toHaveBeenCalled();
    } finally { held.resolve(view()); state.dispose(); }
  });
  it("review repairs: R14 a changed admission while resolving participants cannot silently borrow its new CAS", async () => {
    const held = deferred(), write = vi.fn(), read = vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce({ ...view(), revision: 7, signature: "replacement" });
    const state = createAccessSettingsState({ read, write, readStatus: async () => ({}), completed: vi.fn() });
    try {
      await state.load(); const committing = state.commit({ mode: "read_only" }, () => held.promise);
      await state.load(); held.resolve(true);
      expect(await committing).toBe(false); expect(write).not.toHaveBeenCalled();
    } finally { held.resolve(false); state.dispose(); }
  });
  it("review repairs: R14 failed conflict review retains the proposal gate without another participant resolution", async () => {
    const read = vi.fn().mockResolvedValueOnce(view()).mockRejectedValue(Error("read unavailable")), write = vi.fn().mockRejectedValue(conflict);
    const beforeCommit = vi.fn(async () => true), state = createAccessSettingsState({ read, write, readStatus: async () => ({}), completed: vi.fn() });
    try {
      await state.load(); await state.commit({ mode: "read_only" }, beforeCommit);
      expect(await state.review()).toBe(false); expect(state.state.needsReview).toBe(true);
      expect(state.state.view).toEqual(view()); expect(await state.commit({ mode: "read_only" }, beforeCommit)).toBe(false);
      expect(write).toHaveBeenCalledTimes(1); expect(beforeCommit).toHaveBeenCalledTimes(1);
    } finally { state.dispose(); }
  });
});
