// SPDX-License-Identifier: LGPL-3.0-only
import type { StoredConfig } from "../../server/config.ts";
import type { AccessLevel, EverybodyLevel } from "../../server/auth/acl.ts";
import { createUuid } from "../../shared/uuid.ts";
import type { IdentityFixturePayload } from "./identity_fixture.ts";
import { fixturePasswordHash } from "./config.ts";

/** Test-only preparation seam. The current boot/config adapters serialize only
 * legacyAuth until the single production switch. identity is consumed by the
 * existing prepared account fixture, never translated into production policy. */
export interface FixtureScenario {
  identity: IdentityFixturePayload | null;
  legacyAuth?: StoredConfig;
}

const VAULT = "10000000-0000-4000-8000-000000000001";
export function accountScenario(
  identity: IdentityFixturePayload | null,
  legacyAuth?: StoredConfig,
): FixtureScenario {
  return structuredClone({ identity, legacyAuth });
}

/** Public access never means Admin. Alice is available separately for those
 * existing consumers whose settings writes currently use the old public mode. */
export function publicScenario(
  everybody: "edit" | "view" = "edit",
  legacyAuth: StoredConfig = {
    auth_type: everybody === "edit" ? "none" : "read_only",
  },
): FixtureScenario {
  return accountScenario({
    vaultId: VAULT,
    people: [{ login: "alice", password: "password" }],
    everybody,
    grants: { alice: "admin" },
  }, legacyAuth);
}

export function signedInScenario(
  input: IdentityFixturePayload["people"][number],
  options: { level?: AccessLevel; everybody?: EverybodyLevel } = {},
  legacySigning: Pick<StoredConfig, "secret_key"> = {},
): FixtureScenario {
  const person = structuredClone(input);
  const { secret_key = createUuid() } = legacySigning;
  if (typeof secret_key !== "string" || !secret_key.trim()) {
    throw new TypeError(
      "A named fixture requires a nonempty legacy signing key.",
    );
  }
  return accountScenario({
    vaultId: VAULT,
    people: [person],
    everybody: options.everybody ?? "none",
    grants: { [person.login]: options.level ?? "admin" },
  }, {
    ...legacyAccountFields(person, fixturePasswordHash(person.password)),
    secret_key,
  });
}

export function legacyAccountFields(
  person: IdentityFixturePayload["people"][number],
  passwordHash: string,
): StoredConfig {
  return {
    auth_type: person.totpKey ? "totp" : "password",
    username: person.login,
    password_hash: passwordHash,
    ...(person.totpKey ? { totp_key: person.totpKey } : {}),
    ...(person.totpKeyEncoding
      ? { totp_key_encoding: person.totpKeyEncoding }
      : {}),
  };
}

/** No account records are prepared for an actual first-install scenario. */
export function setupScenario(legacyAuth?: StoredConfig): FixtureScenario {
  return accountScenario(null, legacyAuth);
}

/** Keep a test's existing record bytes/absence authoritative on the old path.
 * Its account input is available without reseeding that record on each reopen. */
export function storedScenario(scenario: FixtureScenario): FixtureScenario {
  return accountScenario(scenario.identity);
}
