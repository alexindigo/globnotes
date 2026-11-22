// SPDX-License-Identifier: LGPL-3.0-only
import {
  analyzeOwnership,
  type OwnershipRules,
  PROCESS_OWNERSHIP,
  type SourceModule,
} from "./ownership_contract.ts";
import { coordinationRules } from "./owned_operation_contract.ts";
export const DRIVER_STARTUP = "tests/helpers/driver_startup.ts";
export const DRIVER_PRELOAD = "tests/helpers/driver_startup_preload.ts";
export const DRIVER_PROTOCOL = "tests/helpers/driver_startup_protocol.ts";
export const DRIVER_FIXTURE = "tests/helpers/driver_fixture.ts";
export const DRIVER_CONTRACT = "tests/driver_phase_ownership_test.ts";
const DRIVER_MODULE_RULES = {
  [DRIVER_STARTUP]: [DRIVER_FIXTURE, DRIVER_CONTRACT],
  [DRIVER_PROTOCOL]: [DRIVER_PRELOAD, DRIVER_CONTRACT],
  [DRIVER_PRELOAD]: [DRIVER_CONTRACT],
};
import {
  CLOCK_MODULE_RULES,
  FIXTURE_CLOCK,
  fixtureClockRules,
} from "./fixture_clock_rules.ts";

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

export const OPERATION_LEASE_OWNER = "server/operation_lease.ts";
export const GUARDED_SINK_OWNER = "server/internal/guarded_sink.ts";
export const AUTHORITY_DISCLOSURE = "server/internal/authority_disclosure.ts";
export const AUTHORITY_PILOT = "server/auth/authority.ts";

/** P05 protects capability acquisition at resolved private module imports.
 * Semantics inside these exact owners remain type/runtime contract obligations. */
export const OPERATION_OWNERSHIP: OwnershipRules = {
  roots: RESOURCE_OWNERSHIP.roots,
  modules: {
    ...RESOURCE_OWNERSHIP.modules,
    [OPERATION_LEASE_OWNER]: [
      "server/auth/sessions.ts",
      AUTHORITY_PILOT,
      "server/auth/middleware.ts",
      GUARDED_SINK_OWNER,
      AUTHORITY_DISCLOSURE,
      "server/plugins/host.ts",
      "tests/instance_disclosure_test.ts",
      "tests/operation_lease_test.ts",
      "tests/identity_authority_test.ts",
      "server/config/file_store.ts",
      "server/config/owned_publication.ts",
      "server/auth/records.ts",
      "tests/owned_publication_test.ts",
      "tests/recorded_publication_test.ts",
      "tests/helpers/recorded_publication_child.ts",
      "tests/recorded_publication_set_test.ts",
      "server/auth/internal/account_credentials.ts",
      "tests/credential_proof_test.ts",
      "tests/credential_transition_test.ts",
      "tests/helpers/credential_commands.ts",
      "server/auth/offline_recovery.ts",
      "tests/helpers/account_preparation.ts",
      "tests/credential_preparation_test.ts",
      "server/internal/publication_validation.ts",
      "tests/participant_validation_test.ts",
      "tests/participant_admin_authority_test.ts",
      "tests/credential_bootstrap_preparation_test.ts",
    ],
    [GUARDED_SINK_OWNER]: [
      AUTHORITY_DISCLOSURE,
      "tests/operation_lease_test.ts",
      "server/config/file_store.ts",
      "server/auth/sessions.ts",
    ],
    [AUTHORITY_DISCLOSURE]: [AUTHORITY_PILOT, "server/plugins/host.ts"],
  },
};

export const PUBLICATION_STORE = "server/config/file_store.ts";
export const PUBLICATION_OWNER = "server/config/owned_publication.ts";
export const PUBLICATION_PILOT = "server/auth/records.ts";
export const PUBLICATION_PORT = "server/config/internal/publication_port.ts";
export const PUBLICATION_VALIDATION =
  "server/internal/publication_validation.ts";
export const AUTHORITY_READ = "server/auth/internal/authority_read.ts";
export const PARTICIPANT_COMPLETION =
  "server/config/internal/participant_completion.ts";
export const ACCOUNT_PARTICIPATION =
  "server/auth/internal/account_participation.ts";
export const PUBLICATION_OWNERSHIP: OwnershipRules = {
  roots: OPERATION_OWNERSHIP.roots,
  modules: {
    [PUBLICATION_VALIDATION]: [
      PUBLICATION_OWNER,
      "server/auth/internal/account_credentials.ts",
    ],
    ["server/internal/operation_validation.ts"]: [
      "server/operation_lease.ts",
      PUBLICATION_VALIDATION,
      "server/auth/internal/authority_context.ts",
    ],
    ["server/auth/internal/authority_context.ts"]: [
      "server/auth/authority_context.ts",
      "server/auth/authority.ts",
      "server/auth/acl.ts",
      "server/auth/sessions.ts",
    ],
    [AUTHORITY_READ]: [
      PUBLICATION_PILOT,
      "tests/participant_validation_test.ts",
      "server/auth/accounts.ts",
      "server/auth/acl.ts",
      "server/auth/sessions.ts",
      "server/auth/internal/authority_context.ts",
    ],
    ...OPERATION_OWNERSHIP.modules,
    [PARTICIPANT_COMPLETION]: [
      PUBLICATION_OWNER,
      ACCOUNT_PARTICIPATION,
      "tests/credential_bootstrap_preparation_test.ts",
    ],
    [ACCOUNT_PARTICIPATION]: [
      "server/auth/acl.ts",
      "server/auth/accounts.ts",
      "server/auth/internal/account_credentials.ts",
    ],
    [PUBLICATION_OWNER]: [
      PUBLICATION_PILOT,
      "tests/owned_publication_test.ts",
      "tests/helpers/recorded_publication_child.ts",
      "tests/recorded_publication_set_test.ts",
      "tests/participant_validation_test.ts",
      "tests/credential_bootstrap_preparation_test.ts",
      "tests/participant_admin_authority_test.ts",
    ],
    [PUBLICATION_PORT]: [
      PUBLICATION_STORE,
      PUBLICATION_OWNER,
      "tests/owned_publication_test.ts",
      "server/auth/offline_recovery.ts",
      "tests/recorded_publication_test.ts",
    ],
  },
};

/** The same analyzer checks the pilot and adapter's root/import boundaries.
 * The pilot cannot acquire a raw writer, even by choosing another import form.
 * Existing unrelated metadata/content writers retain their own migration scope. */
export const PUBLICATION_PILOT_OWNERSHIP: OwnershipRules = {
  ...PUBLICATION_OWNERSHIP,
  roots: {
    ...PUBLICATION_OWNERSHIP.roots,
    Deno: {
      ...PUBLICATION_OWNERSHIP.roots.Deno,
      ownedMembers: {
        ...PUBLICATION_OWNERSHIP.roots.Deno.ownedMembers,
        ...Object.fromEntries(
          [
            "writeTextFileSync",
            "writeTextFile",
            "writeFileSync",
            "writeFile",
            "copyFileSync",
            "copyFile",
            "linkSync",
            "symlinkSync",
            "symlink",
            "renameSync",
            "rename",
            "removeSync",
            "remove",
            "makeTempFileSync",
            "makeTempFile",
            "openSync",
            "open",
            "mkdirSync",
            "mkdir",
            "makeTempDirSync",
            "makeTempDir",
            "chmodSync",
            "chmod",
            "chownSync",
            "utimeSync",
            "utime",
          ].map((member) => [member, [PUBLICATION_STORE]]),
        ),
      },
    },
  },
  modules: {
    ...PUBLICATION_OWNERSHIP.modules,
    [PUBLICATION_STORE]: [PUBLICATION_OWNER],
    "node:fs": [PUBLICATION_STORE],
    "node:fs/promises": [PUBLICATION_STORE],
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

export const SECRET_CODEC = "server/auth/credentials.ts";
/** Secret representations are acquired only at these resolved module roots.
 * Pure encoders and aliases do not confer credential ownership. */
export const SECRET_OWNERSHIP: OwnershipRules = {
  roots: PUBLICATION_OWNERSHIP.roots,
  modules: {
    ...PUBLICATION_OWNERSHIP.modules,
    [SECRET_CODEC]: [
      "server/auth/accounts.ts",
      "server/auth/local.ts",
      "server/auth/internal/account_credentials.ts",
      "tests/credential_proof_test.ts",
      "tests/credential_secret_test.ts",
      "tests/identity_totp_test.ts",
      "server/auth/totp_enrolment.ts",
      "tests/helpers/credential_commands.ts",
      "server/auth/internal/account_record.ts",
      "server/auth/internal/credential_reducer.ts",
      "tests/identity_accounts_test.ts",
      "tests/identity_totp_upgrade_test.ts",
    ],
  },
};
export const CREDENTIAL_ENGINE = "server/auth/internal/account_credentials.ts";
export const ACCOUNT_REPOSITORY = "server/auth/accounts.ts";
/** Whole-module ownership keeps runtime binders and transitional raw ports
 * out of ordinary workflows; public errors/types confer no acquisition. */
export const PROOF_OWNERSHIP: OwnershipRules = {
  roots: SECRET_OWNERSHIP.roots,
  modules: {
    ...SECRET_OWNERSHIP.modules,
    [CREDENTIAL_ENGINE]: [
      ACCOUNT_REPOSITORY,
      "tests/helpers/credential_commands.ts",
    ],
    "tests/helpers/credential_commands.ts": [
      "tests/credential_bootstrap_preparation_test.ts",
      "tests/credential_login_step_test.ts",
      "tests/credential_transition_test.ts",
      "tests/identity_totp_contract_test.ts",
      "tests/credential_preparation_test.ts",
      "tests/identity_sessions_test.ts",
    ],
    [ACCOUNT_REPOSITORY]: [
      "server/auth/sessions.ts",
      "server/auth/acl.ts",
      "tests/config_durability_test.ts",
      "tests/credential_proof_test.ts",
      "tests/credential_transition_test.ts",
      "tests/helpers/credential_commands.ts",
      "tests/identity_accounts_test.ts",
      "tests/identity_acl_test.ts",
      "tests/identity_authority_test.ts",
      "tests/identity_declarations_test.ts",
      "tests/instance_disclosure_test.ts",
      "tests/identity_sessions_test.ts",
      "tests/identity_totp_test.ts",
      "tests/identity_totp_fixed_form_test.ts",
      "tests/identity_totp_upgrade_test.ts",
    ],
  },
};
export const OFFLINE_RECOVERY = "server/auth/offline_recovery.ts";
export const PREPARATION_HELPER = "tests/helpers/account_preparation.ts";
export const PREPARATION_OWNERSHIP: OwnershipRules = {
  roots: PROOF_OWNERSHIP.roots,
  modules: {
    ...PROOF_OWNERSHIP.modules,
    [CREDENTIAL_ENGINE]: [
      ...PROOF_OWNERSHIP.modules[CREDENTIAL_ENGINE],
      PREPARATION_HELPER,
      "tests/participant_admin_authority_test.ts",
    ],
    [ACCOUNT_REPOSITORY]: [
      ...PROOF_OWNERSHIP.modules[ACCOUNT_REPOSITORY],
      PREPARATION_HELPER,
      "tests/credential_preparation_test.ts",
      "tests/credential_directory_test.ts",
      "tests/credential_bootstrap_preparation_test.ts",
    ],
    [OFFLINE_RECOVERY]: [
      CREDENTIAL_ENGINE,
      PREPARATION_HELPER,
      "tests/recorded_publication_test.ts",
      "tests/recorded_publication_set_test.ts",
    ],
    [PREPARATION_HELPER]: [
      "tests/credential_preparation_test.ts",
      "tests/participant_admin_authority_test.ts",
      "tests/credential_bootstrap_preparation_test.ts",
      "tests/config_durability_test.ts",
      "tests/credential_directory_test.ts",
      "tests/credential_proof_test.ts",
      "tests/credential_transition_test.ts",
      "tests/helpers/credential_commands.ts",
      "tests/identity_accounts_test.ts",
      "tests/identity_acl_test.ts",
      "tests/identity_authority_test.ts",
      "tests/identity_declarations_test.ts",
      "tests/instance_disclosure_test.ts",
      "tests/identity_sessions_test.ts",
      "tests/identity_totp_fixed_form_test.ts",
      "tests/identity_totp_test.ts",
      "tests/identity_totp_upgrade_test.ts",
    ],
  },
};
export const ACCOUNT_RECORD = "server/auth/internal/account_record.ts";
export const CREDENTIAL_REDUCER = "server/auth/internal/credential_reducer.ts";
export const IDENTITY_HELPER = "tests/helpers/identity.ts";
/** New privileged import/schema boundaries, separate from fixture migration. */
export const ADOPTION_OWNERSHIP: OwnershipRules = {
  roots: PREPARATION_OWNERSHIP.roots,
  modules: {
    ...PREPARATION_OWNERSHIP.modules,
    [ACCOUNT_REPOSITORY]: [
      ...PREPARATION_OWNERSHIP.modules[ACCOUNT_REPOSITORY],
      "tests/credential_import_test.ts",
    ],
    [PREPARATION_HELPER]: [
      ...PREPARATION_OWNERSHIP.modules[PREPARATION_HELPER],
      "tests/credential_import_test.ts",
    ],
    [ACCOUNT_RECORD]: [
      ACCOUNT_REPOSITORY,
      IDENTITY_HELPER,
      "tests/identity_totp_fixed_form_test.ts",
    ],
    [CREDENTIAL_REDUCER]: [
      CREDENTIAL_ENGINE,
      "tests/identity_totp_upgrade_test.ts",
    ],
    [IDENTITY_HELPER]: [
      "tests/credential_login_step_test.ts",
      "tests/participant_admin_authority_test.ts",
      "tests/credential_bootstrap_preparation_test.ts",
      "tests/config_durability_test.ts",
      "tests/config_owned_root_test.ts",
      "tests/credential_directory_test.ts",
      "tests/credential_import_test.ts",
      "tests/credential_preparation_test.ts",
      "tests/credential_proof_test.ts",
      "tests/credential_transition_test.ts",
      PREPARATION_HELPER,
      "tests/helpers/credential_commands.ts",
      "tests/identity_accounts_test.ts",
      "tests/identity_acl_test.ts",
      "tests/identity_authority_test.ts",
      "tests/identity_declarations_test.ts",
      "tests/identity_ownership_test.ts",
      "tests/instance_disclosure_test.ts",
      "tests/identity_sessions_test.ts",
      "tests/identity_totp_contract_test.ts",
      "tests/identity_totp_fixed_form_test.ts",
      "tests/identity_totp_test.ts",
      "tests/identity_totp_upgrade_test.ts",
    ],
  },
};

export const FIXTURE_SCOPE_ENGINE = "tests/helpers/fixture_scope_engine.ts";
export const NATIVE_FIXTURE_SCOPE = "client/tests/e2e/fixture-ownership.mjs";
export const NATIVE_FIXTURE_PILOT =
  "client/tests/e2e/native-ownership-control.mjs";
export const PLUGIN_FIXTURE_ENGINE = "tests/helpers/plugin_fixture_engine.ts";
export const PLUGIN_OPERATIONS = "tests/helpers/plugin_operations_fixture.ts";
/** Private construction modules have public callback facades. Every import form
 * is checked at the resolved module, never by following the imported value. */
export const FIXTURE_OWNERSHIP: OwnershipRules = {
  ...ADOPTION_OWNERSHIP,
  modules: {
    ...ADOPTION_OWNERSHIP.modules,
    [FIXTURE_SCOPE_ENGINE]: [
      "tests/helpers/fixture_scope.ts",
      PLUGIN_FIXTURE_ENGINE,
      PLUGIN_OPERATIONS,
      "tests/fixture_scope_test.ts",
      "tests/native_fixture_scope_test.ts",
      "tests/owned_child_test.ts",
      "tests/fixture_clock_ownership_test.ts",
      "tests/helpers/hub_fixture.ts",
      "tests/helpers/plugin_lifecycle.ts",
      "tests/helpers/driver_inprocess.ts",
      "tests/helpers/auxiliary_fixture.ts",
      "tests/helpers/sync_status_preload.ts",
      "tests/helpers/owned_record_channel.ts",
      "tests/owned_record_channel_test.ts",
      "tests/helpers/boot.ts",
      DRIVER_FIXTURE,
      FIXTURE_CLOCK,
      "client/tests/e2e/native-totp-fixture.mjs",
      NATIVE_FINALIZER,
      "client/tests/e2e/access-settings.mjs",
      "client/tests/e2e/plugin-review-repairs.mjs",
      "tests/helpers/fixture_layout.ts",
      "tests/helpers/completed_build_engine.ts",
      "tests/fixture_layout_ownership_test.ts",
      "client/tests/e2e/prefix-auth-fixture.mjs",
    ],
    [PLUGIN_FIXTURE_ENGINE]: [
      "tests/helpers/plugin_fixture.ts",
      DRIVER_FIXTURE,
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
  "tests/fixture_clock_ownership_test.ts",
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
    [NATIVE_FIXTURE_SCOPE]: [],
    "tests/helpers/plugin_fixture.ts": [],
    [PLUGIN_OPERATIONS]: [],
  },
};

/** The native facade and its complete small pilot use P03, never raw custody,
 * private construction or filesystem roots. The pilot reads only its CDP port. */
export const NATIVE_FIXTURE_OWNERSHIP: OwnershipRules = {
  ...FIXTURE_OWNERSHIP,
  roots: {
    ...FIXTURE_OWNERSHIP.roots,
    Deno: { members: ["env"] },
  },
  modules: {
    ...FIXTURE_OWNERSHIP.modules,
    [RESOURCE_CORE]: [],
    [NATIVE_FINALIZER]: [],
    "node:fs": [],
    "node:fs/promises": [],
    "jsr:@std/fs@^1.0.20": [],
    "jsr:/@std/fs@^1.0.20/copy": [],
  },
};

export const BROWSER_OPERATION_OWNER = "client/operationOwner.js";
export const BROWSER_OPERATION_PILOT = "client/vaultChanges.js";
export const BROWSER_OPERATION_CONTRACT =
  "client/tests/operation-owner.test.js";
/** Bound plain-module delivery uses P02, never its private engine. The pilot
 * cannot bypass the adapter for custody or acquire raw browser capabilities. */
export const BROWSER_OPERATION_OWNERSHIP: OwnershipRules = {
  ...PRODUCT_OWNERSHIP,
  roots: {
    ...PRODUCT_OWNERSHIP.roots,
    Promise: {
      members: ["resolve", "reject", "all", "allSettled"],
      ownedConstructors: [BROWSER_OPERATION_OWNER],
      ownedMembers: { withResolvers: [] },
    },
    ...Object.fromEntries(
      ["fetch", "navigator", "localStorage", "sessionStorage", "crypto"].map(
        (root) => [root, { members: [] }],
      ),
    ),
    ...Object.fromEntries(
      ["globalThis", "window", "self", "global"].map((root) => [root, {
        ...PRODUCT_OWNERSHIP.roots[root],
        ownedMembers: {
          ...PRODUCT_OWNERSHIP.roots[root]?.ownedMembers,
          fetch: [],
          navigator: [],
          crypto: [],
          localStorage: [],
          sessionStorage: [],
        },
      }]),
    ),
  },
  modules: {
    ...PRODUCT_OWNERSHIP.modules,
    [RESOURCE_CORE]: [BROWSER_OPERATION_OWNER],
  },
};
/** The compatibility contract temporarily removes the newer API and restores
 * it in the same synchronous boundary; product code cannot acquire it. */
const BROWSER_OPERATION_TEST_OWNERSHIP: OwnershipRules = {
  ...PRODUCT_OWNERSHIP,
  roots: {
    ...PRODUCT_OWNERSHIP.roots,
    Promise: {
      members: ["resolve", "reject", "all", "allSettled"],
      ownedMembers: { withResolvers: [BROWSER_OPERATION_CONTRACT] },
    },
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
    "tests/recorded_publication_set_test.ts",
    SYNC_CONTROL,
    "tests/helpers/backup_retarget_preload.ts",
    "tests/helpers/record_schema.ts",
    "tests/owned_record_channel_test.ts",
    DRIVER_STARTUP,
    DRIVER_CONTRACT,
    FIXTURE_CLOCK,
    "tests/fixture_clock_ownership_test.ts",
    "tests/native_totp_fixture_test.ts",
  ],
  "tests/helpers/process_records.ts": [
    RECORD_CHANNEL,
    "tests/owned_record_channel_test.ts",
    "tests/process_records_test.ts",
    DRIVER_PROTOCOL,
    DRIVER_CONTRACT,
  ],
  [RECORD_PUBLICATION]: ["tests/helpers/process_records.ts"],
};
export const RECORD_OWNERSHIP: OwnershipRules = {
  ...FIXTURE_OWNERSHIP,
  modules: { ...FIXTURE_OWNERSHIP.modules, ...RECORD_MODULE_RULES },
};
export const RECORD_PILOT_FILES = [
  SYNC_NATIVE,
  SYNC_PRELOAD,
  SYNC_CONTROL,
  DRIVER_STARTUP,
  DRIVER_PRELOAD,
  DRIVER_PROTOCOL,
];
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
export const CONTENDER_ADAPTER = "tests/helpers/owned_contenders.ts";
export const CONTENDER_PILOT = "tests/owned_contenders_test.ts";
export const CONTENDER_GUARD = "tests/owned_contenders_guard_test.ts";
export const CONTENDER_PILOT_OWNERSHIP: OwnershipRules = {
  ...OPERATION_ADAPTER_OWNERSHIP,
  roots: {
    ...OPERATION_ADAPTER_OWNERSHIP.roots,
    Deno: {
      members: ["test"],
      ownedMembers: PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
    },
  },
};
export const COMPLETED_BUILD_ENGINE = "tests/helpers/completed_build_engine.ts";
export const LAYOUT_OWNER = "tests/helpers/fixture_layout.ts";
export const PREFIX_LAYOUT = "client/tests/e2e/prefix-auth-fixture.mjs";
export const LAYOUT_MODULE_RULES = {
  "jsr:/@std/fs@^1.0.20/ensure-dir": [],
  [COMPLETED_BUILD_ENGINE]: [
    "tests/helpers/completed_build.ts",
    LAYOUT_OWNER,
    "tests/fixture_layout_ownership_test.ts",
  ],
};
export const LAYOUT_OWNERSHIP: OwnershipRules = {
  ...CHILD_OWNERSHIP,
  modules: { ...CHILD_OWNERSHIP.modules, ...LAYOUT_MODULE_RULES },
};
export const LAYOUT_PILOT_OWNERSHIP: OwnershipRules = {
  ...BOOT_OWNERSHIP,
  roots: {
    ...BOOT_OWNERSHIP.roots,
    Deno: {
      ...BOOT_OWNERSHIP.roots.Deno,
      members: ["errors", "readTextFile", "realPathSync"],
      ownedMembers: {
        ...BOOT_OWNERSHIP.roots.Deno.ownedMembers,
        ...Object.fromEntries(
          [
            "makeTempDir",
            "makeTempDirSync",
            "makeTempFile",
            "makeTempFileSync",
            "mkdir",
            "mkdirSync",
            "copyFile",
            "copyFileSync",
          ].map((member) => [member, [LAYOUT_OWNER, COMPLETED_BUILD_ENGINE]]),
        ),
      },
    },
  },
  modules: {
    ...BOOT_OWNERSHIP.modules,
    ...LAYOUT_MODULE_RULES,
    "jsr:/@std/fs@^1.0.20/ensure-dir": [],
  },
};
export const PREFIX_LAYOUT_OWNERSHIP: OwnershipRules = {
  ...LAYOUT_PILOT_OWNERSHIP,
  roots: {
    ...LAYOUT_PILOT_OWNERSHIP.roots,
    Deno: {
      ...LAYOUT_PILOT_OWNERSHIP.roots.Deno,
      members: [
        "errors",
        "execPath",
        "listen",
        "open",
        "readFile",
        "writeTextFile",
      ],
    },
  },
};
export const LAYOUT_OWNER_OWNERSHIP: OwnershipRules = {
  ...LAYOUT_PILOT_OWNERSHIP,
  roots: {
    ...LAYOUT_PILOT_OWNERSHIP.roots,
    Deno: {
      ...LAYOUT_PILOT_OWNERSHIP.roots.Deno,
      members: ["errors", "makeTempDir", "mkdir", "remove", "removeSync"],
    },
  },
};
export const COMPLETED_BUILD_OWNERSHIP: OwnershipRules = {
  ...LAYOUT_PILOT_OWNERSHIP,
  roots: {
    ...LAYOUT_PILOT_OWNERSHIP.roots,
    Deno: {
      ...LAYOUT_PILOT_OWNERSHIP.roots.Deno,
      members: [
        "errors",
        "lstat",
        "makeTempDir",
        "mkdir",
        "readDir",
        "readFile",
        "remove",
        "statSync",
        "writeFile",
      ],
    },
  },
};
const allModules = (rules: OwnershipRules): OwnershipRules => ({
  ...rules,
  modules: {
    ...rules.modules,
    ...RECORD_MODULE_RULES,
    ...CHILD_MODULE_RULES,
    ...DRIVER_MODULE_RULES,
    ...CLOCK_MODULE_RULES,
    ...LAYOUT_MODULE_RULES,
  },
});
const driverDenoMembers: Record<string, readonly string[]> = {
  [DRIVER_STARTUP]: [],
  [DRIVER_PRELOAD]: ["pid"],
  [DRIVER_PROTOCOL]: ["stderr"],
  [DRIVER_FIXTURE]: ["readTextFile", "writeTextFileSync"],
};
const DRIVER_OWNERSHIP = Object.fromEntries(
  Object.entries(driverDenoMembers).map(([file, members]) => [file, {
    ...RECORD_PILOT_OWNERSHIP,
    roots: {
      ...RECORD_PILOT_OWNERSHIP.roots,
      Deno: {
        members,
        ownedMembers: PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
      },
    },
  }]),
);
/** Partition by explicit pilot identities, analyze every module exactly once.
 * This selects registrations, not allowed sites; every violation is inventoried. */
export function registeredOwnership(sources: SourceModule[]) {
  const groups = new Map<OwnershipRules, SourceModule[]>();
  const policies = new Map<
    OwnershipRules,
    readonly [OwnershipRules, OwnershipRules]
  >();
  for (const source of sources) {
    const rules = DRIVER_OWNERSHIP[source.file] ??
      (source.file === NATIVE_FIXTURE_SCOPE ||
          source.file === NATIVE_FIXTURE_PILOT
        ? NATIVE_FIXTURE_OWNERSHIP
        : source.file === BROWSER_OPERATION_OWNER ||
            source.file === BROWSER_OPERATION_PILOT
        ? BROWSER_OPERATION_OWNERSHIP
        : source.file === BROWSER_OPERATION_CONTRACT
        ? BROWSER_OPERATION_TEST_OWNERSHIP
        : source.file === CONTENDER_ADAPTER
        ? OPERATION_ADAPTER_OWNERSHIP
        : source.file === CONTENDER_PILOT || source.file === CONTENDER_GUARD
        ? CONTENDER_PILOT_OWNERSHIP
        : source.file === OPERATION_ADAPTER
        ? OPERATION_ADAPTER_OWNERSHIP
        : source.file === OPERATION_PILOT
        ? OPERATION_PILOT_OWNERSHIP
        : source.file === BOOT_OWNER
        ? LAYOUT_PILOT_OWNERSHIP
        : source.file === PREFIX_LAYOUT
        ? PREFIX_LAYOUT_OWNERSHIP
        : source.file === LAYOUT_OWNER
        ? LAYOUT_OWNER_OWNERSHIP
        : source.file === COMPLETED_BUILD_ENGINE
        ? COMPLETED_BUILD_OWNERSHIP
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
        : PRODUCT_OWNERSHIP);
    let pair = policies.get(rules);
    if (!pair) {
      const ordinary = allModules(rules);
      pair = [ordinary, fixtureClockRules(coordinationRules(ordinary))];
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
