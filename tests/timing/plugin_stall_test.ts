// SPDX-License-Identifier: LGPL-3.0-only
/**
 * Timing-budget tests (serial): the heartbeat silence bound is measured in
 * observed time (server/observed_time.ts, plans/scheduling-tolerance).
 * A whole-process stop longer than the bound fails no healthy worker; a
 * worker that hangs while its host runs on time is failed at the bound.
 */
import { assert, assertEquals } from "@std/assert";
import { command } from "../helpers/process.ts";
import { done, pending, waitUntil } from "../helpers/wait.ts";

/** The product bound: twelve 250 ms heartbeat periods. */
const SILENCE_MS = 3000;
const CHILD = new URL("../helpers/plugin_stall_child.ts", import.meta.url)
  .pathname;

function child(mode: "stall" | "hang", evidence: string) {
  return command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--frozen",
      `--config=${new URL("../../deno.json", import.meta.url).pathname}`,
      "--unstable-worker-options",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      CHILD,
      mode,
      evidence,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}
async function finish(process: Deno.ChildProcess, evidence: string) {
  const output = await process.output();
  const stderr = new TextDecoder().decode(output.stderr);
  await Deno.writeTextFile(`${evidence}/stderr.log`, stderr);
  assertEquals(output.code, 0, stderr);
  return {
    result: JSON.parse(await Deno.readTextFile(`${evidence}/result.json`)),
    stderr,
  };
}

Deno.test("plugin stall: a whole-process stop longer than the silence bound fails no healthy worker", async () => {
  const evidence = await Deno.makeTempDir({ prefix: "plugin-stall-" });
  const process = child("stall", evidence);
  try {
    await waitUntil(async () => {
      try {
        await Deno.stat(`${evidence}/ready.json`);
        return done();
      } catch {
        return pending({ evidence });
      }
    }, { label: "stall child hosts ready" });
    const stopMs = SILENCE_MS + 1000;
    process.kill("SIGSTOP");
    await new Promise((resolve) => setTimeout(resolve, stopMs));
    process.kill("SIGCONT");
    await Deno.writeTextFile(`${evidence}/resumed`, "");
    const { result, stderr } = await finish(process, evidence);
    console.log(JSON.stringify({ stopMs, evidence, ...result }));
    assertEquals(result.failures, []);
    assert(result.serviceAvailable && result.renderAvailable);
    assert(result.sameGenerations, "no worker was replaced");
    assertEquals(
      result.calls,
      [
        { ok: true, result: "after-stall" },
        { ok: true, result: "alive" },
        { ok: true, result: "alive" },
      ],
    );
    assert(result.stalls.count >= 1 && result.stalls.last.gapMs >= stopMs);
    assert(stderr.includes("was not scheduled for"), "the stall is logged");
  } finally {
    try {
      process.kill("SIGCONT");
      process.kill("SIGKILL");
    } catch { /* already exited */ }
    await process.status;
  }
});

Deno.test("plugin stall: a worker hung while its host runs on time fails at the silence bound", async () => {
  const evidence = await Deno.makeTempDir({ prefix: "plugin-hang-" });
  const process = child("hang", evidence);
  try {
    const { result } = await finish(process, evidence);
    console.log(JSON.stringify({ evidence, ...result }));
    assertEquals(result.failures, [
      "worker heartbeat timeout; in-flight outcome unknown",
    ]);
    assertEquals(result.result.ok, false);
    assert(!result.serviceAvailable);
    assertEquals(
      result.stallsDuring,
      0,
      "the host ran on time during the hang",
    );
    // The last heartbeat precedes the hang by at most one period; the
    // watchdog observes the silence at its next tick after the bound.
    assert(
      result.detectedAfterMs > SILENCE_MS - 250 &&
        result.detectedAfterMs < SILENCE_MS + 500,
      `detected after ${result.detectedAfterMs} ms`,
    );
  } finally {
    try {
      process.kill("SIGKILL");
    } catch { /* already exited */ }
    await process.status;
  }
});
