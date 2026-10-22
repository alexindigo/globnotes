// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createSettingsPageState } from "../settingsPageState.js";
import DeclarativeSettingsPage from "../components/DeclarativeSettingsPage.vue";

describe("warning settings groups at the page consumer", () => {
  it("carries tone through the snapshot, contains fields, escapes paragraphs and forwards intents", async () => {
    const descriptor = { fields: [
      { key: "enabled", label: "Enable writes", type: "toggle", default: false },
      { key: "interval", label: "Interval", type: "number", default: 30 },
    ], groups: [
      { id: "safety", label: "Before you turn this on", tone: "warning", description: "Writes replace earlier changes.\n\n<strong>Mistakes are saved too.</strong>", fields: ["enabled"] },
      { id: "timing", label: "Timing", description: "Choose when.\n\nUse a longer interval.", fields: ["interval"] },
    ] };
    const page = { id: "plugin:fixture:preferences", descriptor };
    const state = createSettingsPageState({ registry: {
      find: () => page, read: async () => ({ values: { enabled: false, interval: 30 }, revision: 0 }),
    } });
    await state.load(page.id);
    const snapshot = state.snapshot(page.id);
    expect(snapshot.fieldGroups[0].tone).toBe("warning");
    expect(snapshot.fieldGroups[1].tone).toBeUndefined();
    const wrapper = mount(DeclarativeSettingsPage, { props: { page, snapshot } });
    try {
      const sections = wrapper.findAll("section");
      const banner = sections[0], normal = sections[1];
      expect(banner.classes()).toContain("settings-section-warning");
      expect(normal.classes()).not.toContain("settings-section-warning");
      const heading = banner.get("h3");
      expect(heading.text()).toBe("Before you turn this on");
      expect(banner.attributes("aria-labelledby")).toBe(heading.attributes("id"));
      expect(banner.findAll(".settings-section-prose p").map(p => p.text())).toEqual([
        "Writes replace earlier changes.", "<strong>Mistakes are saved too.</strong>",
      ]);
      expect(normal.findAll(".settings-section-prose p").map(p => p.text())).toEqual(["Choose when.", "Use a longer interval."]);
      expect(banner.find("strong").exists()).toBe(false);
      expect(banner.find('[role="alert"]').exists()).toBe(false);
      expect(banner.find("#settings-field-enabled").exists()).toBe(true);
      expect(banner.find("#settings-field-interval").exists()).toBe(false);
      expect(normal.find("#settings-field-interval").exists()).toBe(true);
      await banner.get('[role="switch"]').trigger("click");
      expect(wrapper.emitted("edit")).toEqual([[{ key: "enabled", raw: true }]]);
      expect(wrapper.emitted("commit")).toEqual([["enabled"]]);
    } finally { wrapper.unmount(); state.dispose(); }
  });
});
