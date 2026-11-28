import { describe, expect, it } from "vitest";
import { accessMenuConsumers, collectProductionRows, prefixStreamConsumers } from "./generic-platform-evidence.mjs";
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
    { name: "totp-in-place", passed: true },
    { name: "pinned-credentials", passed: true },
  ];
  const enrollment = { name: "totp-in-place", enrollmentCancelNoEffects: true, literalDirtyBufferRetained: true, savedNote: true, invalidEnrollmentRetainedAccountAndSession: true, confirmedTotp: true, revocation: true, confirmedLoginAccepted: true, pageErrors: [] };
  const credentials = { name: "pinned-credentials", declarationStatic: true, ordinarySiblingSaved: true, adminStillEffective: true, ownCredentialControlsEditable: true, invalidCurrentProofRetainedBytesAndSession: true, directUnconfirmedWriteRejected: true, sameEditor: true, pageErrors: [] };
  it("requires the actual v3 enrollment, Access and Own Account effects, not just passed leaf labels", () => {
    expect(accessMenuConsumers(accessOutcomes, enrollment, credentials)).toBe(true);
    for (const [subject, record] of [["enrollment", enrollment], ["credentials", credentials]]) {
      for (const [key, value] of Object.entries(record)) {
        const missing = { ...record, [key]: value === true ? false : key === "pageErrors" ? ["failed"] : "wrong-leaf" };
        expect(accessMenuConsumers(accessOutcomes, subject === "enrollment" ? missing : enrollment, subject === "credentials" ? missing : credentials)).toBe(false);
      }
    }
    expect(accessMenuConsumers(accessOutcomes.slice(1), enrollment, credentials)).toBe(false);
    expect(accessMenuConsumers([{ ...accessOutcomes[0], passed: false }, accessOutcomes[1]], enrollment, credentials)).toBe(false);
    expect(accessMenuConsumers([accessOutcomes[0], { name: "native pinned Access controls", passed: true }], enrollment, credentials)).toBe(false);
  });
  it("requires stream closure without private delivery, credential rejection and actual browser recovery", () => {
    const closed = { closed: true, closedAt: 101, text: "event: hello\ndata: {}\n\n" };
    const receipt = { expiry: 100, expiryStream: closed, securityTransitionStream: closed, expiryNoLaterPrivateEvent: true, transitionNoLaterPrivateEvent: true, expiredReconnectStatus: 401, oldCredentialStatuses: [401, 401, 401], bothNativeBrowserOwnersDisposed: true, freshNativeLogin: true };
    expect(prefixStreamConsumers(receipt)).toBe(true);
    for (const key of ["expiryNoLaterPrivateEvent", "transitionNoLaterPrivateEvent", "bothNativeBrowserOwnersDisposed", "freshNativeLogin"]) {
      expect(prefixStreamConsumers({ ...receipt, [key]: false })).toBe(false);
    }
    for (const key of ["expiryStream", "securityTransitionStream"]) {
      expect(prefixStreamConsumers({ ...receipt, [key]: { ...closed, closed: false } })).toBe(false);
      expect(prefixStreamConsumers({ ...receipt, [key]: { ...closed, text: closed.text + "event: invalidate\n\n" } })).toBe(false);
    }
    expect(prefixStreamConsumers({ ...receipt, expiry: 102 })).toBe(false);
    expect(prefixStreamConsumers({ ...receipt, expiredReconnectStatus: 200 })).toBe(false);
    expect(prefixStreamConsumers({ ...receipt, oldCredentialStatuses: [200, 401, 401] })).toBe(false);
  });
  it("never treats an empty successful diagnostics marker as the full Settings matrix", async () => {
    await expect(collectProductionRows(async () => ({ outcomes: [] }))).rejects.toThrow("Full native Settings matrix incomplete");
  });
  it("never treats startup-only successes as actual action consumers", async () => {
    const read = async path => path === "settings/diagnostics.json" ? { outcomes: Array.from({ length: 16 }, () => ({ passed: true })) } : [];
    await expect(collectProductionRows(read)).rejects.toThrow("Missing consumer");
  });
});
