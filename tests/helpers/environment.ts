// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Per-test configuration environments.
 *
 * `deno test --parallel` runs test modules as concurrent workers of ONE OS
 * process, so `Deno.env` is shared by every module running at the same time
 * and inherited by every child they spawn. Tests therefore never write the
 * process environment (tests/test_isolation_contract_test.ts enforces it):
 * in-process server objects receive an `Environment` built here, and child
 * processes get an explicit environment from tests/helpers/process.ts.
 */

import type { Environment } from "../../server/environment.ts";
import type { StoredConfig } from "../../server/config.ts";
import { serviceSettings } from "../../server/config/consumers.ts";
import { loadInstanceConfig } from "../../server/config/loader.ts";
import { BoundFileStore } from "../../server/config/file_store.ts";
import type { FixtureScenario } from "./fixture_scenarios.ts";
import type { IdentityFixturePayload } from "./identity_fixture.ts";

export type { Environment };
export interface FixtureEnvironment extends Environment {
  readonly values: Record<string, string>;
  readonly fixtureAuth?: StoredConfig;
  readonly fixtureScenario?: FixtureScenario;
  readonly fixtureIdentity?: IdentityFixturePayload | null;
  readonly fixtureStatePath?: string;
}

function fixtureSnapshot<T>(input: T): T {
  const captured = structuredClone(input);
  const seen = new WeakSet();
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(captured);
  return captured;
}

/** An immutable environment holding exactly `values` (undefined = unset). */
export function testEnvironment(
  values: Record<string, unknown> = {},
): FixtureEnvironment {
  values = { ...values };
  const suppliedScenario = values.fixtureScenario;
  const scenario = suppliedScenario === undefined
    ? undefined
    : fixtureSnapshot(suppliedScenario as FixtureScenario);
  if (scenario && values.fixtureAuth !== undefined) {
    throw new TypeError(
      "Use one fixture scenario, not a second auth override.",
    );
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (
      key === "fixtureAuth" || key === "fixtureStatePath" ||
      key === "fixtureScenario"
    ) continue;
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new Error(`Fixture env ${key} must be text`);
      }
      entries.set(key, value);
    }
  }
  return Object.freeze({
    get: (key: string) => entries.get(key),
    values: Object.freeze(Object.fromEntries(entries)),
    // The only active serializer remains legacy until I14c4. Account inputs
    // remain beside it, not written into an otherwise legacy server root.
    fixtureAuth: scenario
      ? scenario.legacyAuth
      : fixtureSnapshot(values.fixtureAuth as StoredConfig | undefined),
    fixtureScenario: scenario,
    fixtureIdentity: scenario?.identity,
    fixtureStatePath: values.fixtureStatePath as string | undefined,
  });
}
export function testServices(env: FixtureEnvironment = testEnvironment()) {
  return serviceSettings(
    loadInstanceConfig({
      env: env.values,
      overlayPath: null,
      vaults: {
        globnotes: {
          path: env.values.GLOBNOTES_GLOBNOTES_PATH || "/",
          overlayPath: null,
        },
      },
    }).config,
  );
}
export function testMetadata(directory: string): string {
  const owner = new BoundFileStore(`${directory}/config.toml`);
  owner.prepareParents();
  return directory;
}
