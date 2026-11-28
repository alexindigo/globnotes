// Test-owned metadata layout. State consumers receive the per-vault directory.
import { dirname, resolve } from "node:path";

// Scenario inputs are account/ACL data, not the active store representation.
// Public cases also have a named Admin for the account-backed fixture; public
// Edit/View never grants Admin. I14c4 supplies sign-in where a case needs Admin.
/** @param {{account?: import("../../../tests/helpers/identity_fixture.ts").IdentityFixturePayload["people"][number], everybody?: import("../../../server/auth/acl.ts").EverybodyLevel, settingsWritable?: boolean}} [input] */
export function nativeAccountScenario({ account, everybody = account ? "none" : "edit", settingsWritable } = {}) {
  const person = account === undefined ? { login: "native-admin", password: "native-admin-password" } : structuredClone(account);
  /** @type {import("../../../tests/helpers/identity_fixture.ts").IdentityFixturePayload} */
  const identity = { vaultId: "00000000-0000-4000-8000-000000000003", people: [person], everybody, grants: { [person.login]: "admin" } };
  return {
    identity,
    signIn: account !== undefined || everybody === "none",
    ...(settingsWritable === undefined ? {} : { settingsWritable }),
  };
}

/**
 * @param {ReturnType<typeof nativeAccountScenario>} scenario
 * @param {Record<string, unknown>} [extra]
 */
export async function nativeFixtureInput(scenario, _extra = {}) {
  const captured = structuredClone(scenario.identity);
  // Metadata-only callers (including the Vite lifetime tests) do not load the
  // Deno fixture graph. Capture input before the lazy import can yield.
  const { accountScenario } = await import("../../../tests/helpers/fixture_scenarios.ts");
  return { fixtureScenario: accountScenario(captured) };
}

export function metadataBase(vault, state) {
  if (resolve(state) === resolve(vault, ".globnotes")) return "";
  if (!state.endsWith("/globnotes")) throw Error("Fixture state must be <metadata base>/globnotes");
  return dirname(state);
}
export async function metadataDirectory(options) {
  const state = `${await Deno.makeTempDir(options)}/globnotes`;
  await Deno.mkdir(state);
  return state;
}
