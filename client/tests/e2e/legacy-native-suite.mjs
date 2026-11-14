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
  ["conflict-inbox-native"], ["conflict-resolution-native"], ["conflict-review-native"],
  ["sync-settings-native"], ["sync-driver-native"], ["sync-status-native"], ["plugin-prefix-auth"],
  ...["s3", "webdav"].flatMap(backend => ["none", "openssl-base64", "rclone-base64"].map(codec => ["remotely-save-native", backend, codec])),
];

// Argument variants are distinct cases (rename-options-move/relink/none).
export const caseName = selection => selection.join("-");

// Exclusive cases drain the pool before admission and run alone. Contexts do
// not isolate the clipboard, target roster or browser activation/timing.
export const SERIAL_CASES = {
  "copy-button": "reads and restores the browser-global clipboard",
  "setup-totp-desktop": "reads and restores the browser-global clipboard",
  "native-ownership-control": "asserts preservation of the browser-global target roster",
  "background-connections-native": "changes browser activation to assert background visibility",
  "autosave-timer": "asserts real-time autosave budgets under continuous native input",
};

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
  "legacy-fixture.mjs", "fixtures.mjs", "harness-helpers.mjs", "harness-arguments.mjs", "http-origin.mjs",
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
  await Deno.writeTextFile(artifacts + "/" + label + ".exit.json", JSON.stringify({ code: result.code, success: result.success, signal: result.signal, timedOut }), { createNew: true });
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
  const concurrency = concurrencyValue(Deno.env.get("GLOBNOTES_E2E_CONCURRENCY"));
  const selection = selectCases(Deno.env.get("GLOBNOTES_E2E_CASES"));
  const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-native-suite-" });
  await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const outcomes = await runChildren(selection, async (name, args, options) => {
    const label = caseName([name, ...args]);
    const childArtifacts = artifacts + "/" + label;
    await Deno.mkdir(childArtifacts, { mode: 0o700 });
    return executeChild(["run", "--cached-only", "--frozen", "--config=deno.json", "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys", fileURLToPath(new URL(name + ".mjs", import.meta.url)), ...args], { ...options, artifacts: childArtifacts, label });
  }, { concurrency });
  const serial = Object.fromEntries(selection.map(caseName).filter(name => SERIAL_CASES[name]).map(name => [name, SERIAL_CASES[name]]));
  await Deno.writeTextFile(artifacts + "/suite.json", JSON.stringify({ selection, concurrency, serial, outcomes }, null, 2), { createNew: true });
  console.log("NATIVE SUITE: all selected children completed successfully", artifacts);
}
