// Real native backup fixture scheduling proof. Run through run.sh --browser.
import { command } from "./process.ts";
import { watchChild } from "./wait.ts";

const directory = Deno.args[0];
if (!directory?.startsWith("/")) {
  throw Error("An absolute fresh artifact directory is required");
}
await Deno.mkdir(directory);
const assert = (condition, detail) => {
  if (!condition) throw Error(detail);
};
const child = command(Deno.execPath(), {
  args: [
    "run",
    "--cached-only",
    "--frozen",
    "--unstable-worker-options",
    "--allow-all",
    "tests/helpers/catalog_work_stall_client.ts",
    directory,
  ],
  env: {
    GLOBNOTES_TEST_HOST: Deno.env.get("GLOBNOTES_TEST_HOST"),
    CDP_PORT: Deno.env.get("CDP_PORT"),
  },
  stdout: "piped",
  stderr: "piped",
}).spawn();
const watching = watchChild(child), output = child.output();
const read = async (name) => {
  try {
    return JSON.parse(await Deno.readTextFile(`${directory}/${name}.json`));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
};
async function waitFile(name) {
  const watcher = Deno.watchFs(directory);
  try {
    const existing = await read(name);
    if (existing) return existing;
    for await (const _event of watcher) {
      const failure = await read("invocation-error");
      if (failure) throw Error(failure.detail);
      const value = await read(name);
      if (value) return value;
    }
    throw Error(`Native audit watcher closed before ${name}`);
  } finally {
    watcher.close();
  }
}
let serverPid, paused = false;
try {
  // Each native preparation call has its own product outcome. Do not add a
  // readiness cap around their sequence merely to observe the scheduling seam.
  const before = await Promise.race([
    waitFile("before-stop"),
    child.status.then((status) => {
      throw Error(`Native child exited before seam: ${status.code}`);
    }),
  ]);
  serverPid = before.pid;
  paused = true;
  assert(
    before.journal.phase === "ring-committed" &&
      before.journal.planned.length === 9,
    "Wrong native capture seam",
  );
  // Meaningful verification supplies the scheduling gap, not a timer or sleep.
  const control = await command(Deno.execPath(), {
    args: [
      "test",
      "--cached-only",
      "--frozen",
      "--unstable-worker-options",
      "--allow-all",
      "--filter",
      "every count1",
      "tests/backup_plugin_test.ts",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  await Deno.writeFile(`${directory}/count.stdout.log`, control.stdout);
  await Deno.writeFile(`${directory}/count.stderr.log`, control.stderr);
  const stalledWallMs = Date.now() - before.wall;
  Deno.kill(serverPid, "SIGCONT");
  paused = false;
  const after = await waitFile("completed");
  const result = await output;
  await Deno.writeFile(`${directory}/native.stdout.log`, result.stdout);
  await Deno.writeFile(`${directory}/native.stderr.log`, result.stderr);
  const receipt = {
    code: result.code,
    countCode: control.code,
    stalledWallMs,
    observedMs: after.observed - before.observed,
    before,
    after,
  };
  await Deno.writeTextFile(
    `${directory}/receipt.json`,
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify({
    code: receipt.code,
    countCode: receipt.countCode,
    stalledWallMs,
    observedMs: receipt.observedMs,
    generation: after.generation,
    bytes: after.bytes,
    files: after.files,
    evidence: directory,
  }));
  assert(
    control.success,
    "The real verification workload failed; invalid scheduling proof",
  );
  assert(stalledWallMs > 15_000, "Scheduling gap did not exceed 15 seconds");
  assert(
    receipt.observedMs < 30_000,
    "Existing product invocation budget exceeded",
  );
  assert(
    after.generation === before.generation &&
      after.completedGeneration === before.generation,
    "Replacement completed the original capture",
  );
  assert(
    JSON.stringify(after.bytes) ===
      JSON.stringify(Array.from({ length: 9 }, (_, index) => `v${10 - index}`)),
    "Wrong physical native backup bytes",
  );
  assert(
    !after.files.includes("active.json") &&
      !after.files.some((name) => name.startsWith("stage-")),
    "Native journal/staging cleanup incomplete",
  );
  assert(result.code === 0, "First native backup idle observation failed");
} finally {
  if (serverPid) {
    if (paused) {
      try {
        Deno.kill(serverPid, "SIGCONT");
      } catch { /* exited */ }
    }
    // Failed native fixtures retain their server. This proof owns that exact PID.
    try {
      Deno.kill(serverPid, "SIGTERM");
    } catch { /* healthy consumer closed it */ }
  }
  if (!watching.status()) {
    try {
      child.kill("SIGTERM");
    } catch { /* exited */ }
  }
  const final = await output;
  await Deno.writeFile(`${directory}/native.stdout.log`, final.stdout);
  await Deno.writeFile(`${directory}/native.stderr.log`, final.stderr);
}
