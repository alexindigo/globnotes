// SPDX-License-Identifier: LGPL-3.0-only

/** Fast pre-commit feedback on the staged tree. CI owns the full gate.
 * Server selection uses only each test's direct imports, never dependency
 * closures, launcher arguments, fixture literals or dynamic-loader guesses.
 * Explicit ownership families supplement those direct edges. Unknown paths
 * still get related tests; selection errors fail the hook.
 */
import { fromFileUrl, toFileUrl } from "@std/path";
import { guardModules } from "./guard-modules.ts";

export const STATIC_GATES = [
  "install",
  "lint",
  "check",
  "format",
  "worker",
  "handlers",
  "shell",
  "e2e-modules",
  "contracts",
] as const;
export const GATE_ORDER = [
  ...STATIC_GATES,
  "server",
  "timing",
  "client",
  "build",
  "native",
] as const;
export type Gate = typeof GATE_ORDER[number];

export const CONTRACT_TESTS = [
  "tests/test_isolation_contract_test.ts",
  "tests/devcontainer_caps_test.ts",
];

const CORE = [
  "shared/ownership.js",
  "shared/ownership.d.ts",
  "shared/ownership-engine.js",
  "tests/helpers/ownership_rules.ts",
  "tests/helpers/ownership_contract.ts",
  "tests/helpers/ownership_legacy.ts",
  "tests/helpers/ownership_legacy_sites.json",
  "tests/helpers/ownership_root_sites.json",
];
const SCOPE = [
  ...CORE,
  "tests/helpers/fixture_scope.ts",
  "tests/helpers/fixture_scope_engine.ts",
  "tests/helpers/fixture_coordination.ts",
];
/** The declared ownership pilots, not a transitive dependency walker.
 * All mapped owners are integrated: rows never disappear because an owner is
 * absent from the inventory.
 * Missing contracts and consumers fail rather than silently disappear.
 * Product owners P05-P10 retain their separate mapping follow-up. */
export const OWNERSHIP_SELECTION = {
  "shared/ownership.js": {
    inputs: [...CORE, "client/tests/e2e/native-case-finalization.mjs"],
    server: [
      "tests/ownership_scope_test.ts",
      "tests/ownership_resource_guard_test.ts",
      "tests/ownership_guard_test.ts",
      "tests/ownership_coverage_test.ts",
      "tests/ownership_erasure_test.ts",
      "tests/ownership_review_test.ts",
      "tests/native_finalization_ownership_test.ts",
    ],
    client: ["client/tests/e2e/native-case-finalization.test.js"],
    native: ["setup-wizard"],
  },
  "tests/helpers/fixture_scope.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/plugin_fixture.ts",
      "tests/helpers/plugin_fixture_engine.ts",
      "tests/helpers/plugin_operations_fixture.ts",
    ],
    server: [
      "tests/fixture_scope_test.ts",
      "tests/ownership_fixture_guard_test.ts",
      "tests/plugin_fixture_cleanup_test.ts",
      "tests/plugin_write_bases_test.ts",
    ],
    client: [],
    native: ["sync-status-native", "plugin-prefix-auth"],
  },
  "tests/helpers/owned_operation.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/owned_operation_families.json",
      "tests/helpers/owned_operation_legacy.json",
      "tests/helpers/product_settlement.ts",
      "tests/helpers/wait.ts",
    ],
    server: [
      "tests/owned_operation_test.ts",
      "tests/owned_operation_guard_test.ts",
      "tests/plugin_settings_schema_lease_test.ts",
    ],
    client: [],
    native: [],
  },
  "tests/helpers/owned_record_channel.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_record_channel.ts",
      "tests/helpers/record_schema.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
      "tests/helpers/sync_status_control.ts",
      "tests/helpers/sync_status_preload.ts",
      "tests/helpers/ownership_record_sites.json",
      "client/tests/e2e/sync-status-native.mjs",
      "client/tests/e2e/backup-plugin.mjs",
    ],
    server: [
      "tests/owned_record_channel_test.ts",
      "tests/ownership_record_guard_test.ts",
      "tests/process_records_test.ts",
      "tests/catalog_work_audit_test.ts",
    ],
    client: [],
    native: ["sync-driver-native", "sync-status-native", "backup-plugin"],
  },
  "tests/helpers/owned_child.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_child.ts",
      "tests/helpers/process.ts",
      "tests/helpers/process_values.ts",
      "tests/helpers/boot.ts",
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/ownership_child_sites.json",
      "client/tests/e2e/harness-helpers.mjs",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
    ],
    server: [
      "tests/owned_child_test.ts",
      "tests/ownership_child_guard_test.ts",
      "tests/server_lifetime_test.ts",
    ],
    client: ["client/tests/e2e/native-server-lifetime.test.js"],
    native: ["setup-wizard", "plugin-prefix-auth"],
  },
  "tests/helpers/driver_startup.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/owned_child.ts",
      "tests/helpers/boot.ts",
      "tests/helpers/owned_record_channel.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
      "tests/helpers/record_schema.ts",
      "tests/helpers/driver_startup.ts",
      "tests/helpers/driver_startup_preload.ts",
      "tests/helpers/driver_startup_protocol.ts",
      "tests/helpers/driver_startup_schema.ts",
      "tests/helpers/driver_fixture.ts",
      "tests/helpers/fixture_clock.ts",
      "tests/helpers/storage.ts",
      "server/hub/drivers/supervisor.ts",
    ],
    server: [
      "tests/driver_phase_ownership_test.ts",
      "tests/driver_phase_guard_test.ts",
      "tests/hub_driver_acceptance_test.ts",
      "tests/hub_driver_native_acceptance_test.ts",
      "tests/hub_driver_supervisor_test.ts",
    ],
    client: [],
    native: ["sync-settings-native", "sync-driver-native"],
  },
  "tests/helpers/fixture_clock.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_record_channel.ts",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
      "tests/helpers/fixture_clock.ts",
      "tests/helpers/fixture_clock_legacy.json",
      "tests/helpers/fixture_clock_rules.ts",
      "tests/helpers/fixture_epoch.ts",
      "tests/helpers/totp.ts",
      "tests/helpers/totp_live.ts",
      "tests/helpers/identity.ts",
      "tests/helpers/record_schema.ts",
      "tests/helpers/driver_fixture.ts",
      "client/tests/e2e/native-totp-fixture.mjs",
      "client/tests/e2e/harness-helpers.mjs",
      "client/tests/e2e/repair-fixture-lifetime.mjs",
      "client/tests/e2e/plugin-review-repairs.mjs",
      "client/tests/e2e/setup-totp-desktop.mjs",
      "client/tests/e2e/access-settings.mjs",
    ],
    server: [
      "tests/fixture_clock_ownership_test.ts",
      "tests/fixture_clock_guard_test.ts",
      "tests/totp_test.ts",
      "tests/native_totp_fixture_test.ts",
      "tests/access_settings_test.ts",
      "tests/auth_test.ts",
      "tests/local_auth_test.ts",
    ],
    client: [],
    native: [
      "setup-totp-desktop",
      "access-settings",
      "sync-driver-native",
      "plugin-review-repairs",
    ],
  },
  "tests/helpers/fixture_layout.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_child.ts",
      "tests/helpers/process.ts",
      "tests/helpers/boot.ts",
      "tests/helpers/fixture_layout.ts",
      "tests/helpers/process_values.ts",
      "tests/helpers/completed_build.ts",
      "tests/helpers/completed_build_engine.ts",
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "client/tests/e2e/prefix-auth-fixture.mjs",
      "tests/helpers/process_records.ts",
      "tests/helpers/record_publication.ts",
    ],
    server: [
      "tests/fixture_layout_ownership_test.ts",
      "tests/ownership_layout_guard_test.ts",
      "tests/config_paths_test.ts",
      "tests/config_owned_root_test.ts",
      "tests/server_lifetime_test.ts",
    ],
    client: [],
    native: ["setup-wizard", "plugin-prefix-auth"],
  },
  "tests/helpers/owned_contenders.ts": {
    inputs: [
      ...SCOPE,
      "tests/helpers/owned_operation.ts",
      "tests/helpers/owned_operation_contract.ts",
      "tests/helpers/owned_contenders.ts",
    ],
    server: [
      "tests/owned_contenders_test.ts",
      "tests/owned_contenders_guard_test.ts",
    ],
    client: [],
    native: [],
  },
  "scripts/select-checks.ts": {
    inputs: [
      "scripts/select-checks.ts",
      "scripts/gates.sh",
      "scripts/guard-modules.ts",
    ],
    server: [
      "tests/select_checks_test.ts",
      "tests/gate_selection_test.ts",
      "tests/contract_discovery_test.ts",
      "tests/ownership_guard_test.ts",
    ],
    client: [],
    native: [],
  },
};
export const OWNERSHIP_NATIVE_CONTROLS = [
  "native-consumer-controls",
  "native-result-controls",
  "runner-entrypoint-controls",
  "unit-consumer-controls",
];

/** Directory entries end with "/". These select static gates only. */
export const SHARED_INPUTS = [
  "deno.json",
  "deno.lock",
  "vite.config.js",
  "vitest.config.mjs",
  ".devcontainer/",
  "scripts/gates.sh",
  "scripts/select-checks.ts",
  "scripts/guard-modules.ts",
  "entrypoint.sh",
  "Dockerfile",
];

export const CONTROL_GATES = [
  "unit-controls",
  "native-results",
  "native-controls",
  "entrypoint-results",
] as const;
type ControlGate = typeof CONTROL_GATES[number];
export interface ControlSelection {
  version: 1;
  kind: "harness-controls";
  gates: ControlGate[];
  reasons: { path: string; selects: string }[];
}

// The single path-to-control owner. Prefixes end in "/". Controls run when
// their producer/consumer harness or its execution/toolchain inputs change.
const CONTROL_INPUTS: Record<ControlGate, string[]> = {
  "unit-controls": [
    "client/tests/e2e/unit-consumer-controls.mjs",
    "client/tests/e2e/test-outcomes.mjs",
    "client/keybindings/editor-keymap.js",
    "client/tests/keybinding-conflicts.test.js",
    "client/components/Modal.vue",
    "client/tests/modal.test.js",
    "client/sidebarTree.js",
    "client/tests/sidebar-hydration.test.js",
    "client/tests/setup.js",
  ],
  "native-results": [
    "client/tests/e2e/legacy-native-suite.mjs",
    "client/tests/e2e/test-outcomes.mjs",
    "client/tests/e2e/native-result-controls.mjs",
  ],
  "native-controls": ["client/tests/e2e/", "tests/helpers/"],
  "entrypoint-results": [
    "client/tests/e2e/run.sh",
    "client/tests/e2e/runner-entrypoint-controls.mjs",
  ],
};
const matchesInput = (path: string, input: string) =>
  input.endsWith("/") ? path.startsWith(input) : path === input;

export function selectHarnessControls(
  changes: Change[] | null,
  ref: string,
): ControlSelection {
  const full = changes === null
    ? "diff unavailable or malformed: fail safe"
    : /^refs\/tags\/v2(?:\.|$)/.test(ref)
    ? "v2 release tag"
    : !/^refs\/(heads|pull|tags)\//.test(ref)
    ? "ref unavailable: fail safe"
    : null;
  if (full) {
    return {
      version: 1,
      kind: "harness-controls",
      gates: [...CONTROL_GATES],
      reasons: [{ path: "*", selects: full }],
    };
  }
  const gates = new Set<ControlGate>();
  const reasons: ControlSelection["reasons"] = [];
  for (const change of changes!) {
    const shared = [
      ...SHARED_INPUTS,
      ".github/workflows/",
      ".githooks/",
      "scripts/",
    ].some((input) => matchesInput(change.path, input));
    const selected = CONTROL_GATES.filter((gate) =>
      shared ||
      CONTROL_INPUTS[gate].some((input) => matchesInput(change.path, input))
    );
    for (const gate of selected) gates.add(gate);
    if (selected.length) {
      reasons.push({ path: change.path, selects: selected.join(", ") });
    }
  }
  if (!reasons.length) {
    reasons.push({ path: "*", selects: "no guarded harness inputs changed" });
  }
  return {
    version: 1,
    kind: "harness-controls",
    gates: CONTROL_GATES.filter((gate) => gates.has(gate)),
    reasons,
  };
}

export function validateControlSelection(
  value: unknown,
): asserts value is ControlSelection {
  const selection = value as ControlSelection | null;
  if (
    !selection || selection.version !== 1 ||
    selection.kind !== "harness-controls" ||
    !Array.isArray(selection.gates) ||
    new Set(selection.gates).size !== selection.gates.length ||
    selection.gates.some((gate) => !CONTROL_GATES.includes(gate)) ||
    !Array.isArray(selection.reasons) || !selection.reasons.length ||
    selection.reasons.some((reason) =>
      !reason || typeof reason.path !== "string" ||
      typeof reason.selects !== "string"
    )
  ) {
    throw new Error("invalid harness control selection");
  }
}

const TEST_FILE = /(^|\/)([^/]*[_.])?test\.(ts|tsx|mts|js|mjs|jsx)$/;
export interface Change {
  status: string;
  path: string;
  /** Deletion or rename source: still classify the old path. */
  removed: boolean;
}
export interface Context {
  files: string[];
  /** Test file -> resolved, direct, repository-local imports. */
  imports: Record<string, string[]>;
}
export interface Reason {
  path: string;
  status: string;
  rule: string;
  selects: string;
}
export interface Selection {
  version: 1;
  gates: Gate[];
  browser: boolean;
  contractTests: string[];
  serverTests: string[];
  timingTests: string[];
  /** Changed files passed to `vitest related`. */
  clientTests: string[];
  browserCases: string[];
  reasons: Reason[];
}

/** Parse `git diff --cached --name-status -M -z`. */
export function parseNameStatus(text: string): Change[] {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^[ACDMRTUX]\d*$/.test(status)) {
      throw new Error(
        `unexpected name-status field: ${JSON.stringify(status)}`,
      );
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const [from, to] = [fields[i++], fields[i++]];
      if (!from || !to) throw new Error("truncated name-status input");
      changes.push({ status, path: from, removed: kind === "R" });
      changes.push({ status, path: to, removed: false });
    } else {
      const path = fields[i++];
      if (!path) throw new Error("truncated name-status input");
      changes.push({ status, path, removed: kind === "D" });
    }
  }
  return changes;
}

function isTimingPath(path: string): boolean {
  return path.startsWith("tests/timing/");
}
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}
function isServerTest(path: string): boolean {
  return path.startsWith("tests/") && !isTimingPath(path) && isTestFile(path);
}
function isDocs(path: string): boolean {
  return path.endsWith(".md") || path.startsWith("docs/");
}
function isSharedInput(path: string): boolean {
  return SHARED_INPUTS.some((input) =>
    input.endsWith("/") ? path.startsWith(input) : path === input
  );
}

export function selectChecks(changes: Change[], context: Context): Selection {
  const tracked = new Set(context.files);
  const serverTests = context.files.filter(isServerTest);
  const server = new Set<string>();
  const timing = new Set<string>();
  const client = new Set<string>();
  const native = new Set<string>();
  const reasons: Reason[] = [{
    path: "*",
    status: "",
    rule: "always",
    selects: "whole-tree static gates, contract tests and e2e module-load gate",
  }];
  const note = (change: Change, rule: string, selects: string) =>
    reasons.push({ path: change.path, status: change.status, rule, selects });

  for (const change of changes) {
    const path = change.path;
    for (const [owner, family] of Object.entries(OWNERSHIP_SELECTION)) {
      if (!family.inputs.includes(path)) continue;
      for (const test of [...family.server, ...family.client]) {
        if (!tracked.has(test)) {
          throw new Error(
            `ownership selection ${owner}: missing consumer ${test}`,
          );
        }
      }
      for (const name of family.native) {
        if (!tracked.has(`client/tests/e2e/${name}.mjs`)) {
          throw new Error(
            `ownership selection ${owner}: missing native consumer ${name}`,
          );
        }
        native.add(name);
      }
      for (const test of family.server) server.add(test);
      for (const test of family.client) client.add(test);
      note(
        change,
        `ownership:${owner}`,
        `server: ${family.server.join(", ")}; client: ${
          family.client.join(", ")
        }; native: ${family.native.join(", ")}`,
      );
    }
    if (isDocs(path)) {
      note(change, "docs", "static gates only");
      continue;
    }
    if (isSharedInput(path)) {
      note(
        change,
        "shared input",
        "static gates only, with deno install --frozen",
      );
      continue;
    }
    if (isTimingPath(path)) {
      if (isTestFile(path) && !change.removed && tracked.has(path)) {
        timing.add(path);
        note(change, "timing", "this changed timing test, serially");
      } else {
        note(
          change,
          "timing",
          "static gates only; no surviving timing test changed",
        );
      }
      continue;
    }

    const related = serverTests.filter((test) => {
      const imports = context.imports[test];
      if (!imports) throw new Error(`missing direct imports for ${test}`);
      return test === path || imports.includes(path);
    });
    for (const test of related) server.add(test);
    note(
      change,
      "direct imports",
      related.length
        ? `changed server tests or direct importers: ${related.join(", ")}`
        : "no changed server test or direct server-test importer",
    );

    if (path.startsWith("client/") || path.startsWith("shared/")) {
      client.add(path);
      note(change, "client/shared", "vitest related");
    } else if (!path.startsWith("server/") && !path.startsWith("tests/")) {
      client.add(path);
      note(
        change,
        "unknown path",
        "static gates plus direct server importers and vitest related",
      );
    }
  }
  reasons.push({
    path: "*",
    status: "",
    rule: "scope",
    selects:
      "explicit ownership families add completed builds and selected native consumers; otherwise CI owns browser/build/cold-load; timing tests require a changed test",
  });
  const gates = new Set<Gate>(STATIC_GATES);
  if (server.size) gates.add("server");
  if (timing.size) gates.add("timing");
  if (client.size) gates.add("client");
  if (native.size) {
    gates.add("build");
    gates.add("native");
    for (const name of OWNERSHIP_NATIVE_CONTROLS) {
      // A required control is a mapped consumer too: absence fails closed.
      if (!tracked.has(`client/tests/e2e/${name}.mjs`)) {
        throw new Error(`ownership selection: missing native control ${name}`);
      }
      native.add(name);
    }
  }
  return {
    version: 1,
    gates: GATE_ORDER.filter((gate) => gates.has(gate)),
    browser: native.size > 0,
    contractTests: [
      ...CONTRACT_TESTS.filter((test) => tracked.has(test)),
      ...guardModules(context.files),
    ],
    serverTests: serverTests.filter((test) => server.has(test)),
    timingTests: [...timing].sort(),
    clientTests: [...client].sort(),
    browserCases: [...native].sort(),
    reasons,
  };
}

interface InfoModule {
  specifier: string;
  error?: string;
  dependencies?: {
    code?: { specifier?: string };
    type?: { specifier?: string };
  }[];
}

/** Resolve imports with Deno, but retain only the edges out of test files.
 * The graph's transitive modules are never used to select tests.
 */
export async function loadContext(
  root: string,
  files: string[],
  changes: Change[],
): Promise<Context> {
  const context: Context = { files, imports: {} };
  if (
    changes.every((change) =>
      isDocs(change.path) || isSharedInput(change.path) ||
      isTimingPath(change.path)
    )
  ) return context;
  const tests = files.filter(isServerTest);
  if (!tests.length) return context;
  const rootUrl = toFileUrl(root.endsWith("/") ? root : root + "/");
  const toUrl = (file: string) =>
    new URL(file.split("/").map(encodeURIComponent).join("/"), rootUrl);
  const entry = await Deno.makeTempFile({
    prefix: "select-checks-",
    suffix: ".ts",
  });
  try {
    await Deno.writeTextFile(
      entry,
      tests.map((file) => `import ${JSON.stringify(toUrl(file).href)};\n`).join(
        "",
      ),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", `--config=${root}/deno.json`, entry],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `deno info failed: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    const info = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      modules: InfoModule[];
    };
    const relative = (specifier?: string) => {
      if (!specifier?.startsWith(rootUrl.href)) return undefined;
      return fromFileUrl(specifier).slice(fromFileUrl(rootUrl).length);
    };
    for (const module of info.modules) {
      if (module.error) throw new Error(`${module.specifier}: ${module.error}`);
      const path = relative(module.specifier);
      if (!path || !isServerTest(path)) continue;
      const imports = new Set<string>();
      for (const dependency of module.dependencies ?? []) {
        for (
          const target of [
            dependency.code?.specifier,
            dependency.type?.specifier,
          ]
        ) {
          const resolved = relative(target);
          if (resolved) imports.add(resolved);
        }
      }
      context.imports[path] = [...imports].sort();
    }
    for (const test of tests) {
      if (!context.imports[test]) throw new Error(`deno info omitted ${test}`);
    }
    return context;
  } finally {
    await Deno.remove(entry);
  }
}

/** Reject malformed selections before any selected workload runs. */
export function validateSelection(value: unknown): asserts value is Selection {
  const fail = (detail: string): never => {
    throw new Error(`invalid selection: ${detail}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("expected an object");
  }
  const selection = value as Record<string, unknown>;
  if (selection.version !== 1) fail("unsupported version");
  const strings = (name: string): string[] => {
    const list = selection[name];
    if (
      !Array.isArray(list) ||
      list.some((item) =>
        typeof item !== "string" || !item || /[\r\n\0]/.test(item)
      )
    ) fail(`${name} must be a list of nonempty lines`);
    return list as string[];
  };
  const gates = strings("gates");
  if (
    gates.some((gate) => !GATE_ORDER.includes(gate as Gate)) ||
    new Set(gates).size !== gates.length ||
    STATIC_GATES.some((gate) => !gates.includes(gate))
  ) fail("unknown, repeated or missing static gates");
  const cases = strings("browserCases"), hasNative = cases.length > 0;
  if (
    selection.browser !== hasNative || gates.includes("native") !== hasNative ||
    gates.includes("build") !== hasNative ||
    new Set(cases).size !== cases.length ||
    cases.some((name) => !/^[a-z0-9-]+$/.test(name)) ||
    (hasNative &&
      OWNERSHIP_NATIVE_CONTROLS.some((name) => !cases.includes(name)))
  ) {
    fail("native cases, build, browser or required controls disagree");
  }
  strings("contractTests");
  for (
    const [field, gate] of [
      ["serverTests", "server"],
      ["timingTests", "timing"],
      ["clientTests", "client"],
    ]
  ) {
    if (gates.includes(gate) !== (strings(field).length > 0)) {
      fail(`${field} disagrees with gates`);
    }
  }
  if (!Array.isArray(selection.reasons) || !selection.reasons.length) {
    fail("missing reasons");
  }
  for (const reason of selection.reasons as Record<string, unknown>[]) {
    if (
      !reason ||
      ["path", "status", "rule", "selects"].some((key) =>
        typeof reason[key] !== "string"
      )
    ) fail("malformed reason");
  }
}

function printField(selection: Selection, field: string): void {
  const value = (selection as unknown as Record<string, unknown>)[field];
  if (!Object.hasOwn(selection, field) || value === undefined) {
    throw new Error(`unknown selection field: ${field}`);
  }
  for (const item of Array.isArray(value) ? value : [value]) {
    console.log(String(item));
  }
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "--ci-controls" && args.length === 3) {
    let changes: Change[] | null = null;
    try {
      changes = parseNameStatus(await Deno.readTextFile(args[1]));
    } catch (error) {
      console.error(`CI control diff unavailable: ${error}`);
    }
    console.log(
      JSON.stringify(selectHarnessControls(changes, args[2]), null, 2),
    );
    return;
  }
  if (args[0] === "--control-field" && args.length === 2) {
    const selection: unknown = JSON.parse(await Deno.readTextFile(args[1]));
    validateControlSelection(selection);
    for (const gate of selection.gates) console.log(gate);
    return;
  }
  if (args[0] === "--field" && args.length === 3) {
    const selection: unknown = JSON.parse(await Deno.readTextFile(args[1]));
    validateSelection(selection);
    return printField(selection, args[2]);
  }
  if (args.length !== 4 || args[0] !== "--staged" || args[2] !== "--files") {
    throw new Error(
      "usage: select-checks.ts --staged NAME-STATUS-Z --files LS-TREE-Z | --field SELECTION FIELD",
    );
  }
  const changes = parseNameStatus(await Deno.readTextFile(args[1]));
  const files = (await Deno.readTextFile(args[3])).split("\0").filter(Boolean);
  const selection = selectChecks(
    changes,
    await loadContext(Deno.cwd(), files, changes),
  );
  validateSelection(selection);
  console.log(JSON.stringify(selection, null, 2));
}

if (import.meta.main) await main(Deno.args);
