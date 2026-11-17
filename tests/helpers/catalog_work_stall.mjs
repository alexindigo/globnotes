// Real native backup fixture scheduling proof. Run through run.sh --browser.
import { command } from "./process.ts";
import { done, pending, waitUntil, watchChild } from "./wait.ts";
import { waitForAudit } from "./catalog_work_audit.ts";
import { finalizeNativeCase } from "../../client/tests/e2e/native-case-finalization.mjs";
import { publishRecord, readRecord } from "./process_records.ts";

const directory = Deno.args[0];
const exitControl = Deno.args[1] === "--exit-before-record";
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
    WORK_PROOF_EXIT_BEFORE_RECORD: exitControl ? "1" : "0",
  },
  stdout: "piped",
  stderr: "piped",
  stdin: "piped",
}).spawn();
const watching = watchChild(child), output = child.output();
const waitFile = (name) =>
  waitForAudit(directory, name, [{
    label: "Native child",
    exit: child.status,
  }]);
let serverPid,
  controlChild,
  controlOutput,
  controlWatching,
  failure;
try {
  // Each native preparation call has its own product outcome. Do not add a
  // readiness cap around their sequence merely to observe the scheduling seam.
  const before = await waitFile("before-stop");
  serverPid = before.pid;
  assert(
    before.journal.phase === "ring-committed" &&
      before.journal.planned.length === 9,
    "Wrong native capture seam",
  );
  // Publication precedes self-SIGSTOP. Confirm the kernel has stopped this
  // exact owned process before SIGCONT, which is otherwise a losable signal.
  await waitUntil(async () => {
    const state = await Deno.readTextFile(`/proc/${serverPid}/status`);
    return /^State:\s+T/m.test(state)
      ? done()
      : pending({ pid: serverPid, state });
  }, { label: "wrapped server reached SIGSTOP", children: [watching] });
  if (exitControl) {
    const resumed = Date.now();
    Deno.kill(serverPid, "SIGCONT");
    let rejected;
    try {
      await waitFile("completed");
    } catch (error) {
      rejected = error;
    }
    assert(
      rejected && /exited before completed: 17/.test(rejected.message),
      `Wrong exit control failure: ${rejected}`,
    );
    const result = await output;
    let absent = false;
    try {
      await Deno.stat(`/proc/${serverPid}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      absent = true;
    }
    assert(
      result.code !== 0 && absent,
      "Exit control must reject the native client and reap its wrapped server",
    );
    assert(
      !readRecord(`${directory}/completed.json`),
      "Exit control unexpectedly published a terminal success",
    );
    await publishRecord(
      `${directory}/exit-control.json`,
      JSON.stringify({
        detail: rejected.message,
        code: result.code,
        serverAbsent: absent,
        terminalRecord: false,
        elapsedMs: Date.now() - resumed,
      }),
    );
    console.log("SERVER EXIT CONTROL OK", rejected.message);
  } else {
    // Meaningful verification supplies the scheduling gap, not a timer or sleep.
    controlChild = command(Deno.execPath(), {
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
    }).spawn();
    controlWatching = watchChild(controlChild);
    controlOutput = controlChild.output();
    const control = await Promise.race([
      controlOutput,
      child.status.then((status) => {
        throw Error(`Native child exited during verification: ${status.code}`);
      }),
    ]);
    await publishRecord(`${directory}/count.stdout.log`, control.stdout);
    await publishRecord(`${directory}/count.stderr.log`, control.stderr);
    const stalledWallMs = Date.now() - before.wall;
    Deno.kill(serverPid, "SIGCONT");
    const after = await waitFile("completed");
    const result = await output;
    await publishRecord(`${directory}/native.stdout.log`, result.stdout);
    await publishRecord(`${directory}/native.stderr.log`, result.stderr);
    const receipt = {
      code: result.code,
      countCode: control.code,
      stalledWallMs,
      observedMs: after.observed - before.observed,
      before,
      after,
    };
    await publishRecord(
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
        JSON.stringify(
          Array.from({ length: 9 }, (_, index) => `v${10 - index}`),
        ),
      "Wrong physical native backup bytes",
    );
    assert(
      !after.files.includes("active.json") &&
        !after.files.some((name) => name.startsWith("stage-")),
      "Native journal/staging cleanup incomplete",
    );
    assert(result.code === 0, "First native backup idle observation failed");
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  await finalizeNativeCase({
    error: failure,
    cleanup: [
      () => {
        serverPid ??= readRecord(`${directory}/server-owner.json`)?.pid;
        if (serverPid) {
          try {
            Deno.kill(serverPid, "SIGCONT");
          } catch { /* exited */ }
        }
      },
      async () => {
        if (!controlChild) return;
        if (!controlWatching.status()) {
          try {
            controlChild.kill("SIGTERM");
          } catch { /* exited */ }
        }
        const final = await controlOutput;
        await publishRecord(`${directory}/count.stdout.log`, final.stdout);
        await publishRecord(`${directory}/count.stderr.log`, final.stderr);
      },
      () => {
        if (serverPid) {
          try {
            Deno.kill(serverPid, "SIGTERM");
          } catch { /* healthy consumer closed it */ }
        }
      },
      async () => {
        if (!watching.status()) {
          try {
            child.kill("SIGTERM");
          } catch { /* exited */ }
        }
        const final = await output;
        await publishRecord(`${directory}/native.stdout.log`, final.stdout);
        await publishRecord(`${directory}/native.stderr.log`, final.stderr);
        try {
          await child.stdin.close();
        } catch { /* already closed */ }
      },
    ],
  });
}
