// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { readManifest } from "../server/plugins/manifest.ts";
import { backupFixture } from "./helpers/backup_fixture.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

for (const phase of ["recovery", "capture"] as const) {
  Deno.test(`backup fixture: configuration follows held ${phase} work`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = phase === "recovery", held = false;
    const b = await backupFixture({
      fault: async (method, args, boundary) => {
        if (
          armed && !held && method === "fs.stat" && args[0] === "." &&
          boundary === "before"
        ) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      if (phase === "capture") {
        await b.status();
        await b.create("Note", "A");
        armed = true;
        await b.save("Note", "B");
      }
      const work = b.runtime.settleWork(b.id);
      await workMilestone(work, entered.promise, `${phase} filesystem entry`);
      const previous = await b.settings();
      // Observe the fixture's cohort capture, not an elapsed-time guess about
      // whether an asynchronous settings write has had time to finish.
      const captured = Promise.withResolvers<void>();
      const settle = b.runtime.settleWork.bind(b.runtime);
      b.runtime.settleWork = (...args) => {
        const result = settle(...args);
        assert(
          b.runtime.settlement(b.id, ["ordinary", "versioning"]).pending > 0,
        );
        captured.resolve();
        return result;
      };
      const configuring = b.configure(5, ".");
      configuring.catch(() => undefined);
      try {
        await workMilestone(
          configuring,
          captured.promise,
          "configuration captures existing work",
        );
        assertEquals((await b.settings()).revision, previous.revision);
      } finally {
        b.runtime.settleWork = settle;
        release.resolve();
        await configuring;
      }
      await work;
      const privateStatus = await b.status();
      const observed = b.runtime.status(b.id)!;
      assertEquals(privateStatus.failed, 0);
      assertEquals(privateStatus.completed, phase === "capture" ? 1 : 0);
      assertEquals(privateStatus.lastError, null);
      assertEquals(observed.jobs[0].state, "succeeded");
      assertEquals(observed.work!.ordinary.failures, 0);
      assertEquals(observed.work!.versioning.failures, 0);
      assertEquals(observed.deliveryFailures, 0);
      assertEquals((await b.settings()).revision, previous.revision + 1);
      if (phase === "capture") {
        assertEquals(
          await Deno.readTextFile(`${b.fixture.vault}/Note.md.0.bak`),
          "A",
        );
        assertEquals(
          await Deno.readTextFile(`${b.fixture.vault}/Note.md`),
          "B",
        );
      }
    } finally {
      release.resolve();
      await b.close();
    }
  });
}

Deno.test("backup fixture: direct concurrent settings change retains the real recovery failure", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const b = await backupFixture({
    fault: async (method, args, boundary) => {
      if (
        !held && method === "fs.stat" && args[0] === "." &&
        boundary === "before"
      ) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    const work = b.runtime.settleWork(b.id);
    await workMilestone(work, entered.promise, "recovery filesystem entry");
    const previous = await b.settings();
    // Bypass the sequential fixture operation to exercise a real settings
    // client changing the source while recovery still holds its old lease.
    await b.data.forPlugin(b.id).savePage(
      readManifest(b.dir).settings[0],
      { retention: 5, basePath: "" },
      previous.revision,
      previous.sourceKey,
    );
    release.resolve();
    await work;
    const status = await b.status();
    const runtime = b.runtime.status(b.id)!;
    assertEquals(status.failed, 1);
    assertEquals(status.lastError?.code, "fs_source_changed");
    assertEquals(runtime.jobs[0].state, "failed");
    assertEquals(runtime.work!.ordinary.failures, 1);
    assertEquals(runtime.work!.versioning.failures, 0);
    assertEquals(runtime.deliveryFailures, 0);
    console.log(JSON.stringify({ phase: "source-change", status, runtime }));
  } finally {
    release.resolve();
    await b.close();
  }
});
