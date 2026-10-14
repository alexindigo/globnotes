// Real child processes prove result propagation; old success words have no vote.
import { executeChild, runChildren } from "./legacy-native-suite.mjs";
import { assert } from "./test-outcomes.mjs";

const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-result-controls-" });
await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
const controls = [
  ["clipboard-marker", ["eval", "console.log('COPY BUTTON OK'); Deno.exit(1)"], false],
  ["rename-marker", ["eval", "console.log('TWO-STEP RENAME OK'); Deno.exit(1)"], false],
  ["theme-marker", ["eval", "console.log('ALL THEMES OK; distinct body backgrounds: 2'); Deno.exit(1)"], false],
  ["startup-missing", ["run", artifacts + "/missing-owned-driver.mjs"], false],
  ["timeout-exit-zero", ["eval", "Deno.addSignalListener('SIGTERM',()=>Deno.exit(0));console.log('listener ready');setInterval(()=>{},100)"], false],
  ["completed", ["eval", "console.log('actual completed control')"], true],
];
const outcomes = [];
for (const [name, args, expected] of controls) {
  const result = await executeChild(args, { artifacts, label: name, timeout: name === "timeout-exit-zero" ? 2000 : 15000 });
  let accepted = false;
  try { await runChildren([[name]], async () => result); accepted = true; }
  catch (error) { assert(!expected, `${name}: completed child rejected: ${error}`); }
  assert(accepted === expected, `${name}: incorrect suite acceptance`);
  if (name === "timeout-exit-zero") assert(result.code === 0 && result.timedOut, "Timeout control did not exercise zero-exit settlement");
  outcomes.push({ name, code: result.code, timedOut: result.timedOut, accepted });
}
await Deno.writeTextFile(artifacts + "/controls.json", JSON.stringify(outcomes, null, 2), { createNew: true });
console.log("Native child-result controls observed", JSON.stringify(outcomes));
