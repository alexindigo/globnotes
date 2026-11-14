import { describe, expect, it } from "vitest";
import { assertSettingRowMeasurements } from "./settings-frame-native.mjs";

describe("short Settings row geometry", () => {
  const inline = { inline: true, delta: 0, inlineGap: 16, expectedColumnGap: 16, overflow: 0 };
  const reflow = { inline: false, endDelta: 0, rowGap: 8, expectedRowGap: 8, overflow: 0, delta: -30.5 };
  it("requires shared centerlines beside labels and structural next-line alignment after reflow", () => {
    expect(() => assertSettingRowMeasurements([inline, reflow])).not.toThrow();
  });
  it.each([
    { ...inline, delta: 8 },
    { ...inline, inlineGap: -4 },
    { ...reflow, endDelta: 8 },
    { ...reflow, rowGap: -4 },
    { ...reflow, rowGap: 24 },
    { ...reflow, overflow: 4 },
  ])("rejects misalignment, overlap, excess gaps and overflow: %j", measurement => {
    expect(() => assertSettingRowMeasurements([measurement])).toThrow("alignment/reflow");
  });
});
