import { describe, expect, it } from "vitest";
import { accessMenuConsumers, collectProductionRows } from "./generic-platform-evidence.mjs";

describe("production acceptance rejects incomplete consumer evidence", () => {
  const accessOutcomes = [
    { name: "native enrolment cancellation/invalid-code/confirmed-login consumer", passed: true },
    { name: "native stored Access controls and fresh-proof errors retain account/editor authority", passed: true },
  ];
  const credentials = { retiredFieldsUnpinned: true, invalidCurrentProofRetainedConfigAndSession: true, directUnconfirmedWriteRejected: true, sameEditor: true, pageErrors: [] };
  it("requires current stored-credential/fresh-proof effects rather than the retired pin label", () => {
    expect(accessMenuConsumers(accessOutcomes, credentials)).toBe(true);
    for (const key of ["retiredFieldsUnpinned", "invalidCurrentProofRetainedConfigAndSession", "directUnconfirmedWriteRejected", "sameEditor"]) {
      expect(accessMenuConsumers(accessOutcomes, { ...credentials, [key]: false })).toBe(false);
    }
    expect(accessMenuConsumers(accessOutcomes, { ...credentials, pageErrors: ["failed"] })).toBe(false);
    expect(accessMenuConsumers(accessOutcomes.slice(1), credentials)).toBe(false);
    expect(accessMenuConsumers([{ ...accessOutcomes[0], passed: false }, accessOutcomes[1]], credentials)).toBe(false);
    expect(accessMenuConsumers([accessOutcomes[0], { name: "native pinned Access controls", passed: true }], credentials)).toBe(false);
  });
  it("never treats an empty successful diagnostics marker as the full Settings matrix", async () => {
    await expect(collectProductionRows(async () => ({ outcomes: [] }))).rejects.toThrow("Full native Settings matrix incomplete");
  });
  it("never treats startup-only successes as actual action consumers", async () => {
    const read = async path => path === "settings/diagnostics.json" ? { outcomes: Array.from({ length: 16 }, () => ({ passed: true })) } : [];
    await expect(collectProductionRows(read)).rejects.toThrow("Missing consumer");
  });
});
