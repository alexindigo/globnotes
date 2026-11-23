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

// Temporary test-only serialization. Production stays on its existing path
// until I14c4 switches startup, routes, client and fixture serialization together.
const scenarioFields = new Set(["auth_type", "read_only_settings", "username", "password_hash", "totp_key", "totp_key_encoding", "secret_key"]);
/**
 * @param {ReturnType<typeof nativeAccountScenario>} scenario
 * @param {Record<string, unknown>} [metadata]
 * @param {{ signingKey?: string }} [options]
 */
export async function nativeFixtureInput(scenario, metadata = {}, { signingKey } = {}) {
  const captured = structuredClone(scenario), saved = structuredClone(metadata);
  for (const key of Object.keys(saved)) {
    if (scenarioFields.has(key)) throw new TypeError(`Fixture metadata cannot replace ${key}.`);
  }
  if (signingKey !== undefined && (!captured.signIn || typeof signingKey !== "string" || !signingKey.trim())) {
    throw new TypeError("A legacy signing key override requires a signed-in scenario and a nonempty key.");
  }
  // Metadata-only callers (including the Vite lifetime tests) do not load the
  // Deno fixture graph. Capture the input before either lazy import can yield.
  const { accountScenario, legacyAccountFields } = await import("../../../tests/helpers/fixture_scenarios.ts");
  const person = captured.identity.people[0];
  const passwordHash = captured.signIn ? await (await import("../../../server/helpers.ts")).hashPassword(person.password) : undefined;
  const legacyAuth = {
    ...saved,
    ...(captured.signIn ? { ...legacyAccountFields(person, passwordHash), secret_key: signingKey ?? crypto.randomUUID() }
      : { auth_type: captured.identity.everybody === "view" ? "read_only" : "none" }),
    ...(captured.settingsWritable === undefined ? {} : { read_only_settings: !captured.settingsWritable }),
  };
  return { fixtureScenario: accountScenario(captured.identity, legacyAuth) };
}

/** Compatibility bridge for feature launchers that still own their child. */
export async function publishNativeLegacyAuth(vault, state, cwd, fixture) {
  const { fixtureScope } = await import("./fixture-ownership.mjs");
  const { fixtureLayout } = await import("../../../tests/helpers/fixture_layout.ts");
  const { publishLegacyFixtureAuth } = await import("../../../tests/helpers/boot.ts");
  await fixtureScope(async scope => {
    const layout = await fixtureLayout(scope, {
      GLOBNOTES_GLOBNOTES_PATH: vault, GLOBNOTES__METADATA_PATH: metadataBase(resolve(vault), resolve(state)),
    }, { cwd });
    await publishLegacyFixtureAuth(layout, scope, fixture);
  });
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
