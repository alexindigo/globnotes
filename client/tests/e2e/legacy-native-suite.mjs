// One child result per selected standalone harness; logs cannot grant success.
import { assert, childSucceeded } from "./test-outcomes.mjs";
import { fileURLToPath } from "node:url";
import { prefixAuthSelection } from "./prefix-auth-cases.mjs";
import { reviewRepairSelection } from "./review-repair-cases.mjs";
import { MATRIX_CASES, nativeMatrixSelection } from "./native-fixture-cases.mjs";

export const SELECTION = [
  ["tour-chain"], ["test-vault"], ["theme"], ["surfaces"], ["code-tokens"],
  ["copy-button"], ["editor-modes"], ["wikilink-rename"], ["rename-twice"],
  ["client-driven-links"], ["edit-mode-url"], ["recent-files"], ["sidebar-refresh"],
  ["rename-options", "move"], ["rename-options", "relink"], ["rename-options", "none"],
  ["quick-switcher"], ["test-quality-geometry"],
  ["native-ownership-control"], ["native-actions-control"], ["button-icons"], ["save-preview"],
  ["line-wrap"], ["ctrl-f-search"], ["anchor-history"], ["setup-wizard"], ["setup-totp-desktop"], ["layered-config-native"],
  ["autosave-timer"], ["hub-safe-saves-native"], ["hub-writers-gate-native"], ["html-safety"], ["background-connections-native"], ["reauthentication-native"],
  ["conflict-inbox-native"], ["conflict-inbox-native", "narrow-status"], ["conflict-resolution-native"], ["conflict-review-native"],
  ["sync-settings-native"], ["sync-driver-native"], ["sync-status-native"], ...prefixAuthSelection(),
  ...["s3", "webdav"].flatMap(backend => ["none", "openssl-base64", "rclone-base64"].map(codec => ["remotely-save-native", backend, codec])),
  ["access-extra-states"], ...nativeMatrixSelection("access-settings"),
  ...nativeMatrixSelection("backup-plugin"), ["backup-plugin", "--case", "order"], ["backup-plugin", "--case", "preimage"], ["backup-plugin", "--controls"],
  ["generic-plugin-system"], ["note-naming"], ["note-save-fifo"], ["note-save-owner-guards"],
  ["plugin-guard-preservation"], ...nativeMatrixSelection("plugin-permissions"), ...reviewRepairSelection(),
  ["settings-design"], ["settings-foundations"], ...nativeMatrixSelection("settings-ui"),
  ["native-consumer-controls"], ["native-result-controls"], ["runner-entrypoint-controls"], ["unit-consumer-controls"],
];

// Export-only helpers/fixtures are not executable browser cases. This explicit
// classification is checked against the directory; unknown files fail closed.
export const NATIVE_HELPERS = {
  "access-lock-controls-native.mjs": "Access scenario helper",
  "cdp.mjs": "browser transport adapter",
  "config-fixture.mjs": "test-owned per-vault metadata layout",
  "conflict-native-fixture.mjs": "conflict fixture",
  "driver-export-owner.mjs": "durable export observer",
  "fixtures.mjs": "fixture re-exports",
  "generic-platform-evidence.mjs": "acceptance evidence projection",
  "harness-arguments.mjs": "argument parser",
  "harness-helpers.mjs": "server fixture adapter",
  "http-origin.mjs": "ordinary HTTP origin adapter",
  "legacy-fixture.mjs": "shared application fixture",
  "legacy-native-cases.mjs": "shared case bodies",
  "legacy-native-suite.mjs": "suite orchestrator, not a recursive child",
  "native-actions.mjs": "native input adapter",
  "native-case-finalization.mjs": "case finalization helper",
  "native-response-gate.mjs": "owned native note response barriers",
  "native-matrix-cases.mjs": "shared matrix argument and leaf selection owner",
  "native-fixture-cases.mjs": "canonical consumer-fixture inventory",
  "native-cdp-session.mjs": "owned browser session adapter",
  "native-clipboard.mjs": "owned clipboard adapter",
  "native-color-picker.mjs": "native picker adapter",
  "prefix-auth-fixture.mjs": "prefix/auth production fixture",
  "prefix-auth-cases.mjs": "prefix/auth fixture identities and CLI admission",
  "remotely-save-fixture.mjs": "interoperability fixture",
  "review-repair-cases.mjs": "review repair fixture identities and CLI admission",
  "settings-access-native.mjs": "Access summary helper",
  "settings-appearance-native.mjs": "Appearance scenario helper",
  "settings-cross-browser-native.mjs": "cross-browser Settings scenarios",
  "settings-editor-native.mjs": "Settings/editor scenarios",
  "settings-fields-native.mjs": "declarative field scenarios",
  "settings-frame-native.mjs": "Settings frame geometry assertions",
  "settings-geometry-native.mjs": "Settings geometry scenarios",
  "settings-inline-native.mjs": "inline Settings scenarios",
  "settings-inventory-native.mjs": "inventory policy settlement helper",
  "settings-menu-native.mjs": "Settings/menu scenarios",
  "settings-pending-native.mjs": "pending Settings scenarios",
  "settings-primitives-native.mjs": "shared primitive scenarios",
  "settings-restart-fixture.mjs": "Settings restart fixture",
  "settings-surfaces-native.mjs": "Settings surface matrix",
  "sync-native-fixture.mjs": "sync fixture",
  "test-outcomes.mjs": "consumer assertions",
};

export function validateNativeInventory(files, selection = SELECTION) {
  const inventory = new Set(files.filter(file => /\.(?:mjs|cjs|js|ts)$/.test(file) && !file.endsWith(".test.js")));
  const selected = new Set(selection.map(([name]) => name + ".mjs"));
  const helpers = Object.keys(NATIVE_HELPERS);
  const missing = [...inventory].filter(file => !selected.has(file) && !Object.hasOwn(NATIVE_HELPERS, file));
  const absent = [...selected, ...helpers].filter(file => !inventory.has(file));
  const overlap = helpers.filter(file => selected.has(file));
  assert(!missing.length, `Native cases outside CI selection: ${missing.join(", ")}`);
  assert(!absent.length, `Native inventory names absent files: ${absent.join(", ")}`);
  assert(!overlap.length, `Native helpers selected as cases: ${overlap.join(", ")}`);
  const names = selection.map(caseName);
  assert(new Set(names).size === names.length, "Duplicate native cases selected");
}

const ARTIFACT_ARGUMENT_CASES = new Set([
  "access-extra-states", "access-settings", "backup-plugin", "generic-plugin-system",
  "note-save-fifo", "note-save-owner-guards", "plugin-guard-preservation", "plugin-permissions",
  "plugin-review-repairs", "settings-design", "settings-foundations", "settings-ui",
]);
export function nativeChildArguments(name, args, artifacts) {
  const selected = !args.length && MATRIX_CASES[name] ? ["--variant", MATRIX_CASES[name][0].label] : args;
  return ARTIFACT_ARGUMENT_CASES.has(name) ? [...selected, "--artifacts", artifacts + "/consumers"] : selected;
}

// Argument variants are distinct cases (rename-options-move/relink/none).
export const caseName = selection => selection.join("-");

// CI run 43620052763: successful child exit.json durationMs, rounded up.
// Cases not admitted before failure retain the previous measured duration x1.5
// (the observed whole-shard CI slowdown), not a fabricated CI measurement.
// Prefix leaves use CI fixture wire spans +3s startup/closure estimate; the
// unfinished notes read_only/setup leaves use their empty-prefix counterparts.
export const CASE_DURATION_MS = {
  "layered-config-native": 25113,
  "tour-chain": 45776,
  "test-vault": 43354,
  "theme": 45026,
  "surfaces": 17777,
  "code-tokens": 15577,
  "copy-button": 7444,
  "editor-modes": 8052,
  "wikilink-rename": 12008,
  "rename-twice": 16531,
  "client-driven-links": 9064,
  "edit-mode-url": 69504,
  "recent-files": 9950,
  "sidebar-refresh": 7426,
  "rename-options-move": 11105,
  "rename-options-relink": 10905,
  "rename-options-none": 9437,
  "quick-switcher": 9888,
  "test-quality-geometry": 55024,
  "native-ownership-control": 10901,
  "native-actions-control": 2675,
  "button-icons": 68577,
  "save-preview": 71876,
  "line-wrap": 9820,
  "ctrl-f-search": 14711,
  "anchor-history": 68015,
  "setup-wizard": 40500,
  "setup-totp-desktop": 28763,
  "autosave-timer": 188110,
  "hub-safe-saves-native": 24899,
  "hub-writers-gate-native": 6688,
  "html-safety": 10104,
  "background-connections-native": 18381,
  "reauthentication-native": 21334,
  "conflict-inbox-native": 25671,
  "conflict-inbox-native-narrow-status": 31802,
  "conflict-resolution-native": 30002,
  "conflict-review-native": 102466,
  "sync-settings-native": 74928,
  "sync-driver-native": 27029,
  "sync-status-native": 23508,
  "plugin-prefix-auth": 35059,
  "plugin-prefix-auth---variant-empty-none": 15181,
  "plugin-prefix-auth---variant-empty-read-only": 11649,
  "plugin-prefix-auth---variant-empty-setup": 3354,
  "plugin-prefix-auth---variant-notes-password": 36296,
  "plugin-prefix-auth---variant-notes-none": 15743,
  "plugin-prefix-auth---variant-notes-read-only": 11649,
  "plugin-prefix-auth---variant-notes-setup": 3354,
  "remotely-save-native-s3-none": 35608,
  "remotely-save-native-s3-openssl-base64": 60223,
  "remotely-save-native-s3-rclone-base64": 45627,
  "remotely-save-native-webdav-none": 41443,
  "remotely-save-native-webdav-openssl-base64": 42892,
  "remotely-save-native-webdav-rclone-base64": 59450,
  "access-extra-states": 55671,
  // New leaf observations use one-CPU ownership->closure intervals plus 3s
  // startup/module overhead. Permissions remain explicitly estimated after
  // the old aggregate timed out; the numerical child bounds are unchanged.
  "access-settings": 6622,
  "access-settings---variant-totp-in-place": 12635,
  "access-settings---variant-public-lock": 13125,
  "access-settings---variant-protected-public-cancel": 9381,
  "access-settings---variant-protected-public-save": 9278,
  "access-settings---variant-current-totp-password": 11011,
  "access-settings---variant-lost-password-receipt": 16462,
  "access-settings---variant-replace-authenticator": 11743,
  "access-settings---variant-peer-policy": 22426,
  "access-settings---variant-initial-public-explicit-lock-prefixed": 6031,
  "access-settings---variant-protected-public-explicit-unlocked": 12658,
  "access-settings---variant-protected-enrolment-geometry": 35493,
  "access-settings---variant-protected-current-totp-geometry": 42660,
  "access-settings---variant-locked-controls": 26368,
  "access-settings---variant-pinned-credentials": 13896,
  // One-CPU retained count spans +6s fixture overhead; remaining fixture
  // observations/estimates retain every original production consumer.
  "backup-plugin": 27949,
  "backup-plugin---variant-count-2": 28087,
  "backup-plugin---variant-count-3": 36576,
  "backup-plugin---variant-count-4": 36735,
  "backup-plugin---variant-count-5": 48362,
  "backup-plugin---variant-count-6": 73061,
  "backup-plugin---variant-count-7": 103442,
  "backup-plugin---variant-count-8": 135318,
  "backup-plugin---variant-count-9": 157432,
  "backup-plugin---variant-count-10": 157089,
  "backup-plugin---variant-aliases": 55000,
  "backup-plugin---variant-location": 41000,
  "backup-plugin---variant-pin": 46000,
  "backup-plugin---variant-recovery": 23000,
  "backup-plugin---variant-cleanup": 25000,
  "backup-plugin---variant-distinct": 20000,
  "backup-plugin---variant-retarget": 25000,
  "backup-plugin---variant-failure": 35000,
  "backup-plugin---variant-settings-lock": 15000,
  "backup-plugin---case-order": 22730,
  "backup-plugin---case-preimage": 22089,
  "backup-plugin---controls": 555967,
  // CI aggregate 594245ms plus estimated extra per-leaf process startup.
  "generic-plugin-system": 650000,
  "note-naming": 4517,
  "note-save-fifo": 86972,
  "note-save-owner-guards": 73578,
  "plugin-guard-preservation": 20577,
  "plugin-permissions": 90000,
  "plugin-permissions---variant-isolated-import-parent": 35000,
  "plugin-permissions---variant-dirty-work": 65000,
  // Review fixtures observed making progress before the matrix's 120s kill;
  // split-cost estimates retain startup/closure headroom, not a wider deadline.
  "plugin-review-repairs": 30000,
  "plugin-review-repairs---variant-access-conflict": 35000,
  "plugin-review-repairs---variant-browser-ownership": 40000,
  "plugin-review-repairs---variant-descriptor-settlement": 25000,
  "plugin-review-repairs---variant-postponed-prompt": 15000,
  "settings-design": 692720,
  "settings-foundations": 216603,
  "settings-ui": 34139,
  "settings-ui---variant-cross-browser": 90478,
  "settings-ui---variant-pending-recovery": 24073,
  "settings-ui---variant-menu-parity": 26289,
  "settings-ui---variant-editor-source": 26728,
  "settings-ui---variant-editor-wysiwyg": 25685,
  "settings-ui---variant-geometry": 21999,
  "settings-ui---variant-open-dismiss": 9612,
  "settings-ui---variant-wizard-cancel": 9438,
  "settings-ui---variant-wizard-discard": 9251,
  "settings-ui---variant-wizard-save": 9686,
  "settings-ui---variant-wizard-blocked-save": 9369,
  "settings-ui---variant-logout-cancel": 8672,
  "settings-ui---variant-logout-discard": 7742,
  "settings-ui---variant-logout-save": 8601,
  "settings-ui---variant-logout-blocked-save": 8526,
  "native-consumer-controls": 299991,
  "native-result-controls": 3191,
  "runner-entrypoint-controls": 47,
  "unit-consumer-controls": 4353,
};

// Exclusive cases drain the pool before admission and run alone. Contexts do
// not isolate the clipboard, target roster or browser activation/timing.
export const SERIAL_CASES = {
  "copy-button": "reads and restores the browser-global clipboard",
  "setup-totp-desktop": "reads and restores the browser-global clipboard",
  "native-ownership-control": "asserts preservation of the browser-global target roster",
  "background-connections-native": "changes browser activation to assert background visibility",
  "autosave-timer": "asserts real-time autosave budgets under continuous native input",
  "access-extra-states": "reads and restores the browser-global clipboard",
  "native-consumer-controls": "negative copy consumers read and restore the browser-global clipboard",
};

export const NATIVE_SHARDS = ["1/3", "2/3", "3/3"];

export function parseShardArguments(args) {
  if (!args.length) return undefined;
  assert(args.length === 2 && args[0] === "--shard" && NATIVE_SHARDS.includes(args[1]), "Usage: native suite [--shard 1/3|2/3|3/3]");
  return args[1];
}

export function partitionCases(selection = SELECTION) {
  const loads = NATIVE_SHARDS.map(() => 0), assignment = new Map();
  const weight = item => {
    const name = caseName(item), duration = CASE_DURATION_MS[name];
    assert(Number.isFinite(duration) && duration > 0, `Missing measured native duration: ${name}`);
    // At CI concurrency 2, exclusive work occupies both slots.
    return duration * (SERIAL_CASES[name] ? 2 : 1);
  };
  const ordered = selection.map((item, index) => ({ item, index, weight: weight(item) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { item, weight: cost } of ordered) {
    const shard = loads.reduce((best, load, index) => load < loads[best] ? index : best, 0);
    assignment.set(caseName(item), shard); loads[shard] += cost;
  }
  // Group exclusive work so it cannot strand one parallel slot at each barrier.
  // Longest-first parallel admission avoids a large last child after the pool drains.
  return loads.map((_, shard) => selection.filter(item => assignment.get(caseName(item)) === shard)
    .sort((a, b) => Number(!!SERIAL_CASES[caseName(b)]) - Number(!!SERIAL_CASES[caseName(a)]) || weight(b) - weight(a)));
}

export function selectShard(selection, shard) {
  if (shard === undefined) return selection;
  parseShardArguments(["--shard", shard]);
  const admitted = new Set(selection.map(caseName));
  return partitionCases()[Number(shard[0]) - 1].filter(item => admitted.has(caseName(item)));
}

export function concurrencyValue(value = "3") {
  assert(/^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)), "Native concurrency must be a positive integer");
  return Number(value);
}

export const SHARED_CONTROL_CASES = ["native-ownership-control", "native-actions-control"];

export function selectCases(filter) {
  if (filter === undefined) return SELECTION;
  const requested = new Set(filter.split(",").map(name => name.trim()));
  assert(!requested.has(""), "No required native cases selected: empty case name");
  const known = new Set(SELECTION.map(caseName));
  for (const name of requested) assert(known.has(name), `Unknown native case: ${name}`);
  const selected = SELECTION.filter(selection => requested.has(caseName(selection)) ||
    MATRIX_CASES[selection[0]] && requested.has(selection[0]) || SHARED_CONTROL_CASES.includes(caseName(selection)));
  assert(selected.length > 0, "No required native cases selected");
  return selected;
}

// Repository-relative keys for select-checks.ts. Shared harness changes select
// all cases; each standalone driver selects its own case(s), including variants.
export const SHARED_CASE_FILES = [
  "legacy-native-suite.mjs", "run.sh", "legacy-native-cases.mjs",
  "legacy-fixture.mjs", "fixtures.mjs", "config-fixture.mjs", "harness-helpers.mjs", "harness-arguments.mjs", "http-origin.mjs",
  "cdp.mjs", "native-cdp-session.mjs", "native-actions.mjs",
  "native-case-finalization.mjs",
  "native-matrix-cases.mjs",
  "native-fixture-cases.mjs",
  "native-clipboard.mjs", "test-outcomes.mjs", "native-consumer-controls.mjs",
  "native-result-controls.mjs", "unit-consumer-controls.mjs",
  "runner-entrypoint-controls.mjs",
].map(file => "client/tests/e2e/" + file);

export const FILE_CASES = Object.fromEntries([
  ["client/tests/e2e/native-response-gate.mjs", [...nativeMatrixSelection("plugin-permissions"), ["note-save-fifo"], ["note-save-owner-guards"]].map(caseName)],
  ...SHARED_CASE_FILES.map(file => [file, SELECTION.map(caseName)]),
  ...["prefix-auth-fixture.mjs", "prefix-auth-cases.mjs"].map(file => [`client/tests/e2e/${file}`, prefixAuthSelection().map(caseName)]),
  ["client/tests/e2e/review-repair-cases.mjs", reviewRepairSelection().map(caseName)],
  ...[...new Set(SELECTION.map(([name]) => name))].map(name => [
    `client/tests/e2e/${name}.mjs`,
    SELECTION.filter(([driver]) => driver === name).map(caseName),
  ]),
]);

const DEFAULT_CHILD_TIMEOUT = 120000;
const CHILD_TIMEOUTS = new Map([
  // Deliberate real-time waits measured 118s normally / 156s at 50% CPU; allow shared-VM headroom.
  ["autosave-timer", 300000],
  // Previously standalone matrices exceed the 120s leaf-case default. The
  // saved sweep measured 146-238s; backup default 433s and generic aggregate 420s.
  ["access-settings", 600000], ["settings-foundations", 600000], ["settings-ui", 600000],
  ["native-consumer-controls", 600000], ["backup-plugin", 900000],
  ["generic-plugin-system", 900000], ["settings-design", 900000],
]);

export async function runChildren(selection, execute, { concurrency = 3 } = {}) {
  assert(selection.length > 0, "No required native cases selected");
  concurrency = concurrencyValue(concurrency);
  const outcomes = new Array(selection.length);
  const active = new Set();
  let failure;
  const start = index => {
    const [name, ...args] = selection[index];
    const task = (async () => {
      const result = await execute(name, args, { timeout: CHILD_TIMEOUTS.get(name) ?? DEFAULT_CHILD_TIMEOUT });
      childSucceeded(result, [name, ...args].join(" "));
      outcomes[index] = { name, args, code: result.code };
    })().catch(error => { failure ??= error; }).finally(() => active.delete(task));
    active.add(task);
  };
  for (const [index, item] of selection.entries()) {
    if (SERIAL_CASES[caseName(item)]) await Promise.all(active);
    while (active.size >= concurrency) await Promise.race(active);
    if (failure) break;
    start(index);
    if (SERIAL_CASES[caseName(item)]) await Promise.all(active);
  }
  await Promise.all(active);
  if (failure) throw failure;
  return outcomes;
}

// One critical section per completed child, including both buffered streams.
let printing = Promise.resolve();
export async function executeChild(args, { artifacts, label, timeout = DEFAULT_CHILD_TIMEOUT }) {
  assert(/^[a-z0-9-]+$/.test(label), "Invalid child evidence label");
  const started = performance.now();
  const child = new Deno.Command(Deno.execPath(), {
    args, env: { GLOBNOTES_E2E_ARTIFACTS: artifacts }, stdout: "piped", stderr: "piped",
  }).spawn();
  let timedOut = false, escalation;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* owned child already exited */ }
    escalation = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* owned child already exited */ }
    }, 5000);
  }, timeout);
  let output;
  try { output = await child.output(); }
  finally { clearTimeout(timer); clearTimeout(escalation); }
  const result = { ...output, timedOut };
  await Deno.writeFile(artifacts + "/" + label + ".stdout", result.stdout, { createNew: true });
  await Deno.writeFile(artifacts + "/" + label + ".stderr", result.stderr, { createNew: true });
  await Deno.writeTextFile(artifacts + "/" + label + ".exit.json", JSON.stringify({ code: result.code, success: result.success, signal: result.signal, timedOut, durationMs: performance.now() - started }), { createNew: true });
  const print = printing.then(async () => {
    console.log(`== native child ${label} (exit ${result.code}, timedOut=${timedOut})`);
    for (const [stream, bytes] of [[Deno.stdout, result.stdout], [Deno.stderr, result.stderr]]) {
      let offset = 0;
      while (offset < bytes.length) offset += await stream.write(bytes.subarray(offset));
    }
  });
  printing = print.catch(() => {});
  await print;
  return result;
}

if (import.meta.main) {
  const shard = parseShardArguments(Deno.args);
  const files = [];
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) if (entry.isFile) files.push(entry.name);
  validateNativeInventory(files);
  const concurrency = concurrencyValue(Deno.env.get("GLOBNOTES_E2E_CONCURRENCY"));
  const selection = selectShard(selectCases(Deno.env.get("GLOBNOTES_E2E_CASES")), shard);
  const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-native-suite-" });
  await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const outcomes = await runChildren(selection, async (name, args, options) => {
    const label = caseName([name, ...args]);
    const childArtifacts = artifacts + "/" + label;
    await Deno.mkdir(childArtifacts, { mode: 0o700 });
    return executeChild(["run", "--cached-only", "--frozen", "--config=deno.json", "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys", fileURLToPath(new URL(name + ".mjs", import.meta.url)), ...nativeChildArguments(name, args, childArtifacts)], { ...options, artifacts: childArtifacts, label });
  }, { concurrency });
  const serial = Object.fromEntries(selection.map(caseName).filter(name => SERIAL_CASES[name]).map(name => [name, SERIAL_CASES[name]]));
  await Deno.writeTextFile(artifacts + "/suite.json", JSON.stringify({ shard: shard ?? null, selection, concurrency, serial, outcomes }, null, 2), { createNew: true });
  console.log("NATIVE SUITE: all selected children completed successfully", artifacts);
}
