// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { GLOBNOTES_LIGHT, GLOBNOTES_DARK, THEMES, setTheme } from "../themes.js";
import PluginInventorySettingsPage from "../components/PluginInventorySettingsPage.vue";

function luminance(hex) {
  const linear = hex.match(/[\da-f]{2}/gi).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const rgb = hex => hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16)).join(" ");

describe("Settings warning theme contract", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {} }));
    document.documentElement.removeAttribute("style");
  });

  it("stamps the default warning through the real theme selection consumer", () => {
    setTheme("globnotes-light");
    expect(document.documentElement.style.getPropertyValue("--theme-warning")).toBe("146 64 14");
    setTheme("globnotes-dark");
    expect(document.documentElement.style.getPropertyValue("--theme-warning")).toBe("252 211 77");
  });

  it.each(THEMES.filter(theme => theme.mode))("$id inherits a contrast-qualified warning on both surfaces", theme => {
    const colors = { ...(theme.mode === "dark" ? GLOBNOTES_DARK : GLOBNOTES_LIGHT), ...theme.colors };
    expect(colors.warning, "theme-owned warning").toMatch(/^#[\da-f]{6}$/i);
    setTheme(theme.id);
    expect(document.documentElement.style.getPropertyValue("--theme-warning")).toBe(rgb(colors.warning));
    for (const surface of ["background", "background-elevated"]) {
      expect(contrast(colors.warning, colors[surface]), `${theme.id}/${surface} warning text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.warning, colors[surface]), `${theme.id}/${surface} warning border`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps blocking text and trusted-browser disclosure at their actual inventory consumers", () => {
    const wrapper = mount(PluginInventorySettingsPage, { props: {
      plugins: [{ id: "warning-fixture", name: "Warning fixture", enabled: true, runsInBrowser: true, browserComponents: ["runtime"], blocking: { actions: ["save"], active: true } }],
      onAutoEnable: vi.fn(), onEnabled: vi.fn(), onReview: vi.fn(),
    } });
    expect(wrapper.find(".text-theme-warning").text()).toContain("Can block actions: save");
    const badge = wrapper.find("[data-plugin-browser-badge]");
    expect(badge.text()).toBe("Runs in browser");
    expect(badge.classes()).toContain("border-theme-warning");
    expect(badge.classes()).toContain("text-theme-text");
    wrapper.unmount();
  });
});
