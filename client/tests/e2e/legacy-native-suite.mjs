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
];

export async function runChildren(selection, execute) {
  assert(selection.length > 0, "No required native cases selected");
  const outcomes = [];
  for (const [name, ...args] of selection) {
    const result = await execute(name, args);
    childSucceeded(result, [name, ...args].join(" "));
    outcomes.push({ name, args, code: result.code });
  }
  return outcomes;
}

export async function executeChild(args, { artifacts, label, timeout = 120000 }) {
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
  const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-native-suite-" });
  await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const outcomes = await runChildren(SELECTION, async (name, args) => {
    return executeChild(["run", "--cached-only", "--frozen", "--config=deno.json", "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys", new URL(name + ".mjs", import.meta.url).pathname, ...args], { artifacts, label: [name, ...args].join("-") });
  });
  await Deno.writeTextFile(artifacts + "/suite.json", JSON.stringify({ selection: SELECTION, outcomes }, null, 2), { createNew: true });
  console.log("NATIVE SUITE: all selected children completed successfully", artifacts);
}
