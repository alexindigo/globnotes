import { describe, expect, it } from "vitest";
import { accessMenuConsumers, collectProductionRows } from "./generic-platform-evidence.mjs";
import { MATRIX_CASES, collectFixtureReports, retainFixtureReport } from "./native-fixture-cases.mjs";

describe("production acceptance rejects incomplete consumer evidence", () => {
  it("releases each shared report handoff only after retaining exact leaf bytes", async () => {
    const files = new Map(), source = "prefix/diagnostics.json";
    const storage = {
      read: async path => files.get(path),
      write: async (path, bytes, options) => {
        if (options.createNew && files.has(path)) throw Error("Already exists");
        files.set(path, bytes);
      },
      remove: async path => { files.delete(path); },
    };
    const projection = await collectFixtureReports("plugin-prefix-auth", async item => {
      await storage.write(source, JSON.stringify({ outcomes: [{ name: item.label, passed: true }] }), { createNew: true });
      return retainFixtureReport(source, `${item.label}-result.json`, storage);
    });
    expect(files.has(source)).toBe(false);
    expect(files.size).toBe(8);
    for (const leaf of projection.leafReports) expect(JSON.parse(files.get(leaf.report)).outcomes).toEqual([{ name: leaf.variant, passed: true }]);
    files.set(source, '{"outcomes":[]}');
    files.set("already-retained.json", "earlier evidence");
    await expect(retainFixtureReport(source, "already-retained.json", storage)).rejects.toThrow("Already exists");
    expect(files.get(source)).toBe('{"outcomes":[]}');
    expect(files.get("already-retained.json")).toBe("earlier evidence");
  });
  it("assembles the canonical full matrices with separate retained leaf provenance", async () => {
    for (const driver of ["settings-ui", "access-settings", "plugin-prefix-auth"]) {
      const seen = [];
      const projection = await collectFixtureReports(driver, async item => {
        seen.push(item.label);
        return { report: { outcomes: [{ name: item.label, passed: true }] }, retained: `${item.label}-result.json` };
      });
      expect(seen).toEqual(MATRIX_CASES[driver].map(item => item.label));
      expect(projection.outcomes.map(row => row.name)).toEqual(seen);
      expect(projection.leafReports).toEqual(seen.map(variant => ({ variant, report: `${variant}-result.json` })));
    }
  });
  it("rejects incomplete, failed and duplicate leaf projections", async () => {
    for (const report of [{ outcomes: [] }, { outcomes: [{ name: "a", passed: false }] }, { failure: "failed", outcomes: [{ name: "a", passed: true }] }]) {
      await expect(collectFixtureReports("settings-ui", async () => ({ report }))).rejects.toThrow("incomplete native fixture evidence");
    }
    await expect(collectFixtureReports("settings-ui", async () => ({ report: { outcomes: [{ name: "duplicate", passed: true }] } }))).rejects.toThrow("duplicate");
  });
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
