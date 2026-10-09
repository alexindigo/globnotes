// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import CtaButton from "../components/CtaButton.vue";

describe("CtaButton", () => {
  it("renders the supplied label", () => {
    const wrapper = mount(CtaButton, {
      props: { label: "Save" },
    });
    const btn = wrapper.find("button");
    expect(btn.text()).toContain("Save");
  });

  it("invokes the callback on click", async () => {
    const callback = vi.fn();
    const wrapper = mount(CtaButton, {
      props: { label: "Go", callback },
    });
    await wrapper.find("button").trigger("click");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("passes disabled through", () => {
    const wrapper = mount(CtaButton, {
      props: { label: "Go", disabled: true },
    });
    expect(wrapper.find("button").element.disabled).toBe(true);
  });

  it("falls attrs through to the button (type, aria)", () => {
    const wrapper = mount(CtaButton, {
      props: { label: "Go" },
      attrs: { type: "submit", "aria-busy": true },
    });
    const btn = wrapper.find("button");
    expect(btn.attributes("type")).toBe("submit");
    expect(btn.attributes("aria-busy")).toBe("true");
  });
});
