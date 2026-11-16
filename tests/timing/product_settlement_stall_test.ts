// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { done, pending, waitUntil, watchChild } from "../helpers/wait.ts";
import { command } from "../helpers/process.ts";

Deno.test("product settlement: cleanup survives a real whole-process stall longer than readiness", async () => {
  const directory = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR"),
    prefix: "product-settlement-stall-",
  });
  const child = command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--frozen",
      "--unstable-worker-options",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      fromFileUrl(
        new URL(
          "../helpers/product_settlement_stall_child.ts",
          import.meta.url,
        ),
      ),
      directory,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const watching = watchChild(child);
  let stdout = "", stderr = "", ready = false, stopping = false;
  const stopped = Promise.withResolvers<void>();
  const out = (async () => {
    for await (
      const text of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      stdout += text;
      ready ||= stdout.includes("SETTLEMENT_READY\n");
      if (stdout.includes("SETTLEMENT_STOPPING\n")) {
        stopping = true;
        stopped.resolve();
      }
    }
  })();
  const err = (async () => {
    for await (
      const text of child.stderr.pipeThrough(new TextDecoderStream())
    ) stderr += text;
  })();
  try {
    // Only process startup is unbounded product-external readiness. After READY,
    // each preparation step is real product work and propagates its own failure.
    await waitUntil(() => ready ? done() : pending({ directory }), {
      label: "stall proof child startup",
      children: [watching],
    });
    await Promise.race([
      stopped.promise,
      child.status.then((status) => {
        throw Error(
          `stall child exited before gate: ${status.code}; ${stderr}`,
        );
      }),
    ]);
    const before = JSON.parse(
      await Deno.readTextFile(`${directory}/before-stop.json`),
    );
    // A fixed, meaningful verification workload, not a sleep or retry loop,
    // supplies the real scheduling interval while only our child is stopped.
    const control = await command(Deno.execPath(), {
      args: [
        "test",
        "--cached-only",
        "--frozen",
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        "--filter",
        "every count1",
        "tests/backup_plugin_test.ts",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.writeFile(
      `${directory}/count-control.stdout.log`,
      control.stdout,
    );
    await Deno.writeFile(
      `${directory}/count-control.stderr.log`,
      control.stderr,
    );
    const stoppedWallMs = Date.now() - before.wall;
    Deno.kill(child.pid, "SIGCONT");
    stopping = false;
    const status = await child.status;
    await Promise.all([out, err]);
    const result = JSON.parse(
      await Deno.readTextFile(`${directory}/result.json`),
    );
    await Deno.writeTextFile(
      `${directory}/controller.json`,
      JSON.stringify(
        {
          childExit: status.code,
          countExit: control.code,
          stoppedWallMs,
          result,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        evidence: directory,
        childExit: status.code,
        countExit: control.code,
        stoppedWallMs,
        idle: result.idle,
        observedMs: result.completedObserved - result.before?.observed,
      }),
    );
    assert(
      control.success,
      "the original count control failed; this is not a valid stall proof",
    );
    assert(
      stoppedWallMs > 15_000,
      "the real control workload did not supply the required scheduling gap",
    );
    assert(
      result.completedObserved - result.before.observed < 30_000,
      "the real product invocation budget was not preserved",
    );
    assertEquals(
      status.code,
      0,
      `first idle observation failed: ${JSON.stringify(result.idle)}`,
    );
    assertEquals(result.idle.ok, true);
  } finally {
    if (!watching.status()) {
      if (stopping) {
        try {
          Deno.kill(child.pid, "SIGCONT");
        } catch { /* already exited */ }
      }
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      await child.status;
    }
    await Promise.all([out, err]);
    await Deno.writeTextFile(`${directory}/child.stdout.log`, stdout);
    await Deno.writeTextFile(`${directory}/child.stderr.log`, stderr);
  }
});
