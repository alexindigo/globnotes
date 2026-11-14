// One child result per selected standalone harness; logs cannot grant success.
import { assert, childSucceeded } from "./test-outcomes.mjs";
import { fileURLToPath } from "node:url";

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
  ["sync-settings-native"], ["sync-driver-native"], ["sync-status-native"], ["plugin-prefix-auth"],
  ...["s3", "webdav"].flatMap(backend => ["none", "openssl-base64", "rclone-base64"].map(codec => ["remotely-save-native", backend, codec])),
  ["access-extra-states"], ["access-settings"],
  ["backup-plugin"], ["backup-plugin", "--case", "order"], ["backup-plugin", "--case", "preimage"], ["backup-plugin", "--controls"],
  ["generic-plugin-system"], ["note-naming"], ["note-save-fifo"], ["note-save-owner-guards"],
  ["plugin-guard-preservation"], ["plugin-permissions"], ["plugin-review-repairs"],
  ["settings-design"], ["settings-foundations"], ["settings-ui"],
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
  "native-cdp-session.mjs": "owned browser session adapter",
  "native-clipboard.mjs": "owned clipboard adapter",
  "native-color-picker.mjs": "native picker adapter",
  "prefix-auth-fixture.mjs": "prefix/auth production fixture",
  "remotely-save-fixture.mjs": "interoperability fixture",
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
export const nativeChildArguments = (name, args, artifacts) => ARTIFACT_ARGUMENT_CASES.has(name)
  ? [...args, "--artifacts", artifacts + "/consumers"] : args;

// Argument variants are distinct cases (rename-options-move/relink/none).
export const caseName = selection => selection.join("-");

// Milliseconds recovered from the complete 67-case run, staged tree
// 1fb54e69d6566a622a27baf1698bb78f1245ea36, at concurrency 2 on Ark.
// Each value is child artifact directory birth time -> exit.json birth time
// (filesystem nanosecond timestamps, rounded to ms), including runner overhead.
export const CASE_DURATION_MS = {
  // Added by main's config cutover; isolated native measurement on 5068758.
  "layered-config-native": 13122,
  "tour-chain": 19573,
  "test-vault": 16101,
  "theme": 15642,
  "surfaces": 5790,
  "code-tokens": 6526,
  "copy-button": 3187,
  "editor-modes": 4831,
  "wikilink-rename": 6093,
  "rename-twice": 8536,
  "client-driven-links": 5091,
  "edit-mode-url": 25436,
  "recent-files": 4161,
  "sidebar-refresh": 2706,
  "rename-options-move": 5281,
  "rename-options-relink": 4918,
  "rename-options-none": 4997,
  "quick-switcher": 4488,
  "test-quality-geometry": 26244,
  "native-ownership-control": 4121,
  "native-actions-control": 2134,
  "button-icons": 29374,
  "save-preview": 34116,
  "line-wrap": 5036,
  "ctrl-f-search": 8268,
  "anchor-history": 22570,
  "setup-wizard": 20672,
  "setup-totp-desktop": 24993,
  "autosave-timer": 131456,
  "hub-safe-saves-native": 14094,
  "hub-writers-gate-native": 4174,
  "html-safety": 5551,
  "background-connections-native": 15069,
  "reauthentication-native": 11845,
  "conflict-inbox-native": 17587,
  "conflict-inbox-native-narrow-status": 17542,
  "conflict-resolution-native": 14162,
  "conflict-review-native": 87878,
  "sync-settings-native": 25974,
  "sync-driver-native": 15040,
  "sync-status-native": 10901,
  "plugin-prefix-auth": 66483,
  "remotely-save-native-s3-none": 21554,
  "remotely-save-native-s3-openssl-base64": 27082,
  "remotely-save-native-s3-rclone-base64": 28810,
  "remotely-save-native-webdav-none": 25647,
  "remotely-save-native-webdav-openssl-base64": 24461,
  "remotely-save-native-webdav-rclone-base64": 31566,
  "access-extra-states": 37114,
  "access-settings": 155696,
  "backup-plugin": 427354,
  "backup-plugin---case-order": 15153,
  "backup-plugin---case-preimage": 14726,
  "backup-plugin---controls": 249848,
  "generic-plugin-system": 439169,
  "note-naming": 3011,
  "note-save-fifo": 57981,
  "note-save-owner-guards": 49052,
  "plugin-guard-preservation": 13718,
  "plugin-permissions": 68437,
  "plugin-review-repairs": 89905,
  "settings-design": 461813,
  "settings-foundations": 144402,
  "settings-ui": 185883,
  "native-consumer-controls": 199994,
  "native-result-controls": 2127,
  "runner-entrypoint-controls": 31,
  "unit-consumer-controls": 2902,
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

export function parseShardArguments(args) {
  if (!args.length) return undefined;
  assert(args.length === 2 && args[0] === "--shard" && ["1/2", "2/2"].includes(args[1]), "Usage: native suite [--shard 1/2|2/2]");
  return args[1];
}

export function partitionCases(selection = SELECTION) {
  const loads = [0, 0], assignment = new Map();
  const weight = item => {
    const name = caseName(item), duration = CASE_DURATION_MS[name];
    assert(Number.isFinite(duration) && duration > 0, `Missing measured native duration: ${name}`);
    // At CI concurrency 2, exclusive work occupies both slots.
    return duration * (SERIAL_CASES[name] ? 2 : 1);
  };
  const ordered = selection.map((item, index) => ({ item, index, weight: weight(item) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { item, weight: cost } of ordered) {
    const shard = loads[0] <= loads[1] ? 0 : 1;
    assignment.set(caseName(item), shard); loads[shard] += cost;
  }
  // Keep the original suite order and its exclusive-case admission semantics.
  return loads.map((_, shard) => selection.filter(item => assignment.get(caseName(item)) === shard));
}

export function selectShard(selection, shard) {
  if (shard === undefined) return selection;
  parseShardArguments(["--shard", shard]);
  const admitted = new Set(partitionCases()[Number(shard[0]) - 1].map(caseName));
  return selection.filter(item => admitted.has(caseName(item)));
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
  const selected = SELECTION.filter(selection => requested.has(caseName(selection)) || SHARED_CONTROL_CASES.includes(caseName(selection)));
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
  "native-clipboard.mjs", "test-outcomes.mjs", "native-consumer-controls.mjs",
  "native-result-controls.mjs", "unit-consumer-controls.mjs",
  "runner-entrypoint-controls.mjs",
].map(file => "client/tests/e2e/" + file);

export const FILE_CASES = Object.fromEntries([
  ...SHARED_CASE_FILES.map(file => [file, SELECTION.map(caseName)]),
  ["client/tests/e2e/prefix-auth-fixture.mjs", ["plugin-prefix-auth"]],
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
