// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type Change,
  type Context,
  CONTROL_GATES,
  loadContext,
  OWNERSHIP_NATIVE_CONTROLS,
  OWNERSHIP_SELECTION,
  parseNameStatus,
  selectChecks,
  selectHarnessControls,
  SHARED_INPUTS,
  STATIC_GATES,
  validateControlSelection,
  validateSelection,
} from "../scripts/select-checks.ts";
import { SELECTION } from "../client/tests/e2e/legacy-native-suite.mjs";

function fixture(): Context {
  return {
    files: [
      "tests/leaf_test.ts",
      "tests/boot_test.ts",
      "tests/literal_test.ts",
      "tests/helper_test.ts",
      "tests/shared_test.ts",
      "tests/plugin_test.ts",
      "tests/test_isolation_contract_test.ts",
      "tests/devcontainer_caps_test.ts",
      "tests/timing/slow_test.ts",
    ],
    imports: {
      "tests/leaf_test.ts": ["server/leaf.ts"],
      "tests/boot_test.ts": ["tests/helpers/unmapped_boot.ts"],
      "tests/literal_test.ts": [],
      "tests/helper_test.ts": ["tests/leaf_test.ts"],
      "tests/shared_test.ts": ["shared/uuid.ts"],
      "tests/plugin_test.ts": ["plugins/sample/plugin.js"],
      "tests/test_isolation_contract_test.ts": [],
      "tests/devcontainer_caps_test.ts": [],
      // These edges must never be followed by selection.
      "tests/helpers/unmapped_boot.ts": ["server/main.ts"],
      "server/main.ts": ["server/leaf.ts"],
      "server/leaf.ts": ["shared/uuid.ts"],
      "tests/timing/slow_test.ts": ["server/leaf.ts"],
    },
  };
}
const modified = (path: string): Change => ({
  status: "M",
  path,
  removed: false,
});
const select = (...paths: string[]) =>
  selectChecks(paths.map(modified), fixture());

// Independent expectations: never derive coverage from the production map.
const CORE_INPUTS = [
  "shared/ownership.js",
  "shared/ownership.d.ts",
  "shared/ownership-engine.js",
  "tests/helpers/ownership_rules.ts",
  "tests/helpers/ownership_contract.ts",
  "tests/helpers/ownership_legacy.ts",
  "tests/helpers/ownership_legacy_sites.json",
  "tests/helpers/ownership_root_sites.json",
];
const SCOPE_INPUTS = [
  ...CORE_INPUTS,
  "tests/helpers/fixture_scope.ts",
  "tests/helpers/fixture_scope_engine.ts",
  "tests/helpers/fixture_coordination.ts",
];
const OWNERS = [
  {
    path: "shared/ownership.js",
    contract: "tests/ownership_scope_test.ts",
    consumers: [
      "tests/native_finalization_ownership_test.ts",
      "tests/ownership_resource_guard_test.ts",
      "tests/ownership_guard_test.ts",
      "tests/ownership_coverage_test.ts",
      "tests/ownership_erasure_test.ts",
      "tests/ownership_review_test.ts",
    ],
    native: ["setup-wizard"],
    client: ["client/tests/e2e/native-case-finalization.test.js"],
    inputs: [
      ...CORE_INPUTS,
      "client/tests/e2e/native-case-finalization.mjs",
    ],
  },
  {
    path: "tests/helpers/fixture_scope.ts",
    contract: "tests/fixture_scope_test.ts",
    consumers: [
      "tests/plugin_fixture_cleanup_test.ts",
      "tests/ownership_fixture_guard_test.ts",
      "tests/plugin_write_bases_test.ts",
    ],
    native: ["sync-status-native", "plugin-prefix-auth"],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/plugin_fixture.ts",
      "tests/helpers/plugin_fixture_engine.ts",
      "tests/helpers/fixture_scope_engine.ts",
      "tests/helpers/plugin_operations_fixture.ts",
    ],
  },
  {
    path: "tests/helpers/owned_operation.ts",
    contract: "tests/owned_operation_test.ts",
    consumers: [
      "tests/owned_operation_guard_test.ts",
      "tests/plugin_settings_schema_lease_test.ts",
    ],
    native: [],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/owned_operation_families.json",
      "tests/helpers/owned_operation_legacy.json",
      "tests/helpers/product_settlement.ts",
      "tests/helpers/wait.ts",
    ],
  },
  {
    path: "tests/helpers/owned_record_channel.ts",
    contract: "tests/owned_record_channel_test.ts",
    consumers: [
      "tests/process_records_test.ts",
      "tests/ownership_record_guard_test.ts",
      "tests/catalog_work_audit_test.ts",
    ],
    native: ["sync-driver-native", "sync-status-native", "backup-plugin"],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/sync_status_control.ts",
      "tests/helpers/sync_status_preload.ts",
      "tests/helpers/backup_retarget_preload.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
      "tests/helpers/record_schema.ts",
      "tests/helpers/ownership_record_sites.json",
      "client/tests/e2e/sync-status-native.mjs",
      "client/tests/e2e/backup-plugin.mjs",
    ],
  },
  {
    path: "tests/helpers/owned_child.ts",
    contract: "tests/owned_child_test.ts",
    consumers: [
      "tests/server_lifetime_test.ts",
      "tests/ownership_child_guard_test.ts",
    ],
    native: ["setup-wizard", "plugin-prefix-auth"],
    client: ["client/tests/e2e/native-server-lifetime.test.js"],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/boot.ts",
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/process.ts",
      "tests/helpers/process_values.ts",
      "tests/helpers/ownership_child_sites.json",
      "client/tests/e2e/harness-helpers.mjs",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
    ],
  },
  {
    path: "tests/helpers/driver_startup.ts",
    contract: "tests/driver_phase_ownership_test.ts",
    consumers: [
      "tests/driver_phase_guard_test.ts",
      "tests/hub_driver_acceptance_test.ts",
      "tests/hub_driver_native_acceptance_test.ts",
      "tests/hub_driver_supervisor_test.ts",
    ],
    native: ["sync-settings-native", "sync-driver-native"],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/owned_child.ts",
      "tests/helpers/boot.ts",
      "tests/helpers/owned_record_channel.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
      "tests/helpers/record_schema.ts",
      "tests/helpers/driver_startup_preload.ts",
      "tests/helpers/driver_startup_protocol.ts",
      "tests/helpers/driver_startup_schema.ts",
      "tests/helpers/driver_fixture.ts",
      "tests/helpers/fixture_clock.ts",
      "tests/helpers/storage.ts",
      "server/hub/drivers/supervisor.ts",
    ],
  },
  {
    path: "tests/helpers/fixture_clock.ts",
    contract: "tests/fixture_clock_ownership_test.ts",
    consumers: [
      "tests/fixture_clock_guard_test.ts",
      "tests/totp_test.ts",
      "tests/native_totp_fixture_test.ts",
      "tests/access_settings_test.ts",
      "tests/auth_test.ts",
      "tests/local_auth_test.ts",
    ],
    native: [
      "setup-totp-desktop",
      "access-settings",
      "sync-driver-native",
      "plugin-review-repairs",
    ],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/owned_record_channel.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
      "tests/helpers/fixture_clock_legacy.json",
      "tests/helpers/fixture_clock_rules.ts",
      "tests/helpers/fixture_epoch.ts",
      "tests/helpers/totp.ts",
      "tests/helpers/totp_live.ts",
      "tests/helpers/identity.ts",
      "tests/helpers/record_schema.ts",
      "tests/helpers/fixture_clock.ts",
      "client/tests/e2e/native-totp-fixture.mjs",
      "client/tests/e2e/harness-helpers.mjs",
      "client/tests/e2e/repair-fixture-lifetime.mjs",
      "client/tests/e2e/plugin-review-repairs.mjs",
      "client/tests/e2e/setup-totp-desktop.mjs",
      "client/tests/e2e/access-settings.mjs",
      "tests/helpers/driver_fixture.ts",
    ],
  },
  {
    path: "tests/helpers/fixture_layout.ts",
    contract: "tests/fixture_layout_ownership_test.ts",
    consumers: [
      "tests/config_paths_test.ts",
      "tests/ownership_layout_guard_test.ts",
      "tests/config_owned_root_test.ts",
      "tests/server_lifetime_test.ts",
    ],
    native: ["setup-wizard", "plugin-prefix-auth"],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/owned_child.ts",
      "tests/helpers/boot.ts",
      "tests/helpers/fixture_layout.ts",
      "tests/helpers/completed_build.ts",
      "tests/helpers/completed_build_engine.ts",
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/process_values.ts",
      "client/tests/e2e/prefix-auth-fixture.mjs",
      "tests/helpers/process.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
    ],
  },
  {
    path: "tests/helpers/owned_contenders.ts",
    contract: "tests/owned_contenders_test.ts",
    consumers: ["tests/owned_contenders_guard_test.ts"],
    native: [],
    client: [],
    inputs: [
      ...SCOPE_INPUTS,
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
    ],
  },
  {
    path: "scripts/select-checks.ts",
    contract: "tests/select_checks_test.ts",
    consumers: [
      "tests/gate_selection_test.ts",
      "tests/contract_discovery_test.ts",
      "tests/ownership_guard_test.ts",
    ],
    native: [],
    client: [],
    inputs: ["scripts/gates.sh", "scripts/guard-modules.ts"],
  },
];
// Independent copy of the controls every native ownership selection requires.
const CONTROLS = [
  "native-consumer-controls",
  "native-result-controls",
  "runner-entrypoint-controls",
  "unit-consumer-controls",
];
function ownershipFixture(): Context {
  const files = [
    ...new Set([
      ...fixture().files,
      ...OWNERS.flatMap((owner) => [
        owner.path,
        ...owner.inputs,
        owner.contract,
        ...owner.consumers,
        ...owner.client,
        ...owner.native.map((name) => `client/tests/e2e/${name}.mjs`),
      ]),
      ...CONTROLS.map((name) => `client/tests/e2e/${name}.mjs`),
    ]),
  ];
  // No import edges: these assertions can pass only through explicit mappings.
  return {
    files,
    imports: Object.fromEntries(
      files.filter((file) => file.startsWith("tests/")).map(
        (file) => [file, []],
      ),
    ),
  };
}
for (const owner of OWNERS) {
  for (const input of new Set([owner.path, ...owner.inputs])) {
    for (const listed of [true, false]) {
      Deno.test(`select-checks: ownership mapping ${input} selects ${owner.path} contract and consumer families (owner listed=${listed})`, () => {
        const context = ownershipFixture();
        if (!listed) {
          context.files = context.files.filter((file) => file !== owner.path);
        }
        const selected = selectChecks([modified(input)], context);
        const families = OWNERS.filter((family) =>
          family.path === input || family.inputs.includes(input)
        );
        const server = new Set(
          families.flatMap((family) => [family.contract, ...family.consumers]),
        );
        const client = new Set(families.flatMap((family) => family.client));
        if (input.startsWith("client/") || input.startsWith("shared/")) {
          client.add(input);
        }
        const native = [
          ...new Set(families.flatMap((family) => family.native)),
        ];
        assertEquals(
          selected.serverTests,
          context.files.filter((file) => server.has(file)),
          `Missing ownership contract or consumer mapping for ${input}`,
        );
        assertEquals(selected.clientTests, [...client].sort());
        assertEquals(
          selected.browserCases,
          native.length
            ? [
              ...native,
              "native-consumer-controls",
              "native-result-controls",
              "runner-entrypoint-controls",
              "unit-consumer-controls",
            ].sort()
            : [],
        );
        assertEquals(selected.gates, [
          ...STATIC_GATES,
          "server",
          ...(client.size ? ["client"] : []),
          ...(native.length ? ["build", "native"] : []),
        ]);
        assertEquals(selected.browser, native.length > 0);
        assertEquals(
          selected.reasons.filter((reason) =>
            reason.rule.startsWith("ownership:")
          )
            .map((reason) => reason.rule),
          families.map((family) => `ownership:${family.path}`),
        );
        const registry = new Set(SELECTION.map(([name]) => name));
        for (const name of selected.browserCases) {
          assert(registry.has(name), `Unregistered native family ${name}`);
        }
        validateSelection(selected);
      });
    }
  }
  for (const missing of [owner.contract, ...owner.consumers]) {
    Deno.test(`select-checks: ${owner.path} rejects missing mapped consumer ${missing}`, () => {
      const context = ownershipFixture();
      context.files = context.files.filter((file) => file !== missing);
      const message =
        `ownership selection ${owner.path}: missing consumer ${missing}`;
      const error = assertThrows(
        () => selectChecks([modified(owner.path)], context),
        Error,
        message,
      );
      assertEquals(error.message, message);
    });
  }
}
Deno.test("select-checks: production ownership map equals the independent expectations in both directions", () => {
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  assertEquals(
    Object.entries(OWNERSHIP_SELECTION).map(([path, family]) => ({
      path,
      inputs: sorted([path, ...family.inputs]),
      server: sorted(family.server),
      client: sorted(family.client),
      native: sorted(family.native),
    })),
    OWNERS.map((owner) => ({
      path: owner.path,
      inputs: sorted([owner.path, ...owner.inputs]),
      server: sorted([owner.contract, ...owner.consumers]),
      client: sorted(owner.client),
      native: sorted(owner.native),
    })),
  );
  assertEquals(OWNERSHIP_NATIVE_CONTROLS, CONTROLS);
});
Deno.test("select-checks: every production-mapped file and native control exists in the repository", async () => {
  const root = new URL("../", import.meta.url);
  const mapped = [
    ...new Set([
      ...Object.entries(OWNERSHIP_SELECTION).flatMap(([path, family]) => [
        path,
        ...family.inputs,
        ...family.server,
        ...family.client,
        ...family.native.map((name) => `client/tests/e2e/${name}.mjs`),
      ]),
      ...OWNERSHIP_NATIVE_CONTROLS.map((name) =>
        `client/tests/e2e/${name}.mjs`
      ),
    ]),
  ].sort();
  const missing: string[] = [];
  for (const file of mapped) {
    try {
      if (!(await Deno.stat(new URL(file, root))).isFile) missing.push(file);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      missing.push(file);
    }
  }
  assertEquals(missing, []);
  assertEquals(mapped.length > 0, true);
});
Deno.test("select-checks: a missing required native control fails closed", () => {
  for (const control of CONTROLS) {
    const context = ownershipFixture();
    context.files = context.files.filter((file) =>
      file !== `client/tests/e2e/${control}.mjs`
    );
    const message = `ownership selection: missing native control ${control}`;
    const error = assertThrows(
      () =>
        selectChecks([modified("tests/helpers/fixture_layout.ts")], context),
      Error,
      message,
    );
    assertEquals(error.message, message);
  }
});
Deno.test("select-checks: every integrated owner, including P13/P14/P16, has a required mapping", () => {
  assertEquals(
    Object.keys(OWNERSHIP_SELECTION),
    OWNERS.map((owner) => owner.path),
  );
});
Deno.test("select-checks: missing installed-owner consumers fail closed, including deletion and rename", () => {
  for (
    const changes of [
      [modified("tests/helpers/fixture_layout.ts")],
      parseNameStatus("D\0tests/helpers/fixture_layout.ts\0"),
      parseNameStatus(
        "R100\0tests/helpers/fixture_layout.ts\0tests/helpers/replacement.ts\0",
      ),
    ]
  ) {
    const context = ownershipFixture();
    context.files = context.files.filter((path) =>
      path !== "tests/fixture_layout_ownership_test.ts"
    );
    const error = assertThrows(
      () => selectChecks(changes, context),
      Error,
      "ownership selection tests/helpers/fixture_layout.ts: missing consumer tests/fixture_layout_ownership_test.ts",
    );
    assertEquals(
      error.message,
      "ownership selection tests/helpers/fixture_layout.ts: missing consumer tests/fixture_layout_ownership_test.ts",
    );
  }
  const context = ownershipFixture();
  context.files = context.files.filter((path) =>
    path !== "client/tests/e2e/plugin-prefix-auth.mjs"
  );
  const error = assertThrows(
    () => selectChecks([modified("tests/helpers/fixture_layout.ts")], context),
    Error,
    "ownership selection tests/helpers/fixture_layout.ts: missing native consumer plugin-prefix-auth",
  );
  assertEquals(
    error.message,
    "ownership selection tests/helpers/fixture_layout.ts: missing native consumer plugin-prefix-auth",
  );
});
Deno.test("select-checks: P13, P14 and P16 owners must all be present", async () => {
  const root = new URL("../", import.meta.url);
  const required = [
    "tests/helpers/driver_startup.ts",
    "tests/helpers/fixture_clock.ts",
    "tests/helpers/owned_contenders.ts",
  ];
  assertEquals(
    await Promise.all(
      required.map(async (
        file,
      ) => [file, (await Deno.stat(new URL(file, root))).isFile]),
    ),
    required.map((file) => [file, true]),
  );
});
Deno.test("select-checks: installed ownership mappings name actual contracts and native entrypoints", async () => {
  const root = new URL("../", import.meta.url);
  for (const owner of OWNERS) {
    for (
      const file of [
        owner.path,
        ...new Set(owner.inputs),
        owner.contract,
        ...owner.consumers,
        ...owner.client,
        ...owner.native.map((name) => `client/tests/e2e/${name}.mjs`),
      ]
    ) {
      assertEquals({
        file,
        isFile: (await Deno.stat(new URL(file, root))).isFile,
      }, { file, isFile: true });
    }
  }
});
Deno.test("select-checks: selected native fields cannot drop required controls or disagree with build/browser", () => {
  const selected = selectChecks(
    [modified("tests/helpers/fixture_layout.ts")],
    ownershipFixture(),
  );
  for (
    const patch of [{ browser: false }, { browserCases: [] }, {
      browserCases: selected.browserCases.filter((name) =>
        name !== "native-result-controls"
      ),
    }, {
      gates: selected.gates.filter((gate) => gate !== "build"),
    }, { browserCases: [...selected.browserCases, "setup-wizard,theme"] }]
  ) {
    assertThrows(
      () => validateSelection({ ...selected, ...patch }),
      Error,
      "invalid selection",
    );
  }
});

Deno.test("CI controls: only guarded inputs select controls; pre-commit remains separate", () => {
  const controls = (...paths: string[]) =>
    selectHarnessControls(paths.map(modified), "refs/pull/42/merge");
  assertEquals(
    controls(
      "client/views/Note.vue",
      "server/notes/operations.ts",
      "docs/testing.md",
    ).gates,
    [],
  );
  assertEquals(controls("client/tests/e2e/save-preview.mjs").gates, [
    "native-controls",
  ]);
  assertEquals(controls("client/tests/e2e/legacy-native-suite.mjs").gates, [
    "native-results",
    "native-controls",
  ]);
  assertEquals(controls("client/tests/e2e/run.sh").gates, [
    "native-controls",
    "entrypoint-results",
  ]);
  assertEquals(controls("client/tests/modal.test.js").gates, ["unit-controls"]);
  assertEquals(controls("scripts/gates.sh").gates, [...CONTROL_GATES]);
  assertEquals(controls(".github/workflows/ci.yml").gates, [...CONTROL_GATES]);
  validateControlSelection(controls("README.md"));
  assertThrows(() => validateSelection(controls("README.md")));
});

Deno.test("CI controls: unavailable diffs, refs and v2 release tags run every control", () => {
  for (
    const [changes, ref] of [[null, "refs/heads/main"], [[], ""], [
      [],
      "refs/tags/v2.9.0",
    ]] as const
  ) {
    const selected = selectHarnessControls(
      changes === null ? null : [...changes],
      ref,
    );
    assertEquals(selected.gates, [...CONTROL_GATES]);
    assert(selected.reasons.length > 0);
  }
  assertEquals(selectHarnessControls([], "refs/heads/v2").gates, []);
});

Deno.test("CI controls: removed and renamed guarded paths retain their coverage", () => {
  const selected = selectHarnessControls(
    parseNameStatus(
      "R100\0client/tests/e2e/run.sh\0docs/retired.md\0D\0client/tests/modal.test.js\0",
    ),
    "refs/heads/main",
  );
  assertEquals(selected.gates, [
    "unit-controls",
    "native-controls",
    "entrypoint-results",
  ]);
});

Deno.test("CI controls: malformed selections cannot suppress controls", () => {
  for (
    const value of [null, {}, {
      version: 1,
      kind: "harness-controls",
      gates: ["native"],
      reasons: [],
    }, {
      ...selectHarnessControls([], "refs/heads/main"),
      gates: ["native-results", "native-results"],
    }]
  ) {
    assertThrows(() => validateControlSelection(value));
  }
});

Deno.test("select-checks: every change gets whole-tree static gates and contracts", () => {
  for (const paths of [[], ["README.md"], ["server/unused.ts"], ["unknown"]]) {
    const selected = select(...paths);
    assert(STATIC_GATES.every((gate) => selected.gates.includes(gate)));
    assertEquals(selected.contractTests, [
      "tests/test_isolation_contract_test.ts",
      "tests/devcontainer_caps_test.ts",
    ]);
    assert(selected.reasons.length > 0);
    validateSelection(selected);
  }
});

Deno.test("select-checks: guard registration is discovered without isolation import edges or ownership rows", () => {
  const context = fixture();
  context.files.push(
    "tests/ownership_layout_guard_test.ts",
    "tests/new/nested_guard_test.ts",
    "tests/ownership_coverage_test.ts",
    "tests/access_commit_guards_test.ts",
  );
  for (const changes of [[], [modified("README.md")]]) {
    const selected = selectChecks(changes, context);
    assertEquals(selected.contractTests, [
      "tests/test_isolation_contract_test.ts",
      "tests/devcontainer_caps_test.ts",
      "tests/new/nested_guard_test.ts",
      "tests/ownership_coverage_test.ts",
      "tests/ownership_layout_guard_test.ts",
    ]);
    assertEquals(selected.serverTests, []);
    assertEquals(selected.gates, [...STATIC_GATES]);
    validateSelection(selected);
  }
});

Deno.test("select-checks: server tests use direct imports only, not boot or transitive graphs", () => {
  const selected = select("server/leaf.ts");
  assertEquals(selected.gates, [...STATIC_GATES, "server"]);
  assertEquals(selected.serverTests, ["tests/leaf_test.ts"]);
  assertEquals(select("server/main.ts").serverTests, []);
  assertEquals(select("server/unused.ts").gates, [...STATIC_GATES]);
  assertEquals(select("tests/helpers/unmapped_boot.ts").serverTests, [
    "tests/boot_test.ts",
  ]);
  assertEquals(select("tests/leaf_test.ts").serverTests, [
    "tests/leaf_test.ts",
    "tests/helper_test.ts",
  ]);
  assert(
    selected.reasons.some((reason) =>
      reason.rule === "direct imports" &&
      reason.selects.includes("tests/leaf_test.ts")
    ),
  );
});

Deno.test("select-checks: client and shared paths use vitest related without build or controls", () => {
  for (
    const path of [
      "client/views/Home.vue",
      "client/tests/setup.js",
      "client/home.test.js",
    ]
  ) {
    const selected = select(path);
    assertEquals(selected.gates, [...STATIC_GATES, "client"]);
    assertEquals(selected.clientTests, [path]);
  }
  const shared = select("shared/uuid.ts");
  assertEquals(shared.gates, [...STATIC_GATES, "server", "client"]);
  assertEquals(shared.serverTests, ["tests/shared_test.ts"]);
  assertEquals(shared.clientTests, ["shared/uuid.ts"]);
});

Deno.test("select-checks: browser-suite helpers get related tests but never browser gates", () => {
  for (
    const file of [
      "fixture.mjs",
      "legacy-native-suite.mjs",
      "data.json",
      "helper.test.js",
    ]
  ) {
    const path = `client/tests/e2e/${file}`;
    const selected = select(path);
    assertEquals(selected.gates, [...STATIC_GATES, "client"]);
    assertEquals(selected.clientTests, [path]);
    assertEquals(selected.browser, false);
    assertEquals(selected.browserCases, []);
    validateSelection(selected);
  }
});

Deno.test("select-checks: shared inputs stay static except explicit selector regression coverage", () => {
  for (const input of SHARED_INPUTS) {
    const path = input.endsWith("/") ? `${input}run.sh` : input;
    const context = fixture();
    const selectorTests = [
      "tests/select_checks_test.ts",
      "tests/gate_selection_test.ts",
      "tests/contract_discovery_test.ts",
      "tests/ownership_guard_test.ts",
    ];
    context.files.push("scripts/select-checks.ts", ...selectorTests);
    for (const file of selectorTests) context.imports[file] = [];
    context.imports["tests/leaf_test.ts"] = [path];
    const selected = selectChecks([modified(path)], context);
    const mapped = [
      "scripts/select-checks.ts",
      "scripts/gates.sh",
      "scripts/guard-modules.ts",
    ].includes(path);
    assertEquals(selected.gates, [
      ...STATIC_GATES,
      ...(mapped ? ["server"] : []),
    ], path);
    assertEquals(selected.serverTests, mapped ? selectorTests : []);
    assertEquals(selected.clientTests, []);
    assertEquals(selected.timingTests, []);
    assert(
      selected.reasons.some((reason) => reason.selects.includes("--frozen")),
    );
  }
});

Deno.test("select-checks: only changed, surviving timing test files run", () => {
  const selected = select("tests/timing/slow_test.ts");
  assertEquals(selected.gates, [...STATIC_GATES, "timing"]);
  assertEquals(selected.timingTests, ["tests/timing/slow_test.ts"]);
  assertEquals(select("tests/timing/helper.ts").gates, [...STATIC_GATES]);
  assertEquals(select("server/leaf.ts").timingTests, []);
  const deleted = selectChecks(
    parseNameStatus("D\0tests/timing/slow_test.ts\0"),
    fixture(),
  );
  assertEquals(deleted.timingTests, []);
});

Deno.test("select-checks: docs get static gates only even if a test imports them", () => {
  for (const path of ["README.md", "docs/guide.md", "client/notes.md"]) {
    const context = fixture();
    context.imports["tests/leaf_test.ts"] = [path];
    assertEquals(selectChecks([modified(path)], context).gates, [
      ...STATIC_GATES,
    ]);
  }
});

Deno.test("select-checks: unknown paths fail closed to static gates plus related tests", () => {
  for (
    const path of [
      "LICENSE",
      "new-top-level.txt",
      "scripts/cold-load.mjs",
      "plugins/sample/plugin.js",
    ]
  ) {
    const selected = select(path);
    assertEquals(selected.clientTests, [path]);
    assertEquals(
      selected.serverTests,
      path.startsWith("plugins/") ? ["tests/plugin_test.ts"] : [],
    );
    assertEquals(selected.timingTests, []);
    assert(selected.reasons.some((reason) => reason.rule === "unknown path"));
    validateSelection(selected);
  }
});

Deno.test("select-checks: malformed name-status fails; renames classify both paths without broadening", () => {
  const changes = parseNameStatus("R087\0server/leaf.ts\0client/leaf.js\0");
  assertEquals(changes, [
    { status: "R087", path: "server/leaf.ts", removed: true },
    { status: "R087", path: "client/leaf.js", removed: false },
  ]);
  const selected = selectChecks(changes, fixture());
  assertEquals(selected.serverTests, ["tests/leaf_test.ts"]);
  assertEquals(selected.clientTests, ["client/leaf.js"]);
  assertEquals(
    selectChecks(parseNameStatus("D\0client/gone.js\0"), fixture()).clientTests,
    ["client/gone.js"],
  );
  assertEquals(parseNameStatus(""), []);
  for (const text of ["bogus\0a.ts\0", "R100\0one\0", "M\0", "M\0\0"]) {
    assertThrows(() => parseNameStatus(text));
  }
});

Deno.test("select-checks: missing import analysis is a selection error", () => {
  const context = fixture();
  delete context.imports["tests/leaf_test.ts"];
  assertThrows(
    () => selectChecks([modified("server/leaf.ts")], context),
    Error,
    "missing direct imports",
  );
});

Deno.test("select-checks: malformed selections and CI-only gates fail closed", () => {
  const valid = select("server/leaf.ts");
  validateSelection(valid);
  for (
    const patch of [
      { version: 2 },
      { browser: "false" },
      { browser: true },
      { gates: [] },
      { gates: [...valid.gates, "build", "cold-load"] },
      { gates: [...valid.gates, "native"] },
      { gates: [...valid.gates, "unit-controls"] },
      { serverTests: [] },
      { serverTests: "all" },
      { clientTests: null },
      { timingTests: ["tests/timing/slow_test.ts"] },
      { contractTests: ["one\ntwo"] },
      { browserCases: ["alpha"] },
      { reasons: [] },
      { reasons: [{}] },
    ]
  ) {
    assertThrows(
      () => validateSelection({ ...valid, ...patch }),
      Error,
      "invalid selection",
    );
  }
});

Deno.test("select-checks: Deno resolves direct imports, ignores literal launch paths and fails on missing modules", async () => {
  const root = await Deno.makeTempDir({ prefix: "selector-imports-" });
  try {
    await Deno.mkdir(`${root}/tests`);
    await Deno.mkdir(`${root}/server`);
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ imports: { "@leaf": "./server/leaf.ts" } }),
    );
    await Deno.writeTextFile(
      `${root}/server/leaf.ts`,
      "export const leaf = 1;\n",
    );
    await Deno.writeTextFile(`${root}/server/main.ts`, 'import "./leaf.ts";\n');
    await Deno.writeTextFile(
      `${root}/tests/direct_test.ts`,
      'import "@leaf";\n',
    );
    await Deno.writeTextFile(
      `${root}/tests/boot_test.ts`,
      'const entry = new URL("../server/main.ts", import.meta.url);\n',
    );
    await Deno.writeTextFile(
      `${root}/tests/transitive_test.ts`,
      'import "../server/main.ts";\n',
    );
    const files = [
      "tests/direct_test.ts",
      "tests/boot_test.ts",
      "tests/transitive_test.ts",
      "server/leaf.ts",
      "server/main.ts",
    ];
    const changes = [modified("server/leaf.ts")];
    const context = await loadContext(root, files, changes);
    assertEquals(selectChecks(changes, context).serverTests, [
      "tests/direct_test.ts",
    ]);
    await Deno.writeTextFile(
      `${root}/tests/direct_test.ts`,
      'import "../missing.ts";\n',
    );
    await assertRejects(() => loadContext(root, files, changes), Error);
    // Static-only changes do not need import analysis at all.
    assertEquals(
      (await loadContext(root, files, [modified("deno.json")])).imports,
      {},
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
