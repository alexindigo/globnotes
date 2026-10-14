// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import SetupModal from "../components/SetupModal.vue";
import { getAccessSettings, postSetup, postTotpEnrolment, putAccessSettings, resetSetup } from "../api.js";

vi.mock("../api.js", () => ({
  postSetup: vi.fn(),
  postTotpEnrolment: vi.fn(),
  resetSetup: vi.fn(),
  getAccessSettings: vi.fn(async () => ({ mode: "password", username: "alice", totpEnabled: false, settingsWritable: true, revision: 0, signature: "initial", pinned: {} })),
  putAccessSettings: vi.fn(async () => ({ view: { mode: "password", username: "alice", settingsWritable: true, revision: 1, pinned: {} }, requiresLogin: true })),
  postAccessTotpEnrolment: vi.fn(), getConfig: vi.fn(),
}));

function mountModal() {
  return mount(SetupModal, {
    attachTo: document.body,
  });
}

function radio(wrapper, value) {
  return wrapper.find(`input[name="access-mode"][value="${value}"]`);
}

async function selectMode(wrapper, value) {
  await radio(wrapper, value).setValue(true);
  await nextTick();
}

const bundle = {
  key: "rawkey",
  secret: "BASE32SECRET",
  uri: "otpauth://totp/globnotes:alice?secret=BASE32SECRET",
  qr: "data:image/png;base64,xxxx",
};
const writeClipboard = vi.fn();

async function enableTotp(wrapper) {
  postTotpEnrolment.mockResolvedValue(bundle);
  await wrapper.find("#setup-totp").trigger("click");
  await flushPromises();
}

describe("SetupModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeClipboard.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeClipboard },
    });
    document.body.innerHTML = "";
  });

  it("renders three access choices with password preselected and empty fields", () => {
    const wrapper = mountModal();
    expect(radio(wrapper, "password").element.checked).toBe(true);
    expect(radio(wrapper, "read_only").element.checked).toBe(false);
    expect(radio(wrapper, "none").element.checked).toBe(false);
    expect(wrapper.find("#setup-username").element.value).toBe("");
    expect(wrapper.find("#setup-password").element.value).toBe("");
    expect(wrapper.text()).toContain("Finish setup");
  });

  it("shows the credentials panel for password and hides the others", () => {
    const wrapper = mountModal();
    const username = wrapper.find("#setup-username");
    expect(username.exists()).toBe(true);
    expect(username.element.disabled).toBe(false);
    // Hidden panels' inputs are disabled (excluded from validation/focus).
    expect(wrapper.find("#setup-ack").element.disabled).toBe(true);
  });

  it("keeps typed credentials in memory while switching modes", async () => {
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await selectMode(wrapper, "read_only");
    await selectMode(wrapper, "password");
    expect(wrapper.find("#setup-username").element.value).toBe("alice");
    expect(wrapper.find("#setup-password").element.value).toBe("secret");
  });

  it("re-masks the password when returning to password mode", async () => {
    const wrapper = mountModal();
    await wrapper.find("#setup-password").setValue("secret");
    const toggle = wrapper.findAll("button").find((b) =>
      b.attributes("aria-label") === "Show password"
    );
    await toggle.trigger("click");
    expect(wrapper.find("#setup-password").attributes("type")).toBe("text");
    await selectMode(wrapper, "none");
    await selectMode(wrapper, "password");
    expect(wrapper.find("#setup-password").attributes("type")).toBe(
      "password",
    );
  });

  it("blocks finish with missing credentials, marks fields, focuses the first missing", async () => {
    const wrapper = mountModal();
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(postSetup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Enter a username and password.");
    expect(wrapper.find("#setup-username").attributes("aria-invalid")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(
      wrapper.find("#setup-username").element,
    );
  });

  it("focuses the password field when only the password is missing", async () => {
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(postSetup).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      wrapper.find("#setup-password").element,
    );
  });

  it("submits the password payload", async () => {
    postSetup.mockResolvedValue({});
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).toHaveBeenCalledWith({
      mode: "password",
      username: "alice",
      password: "secret",
    });
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("submits read_only and none payloads without credentials", async () => {
    postSetup.mockResolvedValue({});
    const wrapper = mountModal();
    await selectMode(wrapper, "read_only");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).toHaveBeenCalledWith({ mode: "read_only" });

    const wrapper2 = mountModal();
    await selectMode(wrapper2, "none");
    await wrapper2.find("#setup-ack").setValue(true);
    await wrapper2.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).toHaveBeenCalledWith({ mode: "none", readOnlySettings: false });
  });

  it("disables finish in open access until the acknowledgement is checked", async () => {
    const wrapper = mountModal();
    const finish = () => wrapper.find("button[type=submit]");
    expect(finish().element.disabled).toBe(false);
    await selectMode(wrapper, "none");
    expect(finish().element.disabled).toBe(true);
    await wrapper.find("#setup-ack").setValue(true);
    expect(finish().element.disabled).toBe(false);
    // Switching away and back resets the acknowledgement — disabled again.
    await selectMode(wrapper, "password");
    await selectMode(wrapper, "none");
    expect(finish().element.disabled).toBe(true);
  });

  it("blocks open access without acknowledgement and focuses the checkbox", async () => {
    const wrapper = mountModal();
    await selectMode(wrapper, "none");
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(postSetup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(
      "Confirm that you understand open access.",
    );
    expect(document.activeElement).toBe(
      wrapper.find("#setup-ack").element,
    );
  });

  it("resets the acknowledgement when switching away and back", async () => {
    const wrapper = mountModal();
    await selectMode(wrapper, "none");
    await wrapper.find("#setup-ack").setValue(true);
    await selectMode(wrapper, "read_only");
    await selectMode(wrapper, "none");
    expect(wrapper.find("#setup-ack").element.checked).toBe(false);
  });

  it("preserves the acknowledgement across a failed submission", async () => {
    postSetup.mockRejectedValue(new Error("boom"));
    const wrapper = mountModal();
    await selectMode(wrapper, "none");
    await wrapper.find("#setup-ack").setValue(true);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find("#setup-ack").element.checked).toBe(true);
    expect(wrapper.text()).toContain("Setup failed. Please try again.");
  });

  it("disables inputs and guards duplicate requests while pending", async () => {
    let resolve;
    postSetup.mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(wrapper.text()).toContain("Setting up…");
    expect(wrapper.find("#setup-username").element.disabled).toBe(true);
    expect(wrapper.find("button[type=submit]").element.disabled).toBe(true);
    await wrapper.find("form").trigger("submit");
    expect(postSetup).toHaveBeenCalledTimes(1);
    resolve({});
    await flushPromises();
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("restores interaction and keeps values after rejection", async () => {
    postSetup.mockRejectedValue(new Error("boom"));
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Setup failed. Please try again.");
    expect(wrapper.find("#setup-username").element.value).toBe("alice");
    expect(wrapper.find("#setup-username").element.disabled).toBe(false);
    expect(wrapper.emitted("completed")).toBeUndefined();
  });

  it("emits completed exactly once on success", async () => {
    postSetup.mockResolvedValue({});
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("first-run mode is non-dismissible (no X, backdrop is a no-op)", async () => {
    const wrapper = mountModal();
    expect(wrapper.find('button[aria-label="Dismiss setup"]').exists()).toBe(
      false,
    );
    await wrapper.find(".bg-slate-950\\/40").trigger("click");
    expect(wrapper.emitted("dismiss")).toBeUndefined();
  });

  it("dismissible mode shows an X and emits dismiss on X, backdrop, Esc", async () => {
    const wrapper = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    await wrapper.find('button[aria-label="Dismiss setup"]').trigger("click");
    expect(wrapper.emitted("dismiss")).toHaveLength(1);

    const wrapper2 = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    await wrapper2.find(".bg-slate-950\\/40").trigger("click");
    expect(wrapper2.emitted("dismiss")).toHaveLength(1);

    const wrapper3 = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper3.emitted("dismiss")).toHaveLength(1);
  });

  it("configured finish confirms current credentials and updates access without reset or first-run creation", async () => {
    const wrapper = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    await flushPromises();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("#access-current-password").setValue("old-secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(resetSetup).not.toHaveBeenCalled();
    expect(postSetup).not.toHaveBeenCalled();
    expect(putAccessSettings).toHaveBeenCalledWith(expect.objectContaining({
      mode: "password",
      password: "secret",
      currentPassword: "old-secret", totpEnabled: false, revision: 0, signature: "initial",
    }));
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("first-run finish does not call resetSetup", async () => {
    postSetup.mockResolvedValue({});
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(resetSetup).not.toHaveBeenCalled();
  });

  it("environment-pinned access rejects in place and retains the proposed values", async () => {
    putAccessSettings.mockRejectedValueOnce({ response: { status: 409, data: { detail: "Access mode is pinned by environment configuration." } } });
    const wrapper = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    await flushPromises();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("#access-current-password").setValue("old-secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).not.toHaveBeenCalled();
    expect(resetSetup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(
      "Access mode is pinned by environment configuration.",
    );
  });

  it("the real switch mints a bundle and shows the QR and code, not the key", async () => {
    postTotpEnrolment.mockResolvedValue({
      key: "rawkey",
      secret: "BASE32SECRET",
      uri: "otpauth://totp/globnotes:alice?secret=BASE32SECRET",
      qr: "data:image/png;base64,xxxx",
    });
    const wrapper = mountModal();
    expect(wrapper.find("#setup-totp-code").exists()).toBe(false);
    await wrapper.find("#setup-username").setValue("alice");
    const toggle = wrapper.find("#setup-totp");
    expect(toggle.element.tagName).toBe("BUTTON");
    expect(toggle.attributes("type")).toBe("button");
    expect(toggle.attributes("role")).toBe("switch");
    expect(toggle.attributes("aria-checked")).toBe("false");
    await toggle.trigger("click");
    await flushPromises();
    expect(postTotpEnrolment).toHaveBeenCalledWith("alice");
    expect(wrapper.find('img[alt="TOTP enrolment QR code"]').attributes("src"))
      .toBe("data:image/png;base64,xxxx");
    expect(toggle.attributes("aria-checked")).toBe("true");
    expect(wrapper.text()).not.toContain("BASE32SECRET");
    expect(wrapper.find("#setup-totp-qr").attributes("type")).toBe("button");
    expect(wrapper.find("#setup-totp-code").element.disabled).toBe(false);
    expect(postSetup).not.toHaveBeenCalled();
  });

  it("a failed enrolment rolls the toggle back off with feedback", async () => {
    postTotpEnrolment.mockRejectedValue(new Error("boom"));
    const wrapper = mountModal();
    await wrapper.find("#setup-totp").trigger("click");
    await flushPromises();
    expect(wrapper.find("#setup-totp").attributes("aria-checked")).toBe(
      "false",
    );
    expect(wrapper.text()).toContain(
      "Could not start TOTP enrolment. Please try again.",
    );
  });

  it("blocks finish until a 6-digit code is entered", async () => {
    postTotpEnrolment.mockResolvedValue({
      key: "rawkey",
      secret: "BASE32SECRET",
      uri: "otpauth://x",
      qr: "data:image/png;base64,xxxx",
    });
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("#setup-totp").trigger("click");
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(postSetup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(
      "Enter the current 6-digit code from your authenticator.",
    );
    expect(wrapper.find("#setup-totp-code").attributes("aria-invalid")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(
      wrapper.find("#setup-totp-code").element,
    );
  });

  it("submits the TOTP payload with the minted key and entered code", async () => {
    postTotpEnrolment.mockResolvedValue({
      key: "rawkey",
      secret: "BASE32SECRET",
      uri: "otpauth://x",
      qr: "data:image/png;base64,xxxx",
    });
    postSetup.mockResolvedValue({});
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("#setup-totp").trigger("click");
    await flushPromises();
    await wrapper.find("#setup-totp-code").setValue("123456");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).toHaveBeenCalledWith({
      mode: "password",
      username: "alice",
      password: "secret",
      totpKey: "rawkey",
      totpCode: "123456",
    });
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("a 400 shows the server's reason and clears the code for a retry", async () => {
    postTotpEnrolment.mockResolvedValue({
      key: "rawkey",
      secret: "BASE32SECRET",
      uri: "otpauth://x",
      qr: "data:image/png;base64,xxxx",
    });
    postSetup.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: "That code doesn't match this key." },
      },
    });
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("#setup-totp").trigger("click");
    await flushPromises();
    await wrapper.find("#setup-totp-code").setValue("123456");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("That code doesn't match this key.");
    expect(wrapper.find("#setup-totp-code").element.value).toBe("");
    expect(wrapper.emitted("completed")).toBeUndefined();
  });

  it("confirms the first QR click, copies the setup key on the second, then resets", async () => {
    const wrapper = mountModal();
    await enableTotp(wrapper);
    const qr = wrapper.find("#setup-totp-qr");
    await qr.trigger("click");
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(wrapper.find("[role=tooltip]").text()).toBe(
      "Click again to copy the setup key.",
    );
    await qr.trigger("click");
    await flushPromises();
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith("BASE32SECRET");
    expect(wrapper.find("[role=tooltip]").text()).toBe("Setup key copied.");
    await qr.trigger("click");
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(wrapper.find("[role=tooltip]").text()).toContain("Click again");
    expect(postSetup).not.toHaveBeenCalled();
  });

  it("shows a copy failure honestly and requires confirmation again", async () => {
    writeClipboard.mockRejectedValue(new Error("clipboard denied"));
    const wrapper = mountModal();
    await enableTotp(wrapper);
    const qr = wrapper.find("#setup-totp-qr");
    await qr.trigger("click");
    await qr.trigger("click");
    await flushPromises();
    expect(wrapper.find("[role=tooltip]").text()).toContain("Could not copy");
    expect(wrapper.text()).not.toContain("Setup key copied");
    await qr.trigger("click");
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(wrapper.find("[role=tooltip]").text()).toContain("Click again");
  });

  it("guards additional activations while the clipboard write is pending", async () => {
    let release;
    writeClipboard.mockImplementation(() => new Promise((r) => (release = r)));
    const wrapper = mountModal();
    await enableTotp(wrapper);
    const qr = wrapper.find("#setup-totp-qr");
    await qr.trigger("click");
    await qr.trigger("click");
    expect(qr.element.disabled).toBe(true);
    await qr.trigger("click");
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    release();
    await flushPromises();
    expect(qr.element.disabled).toBe(false);
    expect(wrapper.find("[role=tooltip]").text()).toBe("Setup key copied.");
  });

  it("clears copy confirmation on blur, mode change, and a new enrolment", async () => {
    const wrapper = mountModal();
    await enableTotp(wrapper);
    await wrapper.find("#setup-totp-qr").trigger("click");
    await wrapper.find("#setup-totp-qr").trigger("blur");
    expect(wrapper.find("[role=tooltip]").exists()).toBe(false);
    await wrapper.find("#setup-totp-qr").trigger("click");
    expect(writeClipboard).not.toHaveBeenCalled();
    await selectMode(wrapper, "read_only");
    expect(wrapper.find("#setup-totp").element.disabled).toBe(true);
    await selectMode(wrapper, "password");
    expect(wrapper.find("[role=tooltip]").exists()).toBe(false);
    await wrapper.find("#setup-totp").trigger("click");
    await enableTotp(wrapper);
    await wrapper.find("#setup-totp-qr").trigger("click");
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(wrapper.find("[role=tooltip]").text()).toContain("Click again");
  });

  it("clears copy feedback when focus leaves a disabled QR control without blur", async () => {
    writeClipboard.mockRejectedValue(new Error("clipboard denied"));
    const wrapper = mountModal();
    await enableTotp(wrapper);
    const qr = wrapper.find("#setup-totp-qr");
    await qr.trigger("click");
    await qr.trigger("click");
    await flushPromises();
    expect(wrapper.find("[role=tooltip]").text()).toContain("Could not copy");
    // Chromium can drop focus when the pending copy disables the QR. The
    // next control's focusin must settle the old caption without a QR blur.
    await wrapper.find("#setup-username").trigger("focusin");
    expect(wrapper.find("[role=tooltip]").exists()).toBe(false);
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])("a late clipboard %s cannot restore feedback after another control owns focus", async outcome => {
    let resolve, reject;
    writeClipboard.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const wrapper = mountModal();
    await enableTotp(wrapper);
    const qr = wrapper.find("#setup-totp-qr");
    await qr.trigger("click");
    await qr.trigger("click");
    expect(qr.element.disabled).toBe(true);
    await wrapper.find("#setup-username").trigger("focusin");
    if (outcome === "success") resolve(); else reject(new Error("clipboard denied"));
    await flushPromises();
    expect(wrapper.find("[role=tooltip]").exists()).toBe(false);
    expect(qr.element.disabled).toBe(false);
    await qr.trigger("click");
    expect(wrapper.find("[role=tooltip]").text()).toContain("Click again");
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])("the QR's automatic busy-disabling blur preserves its clipboard %s outcome", async outcome => {
    let resolve, reject;
    writeClipboard.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const wrapper = mountModal();
    await enableTotp(wrapper);
    const qr = wrapper.find("#setup-totp-qr");
    await qr.trigger("click");
    await qr.trigger("click");
    expect(qr.element.disabled).toBe(true);
    // Real Chromium emits this blur with no next focus owner as a consequence
    // of disabling the pending button, not of user departure from the flow.
    qr.element.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    await nextTick();
    if (outcome === "success") resolve(); else reject(new Error("clipboard denied"));
    await flushPromises();
    expect(wrapper.find("[role=tooltip]").text()).toContain(outcome === "success" ? "Setup key copied." : "Could not copy");
    await wrapper.find("#setup-username").trigger("focusin");
    expect(wrapper.find("[role=tooltip]").exists()).toBe(false);
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("disables QR and switch controls during setup without losing the bundle", async () => {
    let release;
    postSetup.mockImplementation(() => new Promise((r) => (release = r)));
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await enableTotp(wrapper);
    await wrapper.find("#setup-totp-code").setValue("123456");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find("#setup-totp").element.disabled).toBe(true);
    expect(wrapper.find("#setup-totp-qr").element.disabled).toBe(true);
    expect(wrapper.find("#setup-totp-code").element.disabled).toBe(true);
    release({});
    await flushPromises();
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });
});
