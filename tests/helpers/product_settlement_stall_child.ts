// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { PluginHost } from "../../server/plugins/host.ts";
import { processClock } from "../../server/observed_time.ts";
import { backupFixture, type BackupStatus } from "./backup_fixture.ts";

const directory = Deno.args[0];
const invoke = PluginHost.prototype.invoke;
let capture: Promise<unknown> | undefined;
PluginHost.prototype.invoke = function (handler, args, pre, timeout, options) {
  const result = invoke.call(this, handler, args, pre, timeout, options);
  const offer = args[0] as { path?: string; bytes?: Uint8Array } | undefined;
  if (
    options?.lane === "versioning" && offer?.path === "Counts/N9.md" &&
    new TextDecoder().decode(offer.bytes) === "v10"
  ) {
    capture = result;
    result.catch(() => undefined);
  }
  return result;
};
let armed = false, observing = false, stopped = false;
let before: Record<string, unknown> | undefined;
let afterPause: Record<string, unknown> | undefined;
const signal = (kind: string) =>
  Deno.stdout.writeSync(new TextEncoder().encode(`SETTLEMENT_${kind}\n`));
const b: Awaited<ReturnType<typeof backupFixture>> = await backupFixture({
  fault: async (method, args, boundary) => {
    if (
      !armed || stopped || boundary !== "before" || method !== "fs.remove" ||
      !/\/stage-[^/]+-0\.bin$/.test(String(args[0]))
    ) return;
    assert(
      observing,
      "cleanup arrived before the original post-save idle observation",
    );
    stopped = true;
    const status = await b.command("status") as BackupStatus & {
      pendingJobs: number;
    };
    const journal = JSON.parse(
      await Deno.readTextFile(
        `${b.fixture.vault}/.globnotes-backup/active.json`,
      ),
    );
    assertEquals(status.completed, 62);
    assertEquals(status.failed, 0);
    assertEquals(status.pendingJobs, 1);
    assertEquals(status.ringCommitted, true);
    assertEquals(journal.phase, "ring-committed");
    assertEquals(journal.planned.length, 9);
    assertEquals(journal.old.length, 9);
    assertEquals(journal.stages.length, 10);
    before = {
      wall: Date.now(),
      observed: processClock.now(),
      status,
      journal,
      host: b.runtime.status(b.id),
    };
    Deno.writeTextFileSync(
      `${directory}/before-stop.json`,
      JSON.stringify(before),
    );
    signal("STOPPING");
    Deno.kill(Deno.pid, "SIGSTOP");
    afterPause = {
      wall: Date.now(),
      observed: processClock.now(),
      stalls: processClock.stalls,
    };
  },
});
signal("READY");
let result: Record<string, unknown> = {};
let exit = 1;
try {
  for (let count = 1; count <= 9; count++) {
    await b.configure(count);
    await b.status();
    const path = `Counts/N${count}`;
    await b.create(path, "v0");
    for (let index = 1; index <= count + 2; index++) {
      armed = count === 9 && index === 11;
      await b.save(path, `v${index}`);
      if (!armed) {
        await b.status();
        continue;
      }
      observing = true;
      // This is the original consumer, started immediately after save, not after
      // the gate. Capture its first verdict; never retry that observation.
      const idle = await b.status().then(
        (status) => ({ ok: true, status }),
        (error) => ({
          ok: false,
          error: { name: error.name, message: error.message },
        }),
      );
      assert(stopped && before && afterPause && capture);
      await capture; // The same real host invocation, not another capture/retry.
      const final = await b.command("status") as BackupStatus & {
        pendingJobs: number;
      };
      const host = b.runtime.status(b.id)!;
      const bytes = [];
      for (let slot = 0; slot < 9; slot++) {
        bytes.push(
          await Deno.readTextFile(`${b.fixture.vault}/${path}.md.${slot}.bak`),
        );
      }
      assertEquals(
        bytes,
        Array.from({ length: 9 }, (_, slot) => `v${10 - slot}`),
      );
      assertEquals(final.completed, 63);
      assertEquals(final.failed, 0);
      assertEquals(final.pendingJobs, 0);
      assertEquals(final.pendingRecovery, false);
      assertEquals(host.versioningPending, 0);
      assertEquals(host.status, "ready");
      assertEquals(host.degraded, false);
      assertEquals(host.generation, (before.host as typeof host).generation);
      const files = [
        ...Deno.readDirSync(`${b.fixture.vault}/.globnotes-backup`),
      ].map((entry) => entry.name);
      assert(
        !files.includes("active.json") &&
          !files.some((name) => name.startsWith("stage-")),
      );
      result = {
        idle,
        before,
        afterPause,
        completedObserved: processClock.now(),
        final,
        host,
        bytes,
        files,
        fixture: b.fixture.root,
      };
      exit = idle.ok ? 0 : 1;
    }
  }
} catch (error) {
  result = {
    error: String(error),
    before,
    afterPause,
    host: b.runtime.status(b.id),
    fixture: b.fixture.root,
  };
} finally {
  PluginHost.prototype.invoke = invoke;
  await b.close();
}
await Deno.writeTextFile(
  `${directory}/result.json`,
  JSON.stringify(result!, null, 2),
);
Deno.exit(exit);
