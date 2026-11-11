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

export type { Environment };
export interface FixtureEnvironment extends Environment {
  readonly values: Record<string, string>;
  readonly fixtureAuth?: StoredConfig;
  readonly fixtureStatePath?: string;
}

/** An immutable environment holding exactly `values` (undefined = unset). */
export function testEnvironment(
  values: Record<string, unknown> = {},
): FixtureEnvironment {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (key === "fixtureAuth" || key === "fixtureStatePath") continue;
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
    fixtureAuth: values.fixtureAuth as StoredConfig | undefined,
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
