// The actual shell entrypoint must preserve its delegated process's status.
import { assert } from "./test-outcomes.mjs";
const root = new URL("../../..", import.meta.url).pathname;
const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-entrypoint-controls-" });
await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
const outcomes = [];
for (const [label, code, message] of [["misleading-success", 1, "ALL THEMES OK; COPY BUTTON OK; TWO-STEP RENAME OK"], ["completed", 0, "actual process completed"]]) {
  const executable = artifacts + "/" + label + ".sh";
  await Deno.writeTextFile(executable, `#!/bin/sh\nprintf '%s\\n' '${message}'\nexit ${code}\n`, { createNew: true, mode: 0o700 });
  const result = await new Deno.Command("sh", { args: [root + "/client/tests/e2e/run.sh"], env: { DENO: executable }, stdout: "piped", stderr: "piped" }).output();
  await Deno.writeFile(artifacts + "/" + label + ".stdout", result.stdout, { createNew: true });
  await Deno.writeFile(artifacts + "/" + label + ".stderr", result.stderr, { createNew: true });
  assert(result.code === code, `${label}: shell entrypoint changed the child's actual status`);
  outcomes.push({ label, expected: code, observed: result.code });
}
await Deno.writeTextFile(artifacts + "/controls.json", JSON.stringify(outcomes, null, 2), { createNew: true });
console.log("Actual shell entrypoint controls observed", JSON.stringify(outcomes));
