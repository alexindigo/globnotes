// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { backupFixture } from "./helpers/backup_fixture.ts";

for (const broken of [false, true]) {
  Deno.test(`backup work summary: ${broken ? "spelling-key mutation" : "canonical aliases"} reports actual post-baseline work`, async () => {
    const b = await backupFixture({
      variant: (name, text) => {
        if (!broken || name !== "backup.js") return text;
        for (
          const [before, after] of [
            [
              "JSON.stringify([root, captured.path])",
              "JSON.stringify([config.base, captured.path])",
            ],
            [
              "JSON.stringify([state.root, state.path])",
              "JSON.stringify([state.base, state.path])",
            ],
          ]
        ) {
          assertEquals(text.split(before).length - 1, 1);
          text = text.replace(before, after);
        }
        return text;
      },
    });
    try {
      await b.configure(5);
      await b.create("Note", "A");
      await b.save("Note", "B");
      const baselinePrivate = await b.status();
      const baseline = b.runtime.status(b.id)!;
      assertEquals(baselinePrivate.failed, 0);
      assertEquals(baseline.jobs[0].state, "succeeded");
      assertEquals(baseline.work!.ordinary.failures, 0);
      assertEquals(baseline.work!.versioning.failures, 0);
      assertEquals(baseline.deliveryFailures, 0);
      await b.configure(5, ".");
      await b.save("Note", "C");
      await b.runtime.settleWork(b.id);
      const observed = b.runtime.status(b.id)!;
      const privateStatus = await b.command("status") as {
        failed: number;
        completed: number;
        lastError: { code: string } | null;
      };
      assertEquals(observed.work!.generation, baseline.work!.generation);
      assertEquals(
        observed.work!.versioning.admitted,
        baseline.work!.versioning.admitted + 1,
      );
      assertEquals(observed.work!.versioning.pending, 0);
      assertEquals(observed.work!.versioning.failures, broken ? 1 : 0);
      assertEquals(observed.deliveryFailures, broken ? 1 : 0);
      assertEquals(privateStatus.failed, broken ? 1 : 0);
      assertEquals(privateStatus.completed, broken ? 1 : 2);
      assertEquals(
        privateStatus.lastError?.code ?? null,
        broken ? "backup_alien_slot" : null,
      );
      assertEquals(
        await Deno.readTextFile(`${b.fixture.vault}/Note.md.0.bak`),
        broken ? "A" : "B",
      );
      assertEquals(await Deno.readTextFile(`${b.fixture.vault}/Note.md`), "C");
      assert(
        observed.work!.versioning.settled > baseline.work!.versioning.settled,
      );
      console.log(JSON.stringify({
        broken,
        baseline: baseline.work,
        baselineDeliveryFailures: baseline.deliveryFailures,
        observed: observed.work,
        deliveryFailures: observed.deliveryFailures,
        privateStatus,
      }));
    } finally {
      await b.close();
    }
  });
}
