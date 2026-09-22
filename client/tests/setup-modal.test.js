// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import SetupModal from "../components/SetupModal.vue";
import { postSetup, resetSetup } from "../api.js";

vi.mock("../api.js", () => ({
  postSetup: vi.fn(),
  resetSetup: vi.fn(),
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

describe("SetupModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(wrapper.find("input[type=checkbox]").element.disabled).toBe(true);
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
    expect(document.activeElement).toBe(wrapper.find("#setup-username").element);
  });

  it("focuses the password field when only the password is missing", async () => {
    const wrapper = mountModal();
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(postSetup).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(wrapper.find("#setup-password").element);
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
    await wrapper2.find("input[type=checkbox]").setValue(true);
    await wrapper2.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).toHaveBeenCalledWith({ mode: "none" });
  });

  it("disables finish in open access until the acknowledgement is checked", async () => {
    const wrapper = mountModal();
    const finish = () => wrapper.find("button[type=submit]");
    expect(finish().element.disabled).toBe(false);
    await selectMode(wrapper, "none");
    expect(finish().element.disabled).toBe(true);
    await wrapper.find("input[type=checkbox]").setValue(true);
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
      wrapper.find("input[type=checkbox]").element,
    );
  });

  it("resets the acknowledgement when switching away and back", async () => {
    const wrapper = mountModal();
    await selectMode(wrapper, "none");
    await wrapper.find("input[type=checkbox]").setValue(true);
    await selectMode(wrapper, "read_only");
    await selectMode(wrapper, "none");
    expect(wrapper.find("input[type=checkbox]").element.checked).toBe(false);
  });

  it("preserves the acknowledgement across a failed submission", async () => {
    postSetup.mockRejectedValue(new Error("boom"));
    const wrapper = mountModal();
    await selectMode(wrapper, "none");
    await wrapper.find("input[type=checkbox]").setValue(true);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find("input[type=checkbox]").element.checked).toBe(true);
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

  it("menu-invoked finish chains resetSetup before postSetup", async () => {
    resetSetup.mockResolvedValue({});
    postSetup.mockResolvedValue({});
    const wrapper = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(resetSetup).toHaveBeenCalledTimes(1);
    expect(postSetup).toHaveBeenCalledWith({
      mode: "password",
      username: "alice",
      password: "secret",
    });
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

  it("env-pinned reset shows a specific message and skips postSetup", async () => {
    resetSetup.mockRejectedValue({ response: { status: 409 } });
    const wrapper = mount(SetupModal, {
      props: { dismissible: true },
      attachTo: document.body,
    });
    await wrapper.find("#setup-username").setValue("alice");
    await wrapper.find("#setup-password").setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(postSetup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(
      "Access mode is pinned by environment configuration.",
    );
  });
});
