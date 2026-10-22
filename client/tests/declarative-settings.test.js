import { describe, expect, it } from "vitest";
import { visibleSettingsFields, settingsFieldGroups } from "../declarativeSettings.js";

const fields = [
  { key: "enabled", type: "toggle" },
  { key: "detail", visibleWhen: { field: "enabled", equals: true } },
  { key: "zero", visibleWhen: { field: "count", equals: 0 } },
  { key: "tail" },
];

describe("declarative settings descriptor policy", () => {
  it("uses strict persisted-value equality, including false and zero", () => {
    expect(visibleSettingsFields({ fields }, { enabled: true, count: 0 }).map(field => field.key)).toEqual(["enabled", "detail", "zero", "tail"]);
    expect(visibleSettingsFields({ fields }, { enabled: "true", count: "0" }).map(field => field.key)).toEqual(["enabled", "tail"]);
    const off = { key: "off", visibleWhen: { field: "enabled", equals: false } };
    expect(visibleSettingsFields({ fields: [off] }, { enabled: false })).toEqual([off]);
  });
  it("handles missing fields and absent condition values without coercion", () => {
    expect(settingsFieldGroups({}, {})).toEqual([]);
    expect(visibleSettingsFields({ fields }, {})).toEqual([fields[0], fields[3]]);
  });
  it("retains descriptor group order, field order and metadata and appends ungrouped fields", () => {
    const groups = [{ id: "details", label: "Details", description: "Help", fields: ["tail", "detail", "missing"] },
      { id: "general", fields: ["enabled"] }];
    const page = { fields, groups }, before = JSON.stringify(page);
    expect(settingsFieldGroups(page, { enabled: true, count: 0 })).toEqual([
      { ...groups[0], descriptionParagraphs: ["Help"], fields: [fields[3], fields[1]] },
      { ...groups[1], descriptionParagraphs: [], fields: [fields[0]] },
      { id: "ungrouped", fields: [fields[2]] },
    ]);
    expect(JSON.stringify(page)).toBe(before);
  });
  it("omits empty/hidden-only groups and does not render assigned hidden fields as ungrouped", () => {
    const page = { fields, groups: [{ id: "hidden", fields: ["detail", "zero"] }, { id: "empty", fields: [] }] };
    expect(settingsFieldGroups(page, { enabled: false })).toEqual([{ id: "ungrouped", fields: [fields[0], fields[3]] }]);
  });
  it("preserves repeated declared membership instead of silently rewriting a descriptor", () => {
    const page = { fields: [fields[0]], groups: [{ id: "a", fields: ["enabled", "enabled"] }, { id: "b", fields: ["enabled"] }] };
    expect(settingsFieldGroups(page, {})).toEqual([{ id: "a", descriptionParagraphs: [], fields: [fields[0], fields[0]] }, { id: "b", descriptionParagraphs: [], fields: [fields[0]] }]);
  });
  it("preserves warning tone and splits plain descriptions without mutating descriptors", () => {
    const group = { id: "risk", label: "Risk", tone: "warning", description: "First warning.\n\nSecond warning.\r\n \r\n<script>plain text</script>", fields: ["enabled"] };
    const before = JSON.stringify(group);
    const [view] = settingsFieldGroups({ fields, groups: [group] }, {});
    expect(view.tone).toBe("warning");
    expect(view.descriptionParagraphs).toEqual(["First warning.", "Second warning.", "<script>plain text</script>"]);
    expect(view.fields).toEqual([fields[0]]);
    expect(JSON.stringify(group)).toBe(before);
  });
});
