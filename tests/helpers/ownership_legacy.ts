// SPDX-License-Identifier: LGPL-3.0-only
import type { LegacySite, OwnershipFamily } from "./ownership_contract.ts";
import sites from "./ownership_legacy_sites.json" with { type: "json" };
import credentialSites from "./ownership_credentials_sites.json" with {
  type: "json",
};

/** Exact execution-base occurrences, not owner declarations/path exemptions.
 * Remove sites as their named families migrate; keep the consumer manifest.
 * P01 inventories child and credential capabilities before their migrations;
 * no resource, record, credential or coordination closure is inferred from it.
 */
export const INVENTORY_BASE = "4436da3d6819790f52a4d4d50969800c72ddb663";
export const OWNERSHIP_FAMILIES: Record<string, OwnershipFamily> = {
  "credential-stored-interpretation": {
    replacement: "P07",
    consumers: [
      "tests/local_auth_test.ts",
      "tests/identity_sessions_test.ts",
      "tests/identity_totp_test.ts",
    ],
  },
  "credential-legacy-enrollment": {
    replacement: "P09/P10/A01; compatibility adoption I05/I14",
    consumers: [
      "tests/access_settings_test.ts",
      "tests/auth_test.ts",
      "tests/totp_test.ts",
    ],
  },
  "credential-setup-preparation": {
    replacement: "P10/A01; setup adoption I06/I14",
    consumers: ["tests/auth_test.ts", "tests/totp_test.ts"],
  },
  "credential-snapshot-encoding": {
    replacement: "Allowed; preserve snapshot hashing through P10/A01",
    allowed: true,
    closed: true,
    reason:
      "UTF-8 input to the existing snapshot SHA-256 signature, not stored authenticator interpretation",
    consumers: ["tests/access_snapshot_test.ts", "tests/identity_acl_test.ts"],
  },
  "credential-jwt-encoding": {
    replacement: "Allowed; preserve issuer signing bytes through P08/A01",
    allowed: true,
    closed: true,
    reason:
      "UTF-8 encoding of the current JWT signing key in its existing sign/verify owner, not TOTP secret decoding",
    consumers: ["tests/local_auth_test.ts", "tests/identity_sessions_test.ts"],
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
    consumers: ["tests/http_mutation_lease_test.ts"],
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

export const LEGACY_OWNERSHIP: LegacySite[] = [...sites, ...credentialSites]
  .map((site) => {
    const family = OWNERSHIP_FAMILIES[site.family];
    if (!family) throw new Error(`absent protected family: ${site.family}`);
    return { ...site, ...family };
  });
