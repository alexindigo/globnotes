// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import CtaButton from "../components/CtaButton.vue";

describe("CtaButton", () => {
  it("renders the label with the fixed house style", () => {
    const wrapper = mount(CtaButton, {
      props: { label: "Save" },
    });
    const btn = wrapper.find("button");
    expect(btn.text()).toContain("Save");
    const cls = btn.classes();
    expect(cls).toContain("bg-theme-brand");
    expect(cls).toContain("text-white");
    expect(cls).toContain("w-full");
    expect(cls).toContain("font-semibold");
    // The polished outline (1.5px grey, outside paint) is part of the
    // house style — regressions here must fail loudly, not silently drop.
    expect(
      cls.some((c) => c.includes("webkit-text-stroke")),
    ).toBe(true);
    expect(cls).toContain("[paint-order:stroke_fill]");
  });

  it("invokes the callback on click", async () => {
    const callback = vi.fn();
    const wrapper = mount(CtaButton, {
      props: { label: "Go", callback },
    });
    await wrapper.find("button").trigger("click");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is a no-op click when no callback is given (form submit owns it)", async () => {
    const wrapper = mount(CtaButton, { props: { label: "Go" } });
    await wrapper.find("button").trigger("click");
    // Nothing to throw: the click simply falls through.
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
