// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { flushPromises } from "@vue/test-utils";
import { createSetupFormState } from "../setupFormState.js";
import * as api from "../api.js";

vi.mock("../api.js", () => ({
  getAccessSettings: vi.fn(), putAccessSettings: vi.fn(), getConfig: vi.fn(),
  postAccessTotpEnrolment: vi.fn(), postTotpEnrolment: vi.fn(), postSetup: vi.fn(),
}));

const view = (overrides = {}) => ({
  mode: "password", username: "alice", totpEnabled: false, settingsWritable: true,
  readOnlySettings: false, revision: 3, signature: "current", pinned: {}, ...overrides,
});
const bundle = { key: "minted-key", secret: "BASE32SECRET", qr: "data:image/png;base64,qr" };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const controllers = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.clearAllMocks(); });

function setup(overrides = {}) {
  const adapters = {
    readAccess: vi.fn(async () => view()),
    writeAccess: vi.fn(async () => ({ view: view({ revision: 4 }), requiresLogin: true })),
    readStatus: vi.fn(async () => ({})), enrolAccess: vi.fn(async () => bundle),
    enrolSetup: vi.fn(async () => bundle), submitSetup: vi.fn(async () => ({})),
    copy: vi.fn(async () => {}), beforeCommit: vi.fn(async () => true),
    completed: vi.fn(), focus: vi.fn(), ...overrides,
  };
  const form = createSetupFormState(adapters);
  controllers.push(form);
  return { form, state: form.state, ...adapters };
}
function credentials(form) {
  form.setField("username", "alice"); form.setField("password", "secret");
}
async function mode(form, value) { form.setField("mode", value); await nextTick(); }
async function enrol(form) { form.setField("totpEnabled", true); await flushPromises(); }
async function configured(overrides = {}) {
  const result = setup({ dismissible: () => true, ...overrides });
  await result.form.load(); await nextTick();
  return result;
}

describe("setup form fields and validation", () => {
  it("starts with password mode, empty credentials and no first-run access read", async () => {
    const { form, state, readAccess } = setup();
    await form.load();
    expect(state).toMatchObject({ mode: "password", username: "", password: "", totpEnabled: false, acked: false, readOnlySettings: false, pending: false });
    expect(state.disabled.submit).toBe(false); expect(state.disabled.ack).toBe(true);
    expect(readAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["", "", "username", true, true],
    ["alice", "", "password", false, true],
  ])("validates credentials %s/%s before resolving participants", async (username, password, target, missingUsername, missingPassword) => {
    const { form, state, beforeCommit, submitSetup, focus } = setup();
    form.setField("username", username); form.setField("password", password);
    await form.finish(); await nextTick();
    expect(state).toMatchObject({ missingUsername, missingPassword, message: "Enter a username and password." });
    expect(focus).toHaveBeenCalledWith(target);
    expect(beforeCommit).not.toHaveBeenCalled(); expect(submitSetup).not.toHaveBeenCalled();
  });

  it.each(["", "12345", "1234567", "abcdef", "123 56"])("requires six digits for new enrolment: %s", async code => {
    const { form, state, submitSetup, focus } = setup(); credentials(form); await enrol(form);
    form.setField("totpCode", code); await form.finish(); await nextTick();
    expect(state.missingTotp).toBe(true);
    expect(state.message).toBe("Enter the current 6-digit code from your authenticator.");
    expect(focus).toHaveBeenCalledWith("totpCode"); expect(submitSetup).not.toHaveBeenCalled();
  });

  it("keeps credentials and lock choice but resets masking, acknowledgement and validation across modes", async () => {
    const { form, state } = setup(); credentials(form);
    form.setField("showPassword", true); form.setField("readOnlySettings", true);
    await mode(form, "none"); await form.finish();
    expect(state.missingAck).toBe(true);
    form.setField("acked", true); await mode(form, "read_only"); await mode(form, "password");
    expect(state).toMatchObject({ username: "alice", password: "secret", readOnlySettings: true, showPassword: false, acked: false, missingAck: false, message: "" });
  });

  it("requires open-access acknowledgement before resolving participants and requests checkbox focus", async () => {
    const { form, state, focus, beforeCommit } = setup(); await mode(form, "none");
    expect(state.disabled.submit).toBe(true);
    await form.finish(); await nextTick();
    expect(state.message).toBe("Confirm that you understand open access.");
    expect(focus).toHaveBeenCalledWith("ack"); expect(beforeCommit).not.toHaveBeenCalled();
    form.setField("acked", true); expect(state.disabled.submit).toBe(false);
  });
});

describe("first-run payload and owned submission", () => {
  it("submits literal credentials and the minted key/code, retaining busy state through completion", async () => {
    const { form, state, submitSetup, completed } = setup(); credentials(form); await enrol(form);
    form.setField("totpCode", "012345"); await form.finish(); await flushPromises();
    expect(submitSetup).toHaveBeenCalledExactlyOnceWith({ mode: "password", username: "alice", password: "secret", totpKey: bundle.key, totpCode: "012345" });
    expect(completed).toHaveBeenCalledExactlyOnceWith(); expect(state.pending).toBe(true);
  });

  it.each(["read_only", "none"])("omits credentials and enrolment in %s", async chosen => {
    const { form, submitSetup } = setup(); credentials(form); await enrol(form);
    form.setField("totpCode", "123456"); await mode(form, chosen); form.setField("acked", true);
    await form.finish(); await flushPromises();
    expect(submitSetup).toHaveBeenCalledExactlyOnceWith(chosen === "none" ? { mode: chosen, readOnlySettings: false } : { mode: chosen });
  });

  it("omits disabled TOTP and preserves open acknowledgement after a failed request", async () => {
    const { form, state, submitSetup } = setup({ submitSetup: vi.fn().mockRejectedValue(Error("offline")) });
    credentials(form); await enrol(form); form.setField("totpEnabled", false); await nextTick();
    await form.finish(); await flushPromises();
    expect(submitSetup).toHaveBeenLastCalledWith({ mode: "password", username: "alice", password: "secret" });
    await mode(form, "none"); form.setField("acked", true); await form.finish(); await flushPromises();
    expect(state).toMatchObject({ acked: true, pending: false, message: "Setup failed. Please try again." });
  });

  it("captures before participant resolution and blocks duplicate submit/dismissal through the wire", async () => {
    const admission = deferred(), wire = deferred();
    const { form, state, submitSetup } = setup({ beforeCommit: () => admission.promise, submitSetup: vi.fn(() => wire.promise) });
    credentials(form); const finishing = form.finish();
    expect(state.pending).toBe(true); expect(form.canDismiss()).toBe(false);
    await form.finish(); expect(submitSetup).not.toHaveBeenCalled();
    form.setField("password", "newer"); admission.resolve(true); await finishing;
    expect(submitSetup).toHaveBeenCalledExactlyOnceWith({ mode: "password", username: "alice", password: "secret" });
    await form.finish(); expect(submitSetup).toHaveBeenCalledTimes(1);
    wire.resolve({}); await flushPromises(); expect(state.pending).toBe(true);
  });

  it.each([false, undefined, "yes"])("does not submit when beforeCommit returns %s", async result => {
    const { form, state, submitSetup, completed } = setup({ beforeCommit: async () => result }); credentials(form);
    await form.finish(); expect(state.pending).toBe(false);
    expect(submitSetup).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
  });

  it("retains choices and reports participant-resolution rejection", async () => {
    const { form, state, submitSetup } = setup({ beforeCommit: async () => { throw Error("unresolved"); } }); credentials(form);
    await form.finish();
    expect(state).toMatchObject({ username: "alice", password: "secret", pending: false, message: "Your changes could not be resolved. Keep editing and try again." });
    expect(submitSetup).not.toHaveBeenCalled();
  });

  it("does not start a setup request after disposal while resolving participants", async () => {
    const admission = deferred(); const { form, submitSetup } = setup({ beforeCommit: () => admission.promise }); credentials(form);
    const finishing = form.finish(); form.dispose(); admission.resolve(true); await finishing;
    expect(submitSetup).not.toHaveBeenCalled();
  });

  it.each([
    [Error("env-pinned"), "Access mode is pinned by environment configuration."],
    [{ response: { status: 400, data: { detail: "Code mismatch" } } }, "Code mismatch"],
    [{ response: { status: 400, data: {} } }, "Setup failed. Please try again."],
    [{ response: { status: 500, data: { detail: "Private detail" } } }, "Setup failed. Please try again."],
    [Error("network"), "Setup failed. Please try again."],
  ])("classifies setup errors without dropping values: %j", async (error, message) => {
    const { form, state, completed } = setup({ submitSetup: vi.fn().mockRejectedValue(error) }); credentials(form);
    await form.finish(); await flushPromises();
    expect(state).toMatchObject({ message, pending: false, username: "alice", password: "secret" });
    expect(completed).not.toHaveBeenCalled();
  });

  it("clears only the code after a 400, retaining the bundle for retry", async () => {
    const { form, state, focus } = setup({ submitSetup: vi.fn().mockRejectedValue({ response: { status: 400, data: { detail: "Wrong code" } } }) });
    credentials(form); await enrol(form); form.setField("totpCode", "123456");
    await form.finish(); await flushPromises();
    expect(state).toMatchObject({ totpCode: "", totpKey: bundle.key, totpSecret: bundle.secret, totpQr: bundle.qr });
    expect(focus).toHaveBeenCalledWith("totpCode");
  });
});

describe("ticketed enrolment and copy arming", () => {
  it.each(["success", "failure"])("ignores late enrolment %s after a new toggle", async outcome => {
    const old = deferred(); const { form, state, enrolSetup } = setup({ enrolSetup: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(bundle) });
    await enrol(form); form.setField("totpEnabled", false); await nextTick(); await enrol(form);
    if (outcome === "success") old.resolve({ key: "old", secret: "OLD", qr: "old" }); else old.reject(Error("old failure"));
    await flushPromises();
    expect(state).toMatchObject({ totpEnabled: true, totpKey: bundle.key, totpSecret: bundle.secret, feedback: "" });
    expect(enrolSetup).toHaveBeenCalledTimes(2);
  });

  it("rolls failed enrolment off and clears stale code/bundle", async () => {
    const { form, state } = setup({ enrolSetup: vi.fn().mockRejectedValue(Error("offline")) });
    form.setField("totpCode", "123456"); await enrol(form);
    expect(state).toMatchObject({ totpEnabled: false, totpCode: "", totpKey: "", totpSecret: "", totpQr: "", message: "Could not start TOTP enrolment. Please try again." });
  });

  it("retires pending enrolment on disposal", async () => {
    const held = deferred(); const { form, state } = setup({ enrolSetup: () => held.promise }); await enrol(form);
    form.dispose(); held.resolve(bundle); await flushPromises();
    expect(state.totpKey).toBe(""); expect(state.totpSecret).toBe("");
  });

  it.each(["success", "failure"])("requires two activations and rearms after copy %s", async outcome => {
    const copy = vi.fn(outcome === "success" ? async () => {} : async () => { throw Error("denied"); });
    const { form, state } = setup({ copy }); await enrol(form);
    await form.copyTotpKey(); expect(copy).not.toHaveBeenCalled();
    expect(state.copyFeedback).toBe("Click again to copy the setup key.");
    await form.copyTotpKey(); expect(copy).toHaveBeenCalledExactlyOnceWith(bundle.secret);
    expect(state.copyFeedback).toBe(outcome === "success" ? "Setup key copied." : "Could not copy the setup key. Please try again.");
    await form.copyTotpKey(); expect(copy).toHaveBeenCalledTimes(1); expect(state.copyArmed).toBe(true);
  });

  it.each(["focus", "blur", "mode", "enrolment", "dispose"])("retires late copy feedback on %s", async departure => {
    const held = deferred(); const { form, state, copy } = setup({ copy: vi.fn(() => held.promise) }); await enrol(form);
    await form.copyTotpKey(); const copying = form.copyTotpKey(); await form.copyTotpKey();
    expect(state.copying).toBe(true); expect(copy).toHaveBeenCalledTimes(1);
    if (departure === "focus") form.copyFocus(false);
    if (departure === "blur") form.copyBlur(true);
    if (departure === "mode") await mode(form, "read_only");
    if (departure === "enrolment") { form.setField("totpEnabled", false); await nextTick(); await enrol(form); }
    if (departure === "dispose") form.dispose();
    held.resolve(); await copying;
    expect(state.copyFeedback).not.toBe("Setup key copied."); expect(state.copying).toBe(false);
  });

  it("preserves the attempt on QR focus and automatic busy blur without a next owner", async () => {
    const held = deferred(); const { form, state } = setup({ copy: () => held.promise }); await enrol(form);
    await form.copyTotpKey(); form.copyFocus(true);
    const copying = form.copyTotpKey(); form.copyBlur(false); held.resolve(); await copying;
    expect(state.copyFeedback).toBe("Setup key copied.");
    form.copyBlur(false); expect(state.copyFeedback).toBe(""); expect(state.copyArmed).toBe(false);
  });
});

describe("configured Access ownership and control policy", () => {
  it('projects save, unknown and review labels from the configured workflow', async () => {
    const wire=deferred(), status=deferred();
    const {form,state}=await configured({writeAccess:()=>wire.promise,readStatus:()=>status.promise});
    expect(state.submitLabel).toBe('Save access settings'); form.setField('currentPassword','current');
    const saving=form.finish(); await flushPromises(); expect(state.submitLabel).toBe('Saving access settings…');
    wire.reject(Error('receipt lost')); await saving; expect(state.submitLabel).toBe('Waiting for the server to confirm…');
    const review=form.review(); await flushPromises(); expect(state.submitLabel).toBe('Checking current access…');
    status.resolve({}); await review; expect(state.submitLabel).toBe('Save access settings');
  });
  it("loads protected defaults and omits untouched username/password and old authenticator keys", async () => {
    const { form, state, writeAccess, enrolAccess, submitSetup } = await configured({ readAccess: async () => view({ totpEnabled: true }) });
    expect(state).toMatchObject({ existingAccount: true, existingTotp: true, username: "alice", password: "", readOnlySettings: true, showEnrolment: false, showReplacement: true });
    form.setField("currentPassword", "current"); form.setField("currentTotp", "654321"); await form.finish();
    const data = writeAccess.mock.calls[0][0];
    expect(data).toMatchObject({ mode: "password", totpEnabled: true, currentPassword: "current", currentTotp: "654321", revision: 3, signature: "current" });
    expect(data.username).toBeUndefined(); expect(data.password).toBeUndefined(); expect(data.totpKey).toBeUndefined(); expect(data.totpCode).toBeUndefined();
    expect(enrolAccess).not.toHaveBeenCalled(); expect(submitSetup).not.toHaveBeenCalled();
  });

  it("replaces an authenticator with a new bundle and keeps current proof separate", async () => {
    const { form, state, enrolAccess, enrolSetup, writeAccess } = await configured({ readAccess: async () => view({ totpEnabled: true }) });
    await form.replaceAuthenticator(); await flushPromises();
    expect(enrolAccess).toHaveBeenCalledExactlyOnceWith("alice"); expect(enrolSetup).not.toHaveBeenCalled();
    expect(state.showEnrolment).toBe(true); expect(state.showReplacement).toBe(false);
    form.setField("totpCode", "123456"); form.setField("currentPassword", "current"); form.setField("currentTotp", "654321");
    await form.finish(); expect(writeAccess).toHaveBeenCalledWith(expect.objectContaining({ totpKey: bundle.key, totpCode: "123456", currentTotp: "654321" }));
  });

  it("retains explicit username intent and includes a new password", async () => {
    const { form, writeAccess } = await configured();
    form.setField("username", "bob"); form.setField("password", "new"); form.setField("currentPassword", "old");
    await form.finish(); expect(writeAccess).toHaveBeenCalledWith(expect.objectContaining({ username: "bob", password: "new", currentPassword: "old" }));
  });

  it.each([false, true])("requires current proof when the existing authenticator is %s", async totpEnabled => {
    const { form, state, beforeCommit, writeAccess } = await configured({ readAccess: async () => view({ totpEnabled }) });
    if (totpEnabled) form.setField("currentPassword", "current");
    await form.finish(); expect(state.message).toBe("Confirm your current password and current authenticator code.");
    expect(beforeCommit).not.toHaveBeenCalled(); expect(writeAccess).not.toHaveBeenCalled();
  });

  it.each(["none", "read_only"])("omits inactive credentials/enrolment when configuring %s", async chosen => {
    const { form, writeAccess } = await configured();
    await mode(form, chosen); form.setField("acked", true); form.setField("currentPassword", "current"); await form.finish();
    const data = writeAccess.mock.calls[0][0];
    expect(data).toMatchObject({ mode: chosen, currentPassword: "current" });
    expect(data.username).toBeUndefined(); expect(data.password).toBeUndefined(); expect(data.totpEnabled).toBeUndefined();
    expect(data.readOnlySettings).toBe(chosen === "none" ? true : undefined);
  });

  it("initializes saved public locking without adding an account proof", async () => {
    const { form, state, writeAccess } = await configured({ readAccess: async () => view({ mode: "none", username: "", readOnlySettings: false }) });
    expect(state).toMatchObject({ mode: "none", readOnlySettings: false, existingAccount: false });
    await mode(form, "password"); credentials(form); await form.finish();
    const data = writeAccess.mock.calls[0][0];
    expect(data).toMatchObject({ username: "alice", password: "secret", totpEnabled: false }); expect(data.currentPassword).toBeUndefined();
  });

  it.each([
    ["mode", ["mode"]], ["username", ["username"]], ["password", ["password"]],
    ["totp", ["totp", "replaceAuthenticator"]], ["sessions", ["password", "totp", "replaceAuthenticator"]],
  ])("computes %s pin policy centrally without pinning unrelated password controls", async (pin, expected) => {
    const { state } = await configured({ readAccess: async () => view({ pinned: { [pin]: true } }) });
    for (const key of ["mode", "username", "password", "totp", "replaceAuthenticator"]) {
      expect(!!state.disabled[key], key).toBe(expected.includes(key));
    }
  });

  it("handles public lock pin, nonwritable settings and inactive panels in its snapshot", async () => {
    const { form, state } = await configured({ readAccess: async () => view({ mode: "none", username: "", settingsWritable: false, pinned: { readOnlySettings: true } }) });
    form.setField("acked", true);
    expect(state.disabled.readOnlySettings).toBe(true); expect(state.disabled.submit).toBe(true);
    for (const key of ["username", "password", "totp", "qr", "code"]) expect(state.disabled[key]).toBe(true);
    expect(state.disabled.ack).toBe(false);
  });

  it("blocks form submit during initial access load", async () => {
    const held = deferred(); const { form, state, writeAccess, submitSetup } = setup({ dismissible: () => true, readAccess: () => held.promise });
    const loading = form.load(); expect(state.accessLoading).toBe(true);
    expect(state.disabled.mode).toBe(true); expect(state.disabled.submit).toBe(true);
    await form.finish(); expect(writeAccess).not.toHaveBeenCalled(); expect(submitSetup).not.toHaveBeenCalled();
    held.resolve(view()); await loading;
  });

  it.each([false, true])("reviews conflicts without replay and refreshes only untouched username (edited=%s)", async edited => {
    const conflict = { response: { status: 409, data: { detail: "Access changed" } } };
    const { form, state, writeAccess, beforeCommit, enrolAccess } = await configured({
      readAccess: vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ username: "bob", revision: 5 })),
      writeAccess: vi.fn().mockRejectedValue(conflict),
    });
    if (edited) form.setField("username", "proposed-name");
    form.setField("password", "proposed-password"); form.setField("currentPassword", "current");
    await enrol(form); form.setField("totpCode", "123456"); await form.finish();
    expect(state.needsReview).toBe(true); expect(state.disabled.submit).toBe(true);
    await form.finish(); expect(beforeCommit).toHaveBeenCalledTimes(1);
    await form.review(); await nextTick();
    expect(state).toMatchObject({ username: edited ? "proposed-name" : "bob", password: "proposed-password", totpKey: bundle.key, totpCode: "123456", needsReview: false });
    expect(writeAccess).toHaveBeenCalledTimes(1); expect(enrolAccess).toHaveBeenCalledTimes(1);
  });

  it("delegates unknown outcomes to Access so dismissal/replay remain blocked", async () => {
    const { form, state, writeAccess } = await configured({ writeAccess: vi.fn().mockRejectedValue(Error("receipt lost")) });
    form.setField("currentPassword", "current"); await form.finish(); await flushPromises();
    expect(form.canDismiss()).toBe(false); expect(state.needsReview).toBe(true);
    expect(state.message).toContain("Access update outcome is unknown.");
    await form.finish(); expect(writeAccess).toHaveBeenCalledTimes(1);
  });

  it("binds real transport defaults in the factory, leaving the view transport-free", async () => {
    api.getAccessSettings.mockResolvedValue(view());
    api.putAccessSettings.mockResolvedValue({ view: view({ revision: 4 }), requiresLogin: true });
    const completed = vi.fn(); const form = createSetupFormState({ dismissible: () => true, completed }); controllers.push(form);
    await form.load(); form.setField("currentPassword", "current"); await form.finish();
    expect(api.getAccessSettings).toHaveBeenCalledTimes(1);
    expect(api.putAccessSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "password", currentPassword: "current" }));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ requiresLogin: true }));
  });
});
