// SPDX-License-Identifier: LGPL-3.0-only
import {
  analyzeOwnership,
  type OwnershipRules,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./ownership_contract.ts";

export const RESOURCE_CORE = "shared/ownership.js";
export const RESOURCE_ENGINE = "shared/ownership-engine.js";
export const NATIVE_FINALIZER = "client/tests/e2e/native-case-finalization.mjs";

/** One explicit policy, passed to the shared root/import analyzer. */
export const RESOURCE_OWNERSHIP: OwnershipRules = {
  roots: PROCESS_OWNERSHIP.roots,
  modules: {
    ...PROCESS_OWNERSHIP.modules,
    [RESOURCE_ENGINE]: [RESOURCE_CORE],
  },
};

/** Platform-free engine: no runtime root is a public capability here.
 * Imports are checked independently against its graph dependency manifest.
 * This is another registration for the same analyzer, not a second source rule.
 */
export const RESOURCE_ENGINE_OWNERSHIP: OwnershipRules = {
  ...RESOURCE_OWNERSHIP,
  roots: Object.fromEntries([
    ...Object.keys(PROCESS_OWNERSHIP.roots),
    "document",
    "navigator",
    "fetch",
    "Worker",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
  ].map((root) => [root, { members: [] }])),
};

export const FIXTURE_SCOPE_ENGINE = "tests/helpers/fixture_scope_engine.ts";
export const PLUGIN_FIXTURE_ENGINE = "tests/helpers/plugin_fixture_engine.ts";
export const PLUGIN_OPERATIONS = "tests/helpers/plugin_operations_fixture.ts";
/** Private construction modules have public callback facades. Every import form
 * is checked at the resolved module, never by following the imported value. */
export const FIXTURE_OWNERSHIP: OwnershipRules = {
  ...RESOURCE_OWNERSHIP,
  modules: {
    ...RESOURCE_OWNERSHIP.modules,
    [FIXTURE_SCOPE_ENGINE]: [
      "tests/helpers/fixture_scope.ts",
      PLUGIN_FIXTURE_ENGINE,
      PLUGIN_OPERATIONS,
      "tests/fixture_scope_test.ts",
      "tests/helpers/hub_fixture.ts",
      "tests/helpers/plugin_lifecycle.ts",
      "tests/helpers/driver_inprocess.ts",
      "tests/helpers/auxiliary_fixture.ts",
    ],
    [PLUGIN_FIXTURE_ENGINE]: [
      "tests/helpers/plugin_fixture.ts",
      PLUGIN_OPERATIONS,
      "tests/helpers/plugin_lifecycle.ts",
      "tests/helpers/auxiliary_fixture.ts",
    ],
  },
};
export const FIXTURE_PILOT_FILES = [
  "tests/helpers/fixture_scope.ts",
  FIXTURE_SCOPE_ENGINE,
  "tests/helpers/plugin_fixture.ts",
  PLUGIN_FIXTURE_ENGINE,
  PLUGIN_OPERATIONS,
  "tests/plugin_write_bases_test.ts",
];
const fixtureScenarios = [
  "tests/fixture_scope_test.ts",
  "tests/plugin_fixture_cleanup_test.ts",
];
/** P03 scenario coordination enters through the owned, cancellation-aware port. */
export const FIXTURE_SCENARIO_OWNERSHIP: OwnershipRules = {
  ...FIXTURE_OWNERSHIP,
  roots: {
    ...FIXTURE_OWNERSHIP.roots,
    Promise: { members: ["all", "allSettled", "resolve", "reject"] },
  },
};
/** The closed pilot's acquisitions belong to its constructor modules. Other
 * repository families keep their existing P01 root policy until they migrate. */
export const FIXTURE_PILOT_OWNERSHIP: OwnershipRules = {
  ...FIXTURE_OWNERSHIP,
  roots: {
    ...FIXTURE_OWNERSHIP.roots,
    Deno: {
      ...PROCESS_OWNERSHIP.roots.Deno,
      ownedMembers: {
        ...PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
        makeTempDir: [PLUGIN_FIXTURE_ENGINE],
        makeTempDirSync: [],
        makeTempFile: [],
        makeTempFileSync: [],
      },
    },
  },
  modules: {
    ...FIXTURE_OWNERSHIP.modules,
    [RESOURCE_CORE]: [FIXTURE_SCOPE_ENGINE],
    "tests/helpers/plugin_manager.ts": [PLUGIN_OPERATIONS],
    "server/hub/hub.ts": [PLUGIN_OPERATIONS],
  },
};
export const PRODUCT_OWNERSHIP: OwnershipRules = {
  ...FIXTURE_OWNERSHIP,
  modules: {
    ...FIXTURE_OWNERSHIP.modules,
    "tests/helpers/fixture_scope.ts": [],
    "tests/helpers/plugin_fixture.ts": [],
    [PLUGIN_OPERATIONS]: [],
  },
};
/** Partition by explicit pilot identities, analyze every module exactly once.
 * This selects registrations, not allowed sites; every violation is inventoried. */
export function registeredOwnership(sources: SourceModule[]) {
  const pilot: SourceModule[] = [],
    scenarios: SourceModule[] = [],
    remaining: SourceModule[] = [],
    product: SourceModule[] = [];
  for (const source of sources) {
    (fixtureScenarios.includes(source.file)
      ? scenarios
      : FIXTURE_PILOT_FILES.includes(source.file)
      ? pilot
      : source.file.startsWith("tests/") ||
          source.file.startsWith("client/tests/")
      ? remaining
      : product).push(
        source,
      );
  }
  return [
    ...(remaining.length ? analyzeOwnership(remaining, FIXTURE_OWNERSHIP) : []),
    ...(scenarios.length
      ? analyzeOwnership(scenarios, FIXTURE_SCENARIO_OWNERSHIP)
      : []),
    ...(pilot.length ? analyzeOwnership(pilot, FIXTURE_PILOT_OWNERSHIP) : []),
    ...(product.length ? analyzeOwnership(product, PRODUCT_OWNERSHIP) : []),
  ];
}
