// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import Modal from "../components/Modal.vue";

// Mounted modals register document keydown listeners — unmount between
// tests so a previous instance's trap/Esc handler can't leak into the next.
let mounted = [];
afterEach(() => {
  mounted.forEach((w) => w.unmount());
  mounted = [];
  document.body.innerHTML = "";
});
function track(wrapper) {
  mounted.push(wrapper);
  return wrapper;
}

describe("Modal Esc dismissal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("closes on Escape while visible", async () => {
    const wrapper = track(mount(Modal, {
      props: { modelValue: true, name: "test" },
      slots: { default: "<p>content</p>" },
    }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([false]);
  });

  it("does not close when hidden", async () => {
    const wrapper = track(mount(Modal, {
      props: { modelValue: false, name: "test" },
      slots: { default: "<p>content</p>" },
    }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("defers to closeHandlerOverride", async () => {
    const override = vi.fn();
    mount(Modal, {
      props: { modelValue: true, name: "test", closeHandlerOverride: override },
      slots: { default: "<p>content</p>" },
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(override).toHaveBeenCalled();
  });
});

describe("Modal opt-in dialog behavior", () => {
  it("exposes dialog semantics only when labelledby is set", () => {
    const plain = track(mount(Modal, {
      props: { modelValue: true, name: "test" },
      slots: { default: "<p>content</p>" },
    }));
    expect(plain.find("[role=dialog]").exists()).toBe(false);

    const labelled = track(mount(Modal, {
      props: { modelValue: true, name: "test", labelledby: "title-id" },
      slots: { default: "<p>content</p>" },
    }));
    const dialog = labelled.find("[role=dialog]");
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe("title-id");
  });

  it("keeps default anchors untouched and adds viewport-center on request", () => {
    const top = track(mount(Modal, {
      props: { modelValue: true, name: "test" },
      slots: { default: "<p>content</p>" },
    }));
    expect(top.html()).toContain("mt-[30vh]");

    const centered = track(mount(Modal, {
      props: { modelValue: true, name: "test", anchor: "viewport-center" },
      slots: { default: "<p>content</p>" },
    }));
    expect(centered.html()).toContain("w-[80dvw]");
    expect(centered.html()).toContain("h-[80dvh]");
    expect(centered.html()).not.toContain("mt-[30vh]");
  });

  it("traps Tab within the dialog only when trapFocus is on", async () => {
    const wrapper = track(mount(Modal, {
      props: { modelValue: true, name: "test", trapFocus: true },
      slots: {
        default:
          '<button id="first">one</button><button id="last">two</button>',
      },
      attachTo: document.body,
    }));
    const last = wrapper.find("#last").element;
    last.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
    );
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find("#first").element);

    const first = wrapper.find("#first").element;
    first.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        cancelable: true,
      }),
    );
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find("#last").element);
  });

  it("does not trap Tab by default", async () => {
    const wrapper = track(mount(Modal, {
      props: { modelValue: true, name: "test" },
      slots: { default: '<button id="only">one</button>' },
      attachTo: document.body,
    }));
    wrapper.find("#only").element.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
    );
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find("#only").element);
  });
});
