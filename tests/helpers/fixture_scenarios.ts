// SPDX-License-Identifier: LGPL-3.0-only
import type { AccessLevel, EverybodyLevel } from "../../server/auth/acl.ts";
import type { IdentityFixturePayload } from "./identity_fixture.ts";

type LegacyFixtureData = Record<string, unknown>;

/** Captured account fixture input. Legacy bytes, where needed as evidence, are
 * written explicitly by their owning upgrade tests, never by shared boot. */
export interface FixtureScenario {
  identity: IdentityFixturePayload | null;
}

const VAULT = "10000000-0000-4000-8000-000000000001";
export function accountScenario(
  identity: IdentityFixturePayload | null,
  _legacyAuth?: LegacyFixtureData,
): FixtureScenario {
  return structuredClone({ identity });
}

/** Public access never means Admin. Alice is available separately for those
 * existing consumers whose settings writes currently use the old public mode. */
export function publicScenario(
  everybody: "edit" | "view" = "edit",
  _legacyAuth?: LegacyFixtureData,
): FixtureScenario {
  return accountScenario({
    vaultId: VAULT,
    people: [{ login: "alice", password: "password" }],
    everybody,
    grants: { alice: "admin" },
  });
}

export function signedInScenario(
  input: IdentityFixturePayload["people"][number],
  options: { level?: AccessLevel; everybody?: EverybodyLevel } = {},
  _legacyAuth?: LegacyFixtureData,
): FixtureScenario {
  const person = structuredClone(input);
  return accountScenario({
    vaultId: VAULT,
    people: [person],
    everybody: options.everybody ?? "none",
    grants: { [person.login]: options.level ?? "admin" },
  });
}

/** No account records are prepared for an actual first-install scenario. */
export function setupScenario(
  _legacyAuth?: LegacyFixtureData,
): FixtureScenario {
  return accountScenario(null);
}

/** Keep a test's existing record bytes/absence authoritative on the old path.
 * Its account input is available without reseeding that record on each reopen. */
export function storedScenario(scenario: FixtureScenario): FixtureScenario {
  return accountScenario(scenario.identity);
}
