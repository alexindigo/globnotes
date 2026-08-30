// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import Modal from "../components/Modal.vue";

describe("Modal Esc dismissal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("closes on Escape while visible", async () => {
    const wrapper = mount(Modal, {
      props: { modelValue: true, name: "test" },
      slots: { default: "<p>content</p>" },
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([false]);
  });

  it("does not close when hidden", async () => {
    const wrapper = mount(Modal, {
      props: { modelValue: false, name: "test" },
      slots: { default: "<p>content</p>" },
    });
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
