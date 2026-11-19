// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { duringWork } from "./helpers/product_settlement.ts";
import { done, pending } from "./helpers/wait.ts";

for (const behavior of ["hold", "hang"]) {
  Deno.test(`versioning independence: save completes with a ${behavior} handler still pending`, async () => {
    const b = await pluginOperationsFixture({
      id: "slow-versioner",
      manifest: {
        runtime: { server: "service.js" },
        versioning: { extensions: [".md"] },
        capabilities: { read: ["vault"] },
      },
      files: {
        "service.js": `
        let entered = false, finished = false, release;
        export function activate(ctx) {
          ctx.versioning.onOffer(async () => {
            entered = true;
            await new Promise(resolve => { release = resolve; });
            finished = true;
          });
          ctx.commands.register({id:"inspect",label:"inspect",target:"server"}, () => ({entered,finished}));
          ctx.commands.register({id:"release",label:"release",target:"server"}, () => release());
        }
      `,
      },
      limits: { serviceCallMs: 2000 },
    });
    try {
      await b.create("Latency", "before");
      await b.save("Latency", "after");
      const cohort = b.runtime.settlement(b.id, ["versioning"]);
      assertEquals(
        cohort.pending,
        1,
        "save must not await versioning completion",
      );
      await duringWork(cohort.completion, async () => {
        const seen = await b.command("inspect") as {
          entered: boolean;
          finished: boolean;
        };
        assertEquals(seen.finished, false);
        return seen.entered ? done() : pending(seen);
      }, "versioner entered its held handler");
      assertEquals(
        Deno.readTextFileSync(`${b.fixture.vault}/Latency.md`),
        "after",
      );
      if (behavior === "hold") {
        await b.command("release");
        await cohort.completion;
        assertEquals(await b.command("inspect"), {
          entered: true,
          finished: true,
        });
      } else {
        assertEquals(b.runtime.settlement(b.id, ["versioning"]).pending, 1);
      }
    } finally {
      await b.close();
    }
  });
}
