// The actual shell entrypoint must preserve its delegated process's status.
import { assert } from "./test-outcomes.mjs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../..", import.meta.url));
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
for (const shard of ["1/2", "2/2"]) {
  const label = "shard-" + shard[0], executable = artifacts + "/" + label + ".sh";
  // Check the real shell's argv boundary, not a reconstructed invocation.
  await Deno.writeTextFile(executable, `#!/bin/sh\nfor arg do previous="$last"; last="$arg"; done\ntest "$previous" = --shard && test "$last" = '${shard}'\n`, { createNew: true, mode: 0o700 });
  const result = await new Deno.Command("sh", { args: [root + "/client/tests/e2e/run.sh", "--shard", shard], env: { DENO: executable }, stdout: "piped", stderr: "piped" }).output();
  assert(result.success, `${label}: shell entrypoint lost the shard arguments`);
  outcomes.push({ label, expected: 0, observed: result.code });
}
await Deno.writeTextFile(artifacts + "/controls.json", JSON.stringify(outcomes, null, 2), { createNew: true });
console.log("Actual shell entrypoint controls observed", JSON.stringify(outcomes));
