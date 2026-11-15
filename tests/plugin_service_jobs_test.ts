// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { backupFixture } from "./helpers/backup_fixture.ts";
import { FsError } from "../server/plugins/contracts.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

Deno.test("post-activation recovery mechanism regression: shipped recovery IO does not own activation", async () => {
  let armed = false;
  const first = await backupFixture({
    fault(method, args, at) {
      if (
        armed && method === "fs.writeFile" && at === "before" &&
        String(args[0]).endsWith(".0.bak")
      ) throw new FsError("fs_io_error");
    },
  });
  let next: Awaited<ReturnType<typeof backupFixture>> | undefined;
  let firstClosed = false;
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    await first.create("Recover", "A");
    await first.save("Recover", "B");
    await first.status();
    armed = true;
    await first.save("Recover", "C");
    assert((await first.status()).pendingRecovery);
    await first.close();
    firstClosed = true;
    next = await backupFixture({
      fixture: first.fixture,
      fault: async (method, args, at) => {
        if (
          method === "fs.writeFile" && at === "before" &&
          String(args[0]).endsWith(".0.bak")
        ) {
          held.resolve();
          await release.promise;
        }
      },
    });
    await workMilestone(
      next.runtime.settleWork(next.id, ["ordinary"]),
      held.promise,
      "shipped backup recovery publication entered",
    );
    assertEquals(next.runtime.status(next.id)?.status, "ready");
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Recover.md.0.bak`),
      "A",
    );
    release.resolve();
    assertEquals((await next.status()).completed, 1);
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Recover.md.0.bak`),
      "B",
    );
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Recover.md.1.bak`),
      "A",
    );
    await assertRejects(
      () => Deno.stat(`${first.fixture.vault}/.globnotes-backup/active.json`),
      Deno.errors.NotFound,
    );
  } finally {
    release.resolve();
    if (next) await next.close();
    else if (!firstClosed) await first.close();
  }
});
