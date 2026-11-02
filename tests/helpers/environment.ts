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

export type { Environment };

/** An immutable environment holding exactly `values` (undefined = unset). */
export function testEnvironment(
  values: Record<string, string | undefined> = {},
): Environment {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) entries.set(key, value);
  }
  return Object.freeze({ get: (key: string) => entries.get(key) });
}
