// One child result per selected standalone harness; logs cannot grant success.
import { assert, childSucceeded } from "./test-outcomes.mjs";

export const SELECTION = [
  ["tour-chain"], ["test-vault"], ["theme"], ["surfaces"], ["code-tokens"],
  ["copy-button"], ["editor-modes"], ["wikilink-rename"], ["rename-twice"],
  ["client-driven-links"], ["edit-mode-url"], ["recent-files"], ["sidebar-refresh"],
  ["rename-options", "move"], ["rename-options", "relink"], ["rename-options", "none"],
  ["quick-switcher"], ["test-quality-geometry"],
  ["native-ownership-control"], ["native-actions-control"], ["button-icons"], ["save-preview"],
  ["line-wrap"], ["ctrl-f-search"], ["anchor-history"], ["setup-wizard"], ["setup-totp-desktop"],
  ["autosave-timer"], ["hub-safe-saves-native"], ["hub-writers-gate-native"], ["html-safety"], ["background-connections-native"],
];

// Argument variants are distinct cases (rename-options-move/relink/none).
export const caseName = selection => selection.join("-");

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
  "legacy-fixture.mjs", "fixtures.mjs", "harness-helpers.mjs", "http-origin.mjs",
  "cdp.mjs", "native-cdp-session.mjs", "native-actions.mjs",
  "native-clipboard.mjs", "test-outcomes.mjs", "native-consumer-controls.mjs",
  "native-result-controls.mjs", "unit-consumer-controls.mjs",
  "runner-entrypoint-controls.mjs",
].map(file => "client/tests/e2e/" + file);

export const FILE_CASES = Object.fromEntries([
  ...SHARED_CASE_FILES.map(file => [file, SELECTION.map(caseName)]),
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

export async function runChildren(selection, execute) {
  assert(selection.length > 0, "No required native cases selected");
  const outcomes = [];
  for (const [name, ...args] of selection) {
    const result = await execute(name, args, { timeout: CHILD_TIMEOUTS.get(name) ?? DEFAULT_CHILD_TIMEOUT });
    childSucceeded(result, [name, ...args].join(" "));
    outcomes.push({ name, args, code: result.code });
  }
  return outcomes;
}

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
  await Deno.stdout.write(result.stdout); await Deno.stderr.write(result.stderr);
  return result;
}

if (import.meta.main) {
  const selection = selectCases(Deno.env.get("GLOBNOTES_E2E_CASES"));
  const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-native-suite-" });
  await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const outcomes = await runChildren(selection, async (name, args, options) => {
    return executeChild(["run", "--cached-only", "--frozen", "--config=deno.json", "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys", new URL(name + ".mjs", import.meta.url).pathname, ...args], { ...options, artifacts, label: [name, ...args].join("-") });
  });
  await Deno.writeTextFile(artifacts + "/suite.json", JSON.stringify({ selection, outcomes }, null, 2), { createNew: true });
  console.log("NATIVE SUITE: all selected children completed successfully", artifacts);
}
