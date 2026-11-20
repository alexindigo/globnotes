// SPDX-License-Identifier: LGPL-3.0-only
import {
  analyzeOwnership,
  type OwnershipRules,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./ownership_contract.ts";
import { coordinationRules } from "./owned_operation_contract.ts";

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
      "tests/helpers/sync_status_preload.ts",
      "tests/helpers/owned_record_channel.ts",
      "tests/owned_record_channel_test.ts",
      "tests/helpers/boot.ts",
    ],
    [PLUGIN_FIXTURE_ENGINE]: [
      "tests/helpers/plugin_fixture.ts",
      PLUGIN_OPERATIONS,
      "tests/helpers/plugin_lifecycle.ts",
      "tests/helpers/auxiliary_fixture.ts",
      "tests/helpers/owned_record_channel.ts",
      "tests/owned_record_channel_test.ts",
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

export const RECORD_CHANNEL = "tests/helpers/owned_record_channel.ts";
export const RECORD_PUBLICATION = "tests/helpers/record_publication.ts";
export const SYNC_CONTROL = "tests/helpers/sync_status_control.ts";
export const SYNC_NATIVE = "client/tests/e2e/sync-status-native.mjs";
export const SYNC_PRELOAD = "tests/helpers/sync_status_preload.ts";
export const RECORD_MODULE_RULES = {
  "node:fs": [],
  "node:fs/promises": [],
  "jsr:@std/fs@^1.0.20": [],
  "jsr:/@std/fs@^1.0.20/copy": [],
  [RECORD_CHANNEL]: [
    SYNC_CONTROL,
    "tests/helpers/record_schema.ts",
    "tests/owned_record_channel_test.ts",
  ],
  "tests/helpers/process_records.ts": [
    RECORD_CHANNEL,
    "tests/owned_record_channel_test.ts",
    "tests/process_records_test.ts",
  ],
  [RECORD_PUBLICATION]: ["tests/helpers/process_records.ts"],
};
export const RECORD_OWNERSHIP: OwnershipRules = {
  ...FIXTURE_OWNERSHIP,
  modules: { ...FIXTURE_OWNERSHIP.modules, ...RECORD_MODULE_RULES },
};
export const RECORD_PILOT_FILES = [SYNC_NATIVE, SYNC_PRELOAD, SYNC_CONTROL];
export const RECORD_PILOT_OWNERSHIP: OwnershipRules = {
  ...RECORD_OWNERSHIP,
  roots: {
    ...PROCESS_OWNERSHIP.roots,
    Deno: {
      // Only environment/error APIs and the pilot's existing fixture-directory
      // construction are public. Record IO, including unlisted future members,
      // fails closed; the finite artifact/input inventory remains unchanged.
      members: ["env", "errors", "makeTempDir", "mkdir"],
      ownedMembers: PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
    },
  },
  modules: {
    ...RECORD_OWNERSHIP.modules,
    "node:fs": [],
    "node:fs/promises": [],
    "@std/fs": [],
  },
};
export const RECORD_ENGINE_OWNERSHIP: OwnershipRules = {
  ...RECORD_OWNERSHIP,
  roots: {
    ...PROCESS_OWNERSHIP.roots,
    Deno: {
      ...PROCESS_OWNERSHIP.roots.Deno,
      ownedMembers: {
        ...PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
        watchFs: [],
      },
    },
    Promise: { members: ["resolve", "reject", "allSettled"] },
    setTimeout: { members: [] },
    setInterval: { members: [] },
    globalThis: {
      ...PROCESS_OWNERSHIP.roots.globalThis,
      ownedMembers: { setTimeout: [], setInterval: [] },
    },
  },
};
export const OWNED_CHILD = "tests/helpers/owned_child.ts";
export const BOOT_OWNER = "tests/helpers/boot.ts";
export const RAW_PROCESS = "tests/helpers/process.ts";
export const CHILD_MODULE_RULES = {
  [RAW_PROCESS]: [
    OWNED_CHILD,
    "tests/helpers/process_values.ts",
    "tests/helpers/ownership_contract.ts",
  ],
};
export const CHILD_OWNERSHIP: OwnershipRules = {
  ...RECORD_OWNERSHIP,
  roots: {
    ...RECORD_OWNERSHIP.roots,
    Deno: {
      ...RECORD_OWNERSHIP.roots.Deno,
      ownedMembers: {
        ...RECORD_OWNERSHIP.roots.Deno.ownedMembers,
        ChildProcess: ["tests/owned_child_test.ts"],
      },
    },
  },
  modules: { ...RECORD_OWNERSHIP.modules, ...CHILD_MODULE_RULES },
};
export const BOOT_OWNERSHIP: OwnershipRules = {
  ...CHILD_OWNERSHIP,
  roots: {
    ...PROCESS_OWNERSHIP.roots,
    Deno: {
      members: [
        "errors",
        "makeTempDir",
        "mkdir",
        "readTextFile",
        "realPathSync",
        "remove",
        "removeSync",
      ],
      ownedMembers: PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
    },
    setTimeout: { members: [] },
    setInterval: { members: [] },
    globalThis: {
      ...PROCESS_OWNERSHIP.roots.globalThis,
      ownedMembers: { setTimeout: [], setInterval: [] },
    },
  },
};
export const OPERATION_ADAPTER = "tests/helpers/owned_operation.ts";
export const OPERATION_PILOT = "tests/plugin_settings_schema_lease_test.ts";
export const OPERATION_ADAPTER_OWNERSHIP: OwnershipRules = {
  ...CHILD_OWNERSHIP,
  roots: {
    ...CHILD_OWNERSHIP.roots,
    Deno: {
      members: [],
      ownedMembers: PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
    },
  },
};
export const OPERATION_PILOT_OWNERSHIP: OwnershipRules = {
  ...OPERATION_ADAPTER_OWNERSHIP,
  roots: {
    ...OPERATION_ADAPTER_OWNERSHIP.roots,
    Deno: {
      members: ["test", "readTextFile", "writeTextFile"],
      ownedMembers: PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
    },
  },
};
const allModules = (rules: OwnershipRules): OwnershipRules => ({
  ...rules,
  modules: { ...rules.modules, ...RECORD_MODULE_RULES, ...CHILD_MODULE_RULES },
});
/** Partition by explicit pilot identities, analyze every module exactly once.
 * This selects registrations, not allowed sites; every violation is inventoried. */
export function registeredOwnership(sources: SourceModule[]) {
  const groups = new Map<OwnershipRules, SourceModule[]>();
  const policies = new Map<
    OwnershipRules,
    readonly [OwnershipRules, OwnershipRules]
  >();
  for (const source of sources) {
    const rules = source.file === OPERATION_ADAPTER
      ? OPERATION_ADAPTER_OWNERSHIP
      : source.file === OPERATION_PILOT
      ? OPERATION_PILOT_OWNERSHIP
      : source.file === BOOT_OWNER
      ? BOOT_OWNERSHIP
      : fixtureScenarios.includes(source.file)
      ? FIXTURE_SCENARIO_OWNERSHIP
      : source.file === RECORD_CHANNEL
      ? RECORD_ENGINE_OWNERSHIP
      : RECORD_PILOT_FILES.includes(source.file)
      ? RECORD_PILOT_OWNERSHIP
      : FIXTURE_PILOT_FILES.includes(source.file)
      ? FIXTURE_PILOT_OWNERSHIP
      : source.file.startsWith("tests/") ||
          source.file.startsWith("client/tests/")
      ? CHILD_OWNERSHIP
      : PRODUCT_OWNERSHIP;
    let pair = policies.get(rules);
    if (!pair) {
      const ordinary = allModules(rules);
      pair = [ordinary, coordinationRules(ordinary)];
      policies.set(rules, pair);
    }
    // Server work and the private resource engine retain their own contracts.
    // Other local transitives cannot hide a coordinator behind a re-export.
    const effective = pair[
      source.file.startsWith("server/") || source.file === RESOURCE_ENGINE
        ? 0
        : 1
    ];
    const group = groups.get(effective) ?? [];
    group.push(source);
    groups.set(effective, group);
  }
  return [...groups].flatMap(([rules, modules]) =>
    analyzeOwnership(modules, rules)
  );
}
