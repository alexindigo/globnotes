// SPDX-License-Identifier: LGPL-3.0-only
import type { LegacySite, OwnershipFamily } from "./ownership_contract.ts";
import sites from "./ownership_legacy_sites.json" with { type: "json" };
import rootSites from "./ownership_root_sites.json" with { type: "json" };
import recordSites from "./ownership_record_sites.json" with { type: "json" };
import childSites from "./ownership_child_sites.json" with { type: "json" };
import operationSites from "./owned_operation_legacy.json" with {
  type: "json",
};
import operationFamilies from "./owned_operation_families.json" with {
  type: "json",
};
import clockSites from "./fixture_clock_legacy.json" with { type: "json" };

/** Exact execution-base occurrences, not owner declarations/path exemptions.
 * Remove sites as their named families migrate; keep the consumer manifest.
 * P01 protects runtime roots and process acquisition. Credential privacy belongs
 * to the P07-P10 module owners, not a TextEncoder or credential-flow heuristic.
 */
export const INVENTORY_BASE = "4436da3d6819790f52a4d4d50969800c72ddb663";
export const OWNERSHIP_FAMILIES: Record<string, OwnershipFamily> = {
  ...operationFamilies,
  "schema-lease-held-work": {
    replacement: "P04",
    closed: true,
    consumers: [
      "tests/owned_operation_test.ts",
      "tests/plugin_settings_schema_lease_test.ts",
    ],
  },
  "fixture-layout-pilot": {
    replacement: "P15",
    closed: true,
    consumers: [
      "tests/fixture_layout_ownership_test.ts",
      "tests/config_paths_test.ts",
      "client/tests/e2e/setup-wizard.mjs",
      "client/tests/e2e/plugin-prefix-auth.mjs",
    ],
  },
  "child-lifetime-pilot": {
    replacement: "P12",
    closed: true,
    consumers: [
      "tests/owned_child_test.ts",
      "tests/server_lifetime_test.ts",
      "client/tests/e2e/setup-wizard.mjs",
    ],
  },
  "legacy-child-execution": {
    replacement: "A03/A08/T01: remaining raw launcher module references",
    consumers: [
      "tests/backup_plugin_controls_test.ts",
      "tests/process_records_test.ts",
      "tests/plugin_render_recovery_test.ts",
      "tests/plugin_worker_liveness_test.ts",
      "tests/identity_ownership_test.ts",
      "tests/timing/product_settlement_stall_test.ts",
      "tests/timing/plugin_stall_test.ts",
    ],
  },
  "child-contract-rescue": {
    replacement: "A11: explicit post-verdict low-level contract rescue",
    consumers: ["tests/server_lifetime_test.ts"],
  },
  "legacy-clock-roots": {
    replacement: "A09/A11",
    consumers: [
      "tests/fixture_clock_guard_test.ts",
      "tests/totp_test.ts",
      "tests/native_totp_fixture_test.ts",
    ],
  },
  "legacy-live-totp-import": {
    replacement: "A09",
    consumers: [
      "tests/access_settings_test.ts",
      "tests/auth_test.ts",
      "tests/local_auth_test.ts",
    ],
  },
  "record-channel-pilot": {
    replacement: "P11",
    closed: true,
    consumers: [
      "tests/owned_record_channel_test.ts",
      "tests/process_records_test.ts",
      "client/tests/e2e/sync-driver-native.mjs",
      "client/tests/e2e/sync-status-native.mjs",
    ],
  },
  "sync-fixture-data-io": {
    replacement:
      "A09/A11: retained product fixture and artifact IO, not control records",
    consumers: ["client/tests/e2e/sync-status-native.mjs"],
  },
  "legacy-record-import": {
    replacement: "A09/A11: remaining raw protocol imports",
    consumers: [
      "tests/process_records_test.ts",
      "tests/catalog_work_audit_test.ts",
      "tests/server_lifetime_test.ts",
      "client/tests/e2e/backup-plugin.mjs",
      "client/tests/e2e/setup-wizard.mjs",
    ],
  },
  "fixture-scope-pilot": {
    replacement: "P03",
    closed: true,
    consumers: [
      "tests/fixture_scope_test.ts",
      "tests/plugin_fixture_cleanup_test.ts",
      "tests/plugin_write_bases_test.ts",
    ],
  },
  "owned-publication-pilot": {
    replacement: "P06; wider adoption A04/A05/I06/I14",
    closed: true,
    consumers: [
      "tests/owned_publication_test.ts",
      "tests/config_file_store_test.ts",
      "tests/identity_accounts_test.ts",
      "tests/owned_publication_guard_test.ts",
    ],
  },
  "operation-lease-pilot": {
    replacement: "P05; wider adoption A04-A07/I05-I14",
    closed: true,
    consumers: [
      "tests/operation_lease_test.ts",
      "tests/identity_authority_test.ts",
      "tests/http_mutation_lease_test.ts",
      "tests/operation_lease_guard_test.ts",
    ],
  },
  "resource-core-pilot": {
    replacement: "P02",
    closed: true,
    consumers: [
      "tests/ownership_scope_test.ts",
      "tests/ownership_resource_guard_test.ts",
    ],
  },
  "native-finalizer-pilot": {
    replacement: "P02",
    closed: true,
    consumers: [
      "tests/native_finalization_ownership_test.ts",
      "client/tests/e2e/native-case-finalization.test.js",
    ],
  },
  "native-process-control": {
    replacement: "P12/T02/A08",
    consumers: [
      "client/tests/e2e/runner-entrypoint-controls.mjs",
      "client/tests/e2e/native-suite-results.test.js",
    ],
  },
  "native-expression-input": {
    replacement:
      "A11: explicit DOM-expression input ownership, no general Function constructor",
    consumers: [
      "client/tests/e2e/native-dom-snapshot.test.js",
      "client/tests/e2e/settings-inventory-native.test.js",
      "client/tests/e2e/sidebar-navigation-native.test.js",
    ],
  },
  "test-process-control": {
    replacement: "P12/T01/A11",
    consumers: [
      "tests/server_lifetime_test.ts",
      "tests/product_settlement_test.ts",
      "tests/timing/product_settlement_stall_test.ts",
      "tests/plugin_worker_liveness_test.ts",
      "tests/index_pass_isolation_test.ts",
    ],
  },
  "selector-graph": {
    replacement: "P17/A11: explicit dependency-graph command owner",
    consumers: ["tests/select_checks_test.ts", "tests/gate_selection_test.ts"],
  },
  "plugin-module-loader": {
    replacement: "A11: explicit private product-module input ownership",
    consumers: [
      "tests/plugin_runtime_test.ts",
      "tests/plugin_worker_liveness_test.ts",
    ],
  },
  "native-account": {
    replacement: "A08",
    consumers: ["client/tests/e2e/access-settings.mjs"],
  },
  "native-driver": {
    replacement: "T02/A08",
    consumers: ["client/tests/e2e/generic-plugin-system.mjs"],
  },
  "native-origin": {
    replacement: "A08",
    consumers: [
      "client/tests/e2e/setup-wizard.mjs",
      "client/tests/e2e/http-origin.test.js",
    ],
  },
  "native-hub-safe": {
    replacement: "A08",
    consumers: ["client/tests/e2e/hub-safe-saves-native.mjs"],
  },
  "native-hub-writers": {
    replacement: "A08",
    consumers: ["client/tests/e2e/hub-writers-gate-native.mjs"],
  },
  "native-suite": {
    replacement: "A08",
    consumers: [
      "client/tests/e2e/native-result-controls.mjs",
      "client/tests/e2e/native-suite-results.test.js",
    ],
  },
  "native-picker": {
    replacement: "A08",
    consumers: ["client/tests/e2e/settings-ui.mjs"],
  },
  "native-permissions": {
    replacement: "A08",
    consumers: ["client/tests/e2e/plugin-permissions.mjs"],
  },
  "native-prefix": {
    replacement: "A08",
    consumers: ["client/tests/e2e/plugin-prefix-auth.mjs"],
  },
  "native-entrypoint": {
    replacement: "A08",
    consumers: ["client/tests/e2e/runner-entrypoint-controls.mjs"],
  },
  "native-foundations": {
    replacement: "A08",
    consumers: ["client/tests/e2e/settings-foundations.mjs"],
  },
  "native-surfaces": {
    replacement: "A08",
    consumers: ["client/tests/e2e/settings-ui.mjs"],
  },
  "unit-runner": {
    replacement: "A08",
    consumers: ["client/tests/e2e/unit-consumer-controls.mjs"],
  },
  "suspension-wrapper": {
    replacement: "T01",
    consumers: ["tests/timing/product_settlement_stall_test.ts"],
  },
  "handler-loader": {
    replacement: "A11",
    consumers: [
      "tests/http_mutation_lease_test.ts",
      "tests/plugin_data_test.ts",
      "tests/plugin_render_lifecycle_test.ts",
      "tests/plugin_settings_schema_lease_test.ts",
    ],
  },
  // Deliberately compiled upstream reference code is a product input, not
  // another launcher owner. A11 reviews its explicit input classification;
  // these real consumers stay, rather than a blanket interop/ exemption.
  "reference-input": {
    replacement: "A11",
    consumers: [
      "tests/remotely_save_format_test.ts",
      "tests/remotely_save_acceptance_test.ts",
      "client/tests/e2e/remotely-save-native.mjs",
    ],
  },
};

export const LEGACY_OWNERSHIP: LegacySite[] = [
  ...sites,
  ...rootSites,
  ...recordSites,
  ...childSites,
  ...operationSites,
  ...clockSites,
]
  .map((site) => {
    const family = OWNERSHIP_FAMILIES[site.family];
    if (!family) throw new Error(`absent protected family: ${site.family}`);
    return { ...site, ...family };
  });
