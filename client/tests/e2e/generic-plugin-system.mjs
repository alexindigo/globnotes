// Strict production-only acceptance: real native drivers and end-chain records.
import { parseArguments } from "./harness-helpers.mjs";
import { fileURLToPath } from "node:url";
import { collectProductionRows } from "./generic-platform-evidence.mjs";
import { MATRIX_CASES, collectFixtureReports, retainFixtureReport } from "./native-fixture-cases.mjs";

let options;
try { options = parseArguments(Deno.args); }
catch (error) { console.error(error.message); Deno.exit(2); }
if (options.help) { console.log("Usage: generic-plugin-system.mjs [--artifacts <directory>] [--help]"); Deno.exit(0); }
const artifacts = options.artifacts ?? await Deno.makeTempDir({ prefix: "generic-production-acceptance-" });
if (options.artifacts) await Deno.mkdir(artifacts, { mode: 0o700 });
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const flags = ["--cached-only", "--frozen", `--config=${ROOT}/deno.json`, "--unstable-worker-options", "--allow-read", "--allow-write", "--allow-net", "--allow-run", "--allow-env", "--allow-sys"];
const drivers = [["settings", "settings-ui.mjs"], ["guards", "plugin-guard-preservation.mjs"], ["prefix", "plugin-prefix-auth.mjs"], ["access", "access-settings.mjs"]];
const results = [];
let failure;
async function run(name, entry, variant) {
  const label = variant ? `${name}-${variant}` : name;
  const child = new Deno.Command(Deno.execPath(), { args: ["run", ...flags, `${ROOT}/client/tests/e2e/${entry}`, "--artifacts", `${artifacts}/${name}`, ...(variant ? ["--variant", variant] : [])], cwd: ROOT, stdout: "piped", stderr: "piped" }).spawn();
  await Deno.writeTextFile(`${artifacts}/${label}-child.json`, JSON.stringify({ name, variant, pid: child.pid, entry, root: ROOT }), { createNew: true });
  const drains = ["stdout", "stderr"].map(async stream => {
    const file = await Deno.open(`${artifacts}/${label}-${stream}.log`, { createNew: true, write: true });
    try {
      for await (const chunk of child[stream]) {
        let offset = 0; while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
        offset = 0; while (offset < chunk.length) offset += await Deno[stream].write(chunk.subarray(offset));
      }
    } finally { file.close(); }
  });
  let timer;
  try {
    const status = await Promise.race([child.status, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${name}: whole-driver deadline`)), 300000); })]);
    await Promise.all(drains);
    results.push({ name, variant, ...status });
    if (!status.success) throw Error(`${name}: native driver failed with ${status.code}`);
  } catch (error) {
    try { child.kill("SIGTERM"); } catch { /* exact owned child already exited */ }
    let stopTimer;
    const stopped = await Promise.race([child.status, new Promise(resolve => { stopTimer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(stopTimer);
    if (!stopped) { try { child.kill("SIGKILL"); } catch { /* already exited */ } await child.status; }
    await Promise.all(drains);
    throw error;
  } finally { clearTimeout(timer); }
}
try {
  for (const [name, entry] of drivers) {
    const cases = MATRIX_CASES[entry.replace(/\.mjs$/, "")];
    if (!cases) { await run(name, entry); continue; }
    const projection = await collectFixtureReports(entry.replace(/\.mjs$/, ""), async item => {
      await run(name, entry, item.label);
      return await retainFixtureReport(`${name}/diagnostics.json`, `${name}-${item.label}-result.json`, {
        read: path => Deno.readTextFile(`${artifacts}/${path}`),
        write: (path, raw, options) => Deno.writeTextFile(`${artifacts}/${path}`, raw, options),
        remove: path => Deno.remove(`${artifacts}/${path}`),
      });
    });
    await Deno.writeTextFile(`${artifacts}/${name}/diagnostics.json`, JSON.stringify(projection, null, 2), { createNew: true });
  }
  const rows = await collectProductionRows(async path => JSON.parse(await Deno.readTextFile(`${artifacts}/${path}`)));
  await Deno.writeTextFile(`${artifacts}/acceptance.json`, JSON.stringify({ root: ROOT, drivers: results, rows, userCancelledDevScope: true, spatialReviewRequired: true }, null, 2), { createNew: true });
  for (const row of rows) console.log(row.marker);
  console.log("GENERIC PLUGIN SYSTEM OK (11 production rows; dev scope cancelled by user)");
} catch (error) { failure = error; console.error(`GENERIC PLUGIN SYSTEM FAILED: ${error.stack ?? error}`); }
await Deno.writeTextFile(`${artifacts}/runner-diagnostics.json`, JSON.stringify({ root: ROOT, drivers: results, failure: failure?.message, generatedFilesRetained: true }, null, 2), { createNew: true });
if (failure) throw failure;
