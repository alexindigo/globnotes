import { describe, expect, it } from "vitest";
import { collectProductionRows } from "./generic-platform-evidence.mjs";

describe("production acceptance rejects incomplete consumer evidence", () => {
  it("never treats an empty successful diagnostics marker as the full Settings matrix", async () => {
    await expect(collectProductionRows(async () => ({ outcomes: [] }))).rejects.toThrow("Full native Settings matrix incomplete");
  });
  it("never treats startup-only successes as actual action consumers", async () => {
    const read = async path => path === "settings/diagnostics.json" ? { outcomes: Array.from({ length: 16 }, () => ({ passed: true })) } : [];
    await expect(collectProductionRows(read)).rejects.toThrow("Missing consumer");
  });
});
