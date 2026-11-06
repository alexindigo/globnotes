// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { pluginOperationsFixture } from "../helpers/plugin_operations_fixture.ts";

for (const behavior of ["sleep", "hang"]) {
  Deno.test(`versioning latency: saves do not wait for a handler that will ${behavior}`, async () => {
    const b = await pluginOperationsFixture({
      id: "slow-versioner",
      manifest: {
        runtime: { server: "service.js" },
        versioning: { extensions: [".md"] },
        capabilities: { read: ["vault"] },
      },
      files: {
        "service.js": `
        export function activate(ctx) {
          ctx.versioning.onOffer(() => new Promise(resolve => {
            ${behavior === "sleep" ? "setTimeout(resolve, 1500);" : ""}
          }));
        }
      `,
      },
      limits: { serviceCallMs: 2000 },
    });
    try {
      await b.create("Latency", "before");
      const start = performance.now();
      await b.save("Latency", "after");
      const elapsedMs = performance.now() - start;
      console.log(JSON.stringify({ behavior, elapsedMs }));
      assert(elapsedMs < 500, `save waited on ${behavior}: ${elapsedMs} ms`);
      assertEquals(
        Deno.readTextFileSync(`${b.fixture.vault}/Latency.md`),
        "after",
      );
    } finally {
      await b.close();
    }
  });
}
