// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PLUGIN_LIMITS } from "../server/plugins/contracts.ts";
import { processClock } from "../server/observed_time.ts";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { PluginHost } from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { manualExpiry } from "./helpers/manual_deadline.ts";

async function fixture() {
  return await pluginOperationsFixture({
    id: "work-summary",
    manifest: {
      runtime: { server: "service.js" },
      versioning: { extensions: [".md"] },
      hooks: ["pre-save"],
    },
    files: {
      "service.js": `let release;
      export function activate(ctx){
        ctx.hooks.on('pre-save',()=>({}));
        ctx.versioning.onOffer(()=>new Promise(resolve=>release=resolve));
        ctx.commands.register({id:'ping',label:'Ping',target:'server'},()=>true);
        ctx.commands.register({id:'release',label:'Release',target:'server'},()=>release?.());
        ctx.commands.register({id:'fail',label:'Fail',target:'server'},()=>{throw Error('PRIVATE /secret/path bytes settings');});
      }`,
    },
  });
}

Deno.test("work summary: additive catalogue metadata, independent lanes and immutable snapshots", async () => {
  const f = await fixture();
  try {
    const before = f.runtime.status(f.id)!.work!;
    assertEquals(Object.keys(before).sort(), [
      "generation",
      "guard",
      "ordinary",
      "startup",
      "versioning",
    ]);
    assertEquals(before.startup, { state: "succeeded" });
    assertEquals(before.ordinary, {
      admitted: 0,
      settled: 0,
      pending: 0,
      failures: 0,
      lastFailure: null,
    });
    await f.create("Note", "v0");
    await f.save("Note", "v1");
    assertEquals(await f.command("ping"), true);
    const work = f.runtime.status(f.id)!.work!;
    assertEquals(work.versioning, {
      admitted: 1,
      settled: 0,
      pending: 1,
      failures: 0,
      lastFailure: null,
    });
    assertEquals(work.ordinary.admitted, 1);
    assertEquals(work.ordinary.settled, 1);
    assertEquals(work.guard.admitted, 1);
    assertEquals(work.guard.settled, 1);
    assertEquals(before.versioning.admitted, 0);
    work.versioning.admitted = 900;
    assertEquals(f.runtime.status(f.id)!.work!.versioning.admitted, 1);
    const catalog = await f.manager.catalog();
    assertEquals(catalog.contractVersion, 2);
    const plugin = catalog.plugins.find((item) => item.id === f.id)!;
    assertEquals(plugin.work, f.runtime.status(f.id)!.work);
    assertEquals(plugin.status, "ready");
    assertEquals(plugin.degraded, false);
    assertEquals(plugin.deliveryFailures, 0);
    assert(!("settlement" in plugin));
    await f.command("release");
    await f.runtime.settleWork(f.id, ["versioning"]);
    assertEquals(f.runtime.status(f.id)!.work!.versioning.settled, 1);
  } finally {
    await f.close();
  }
});

Deno.test("work summary: callback failure remains value-free after diagnostic eviction", async () => {
  const f = await fixture();
  try {
    await assertRejects(() => f.command("fail"));
    await f.runtime.settleWork(f.id, ["ordinary"]);
    const expected = {
      admitted: 1,
      settled: 1,
      pending: 0,
      failures: 1,
      lastFailure: { sequence: 1, code: "plugin_work_failed" as const },
    };
    assertEquals(f.runtime.status(f.id)!.work!.ordinary, expected);
    for (let index = 0; index < 257; index++) {
      f.runtime.contractDiagnostic(f.id, "eviction", "unrelated");
    }
    assertEquals(f.runtime.status(f.id)!.diagnostics.length, 256);
    assertEquals(f.runtime.status(f.id)!.work!.ordinary, expected);
    assert(!JSON.stringify(f.runtime.status(f.id)!.work).includes("PRIVATE"));
    assertEquals(f.runtime.status(f.id)!.status, "ready");
  } finally {
    await f.close();
  }
});

Deno.test("work summary: queued deadline cannot advance across an active hole", async () => {
  const f = await fixture();
  const deadline = processClock.deadline.bind(processClock);
  let expire: (() => void) | undefined;
  const scheduled = new Set<() => void>();
  try {
    await f.create("Note", "v0");
    await f.save("Note", "v1");
    await f.command("ping");
    processClock.deadline = (ms, callback) => {
      const stop = deadline(ms, callback);
      const cancel = () => {
        scheduled.delete(cancel);
        stop();
      };
      scheduled.add(cancel);
      if (ms === PLUGIN_LIMITS.serviceCallMs) {
        expire = manualExpiry(cancel, callback);
      }
      return cancel;
    };
    await f.save("Note", "v2");
    processClock.deadline = deadline;
    assert(expire);
    expire();
    await Promise.resolve();
    const work = f.runtime.status(f.id)!.work!;
    assertEquals(work.versioning, {
      admitted: 2,
      settled: 0,
      pending: 1,
      failures: 1,
      lastFailure: { sequence: 2, code: "plugin_work_deadline" },
    });
    await f.command("release");
    await f.runtime.settleWork(f.id, ["versioning"]);
    assertEquals(f.runtime.status(f.id)!.work!.versioning.settled, 2);
  } finally {
    processClock.deadline = deadline;
    await f.close();
    const remaining = scheduled.size;
    for (const cancel of scheduled) cancel();
    assertEquals(
      remaining,
      0,
      "manual expiry must release its real deadline and clock hold",
    );
  }
});

Deno.test("work summary: a hung invocation records the existing product deadline", async () => {
  const f = await fixture();
  const deadline = processClock.deadline.bind(processClock);
  let expire: (() => void) | undefined, budget: number | undefined;
  try {
    await f.create("Note", "v0");
    processClock.deadline = (ms, callback) => {
      const cancel = deadline(ms, callback);
      if (ms === PLUGIN_LIMITS.serviceCallMs) {
        expire ??= manualExpiry(cancel, callback);
        budget = ms;
      }
      return cancel;
    };
    await f.save("Note", "v1");
    processClock.deadline = deadline;
    await f.command("ping");
    const rejected = assertRejects(
      () => f.runtime.settleWork(f.id, ["versioning"]),
      Error,
      "plugin call deadline exceeded",
    );
    assertEquals(budget, 30_000);
    assert(expire);
    expire();
    await rejected;
    const work = f.runtime.status(f.id)!.work!;
    assertEquals(work.versioning.lastFailure, {
      sequence: 1,
      code: "plugin_work_deadline",
    });
    assertEquals(work.startup.state, "succeeded");
    assertEquals(f.runtime.status(f.id)!.status, "failed");
    assert(
      f.runtime.status(f.id)!.diagnostics.some((item) =>
        item.detail.includes("deadline exceeded")
      ),
    );
  } finally {
    processClock.deadline = deadline;
    await f.close();
  }
});

Deno.test("work summary: retirement is null and replacement resets its own generation only", async () => {
  const f = await fixture();
  try {
    const original = f.runtime.status(f.id)!.work!;
    await f.create("Note", "v0");
    await f.save("Note", "v1");
    await f.runtime.retireOwner(f.id, false, true);
    assertEquals(f.runtime.status(f.id)!.work, null);
    assertEquals(
      (await f.manager.catalog()).plugins.find((item) => item.id === f.id)!
        .work,
      null,
    );
    await f.runtime.reconcile();
    await pluginSettled(f.runtime, f.id, "ready");
    const fresh = f.runtime.status(f.id)!.work!;
    assert(fresh.generation !== original.generation);
    assertEquals(fresh.versioning, {
      admitted: 0,
      settled: 0,
      pending: 0,
      failures: 0,
      lastFailure: null,
    });
  } finally {
    await f.close();
  }
});

Deno.test("work summary: startup is separate from invocations and non-service hosts expose no summary", async () => {
  const fixture = await pluginFixture();
  const directory = await fixture.install("startup-work", {
    runtime: { server: "service.js" },
  }, {
    "service.js": `export async function activate(ctx){await ctx.data.load();}`,
    "main.js": `export function getSelectors(){return []}`,
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<unknown>();
  const host = new PluginHost(
    readManifest(directory),
    fixture.vault,
    () => {
      entered.resolve();
      return release.promise;
    },
    1,
    { role: "service" },
  );
  const render = new PluginHost(
    readManifest(directory),
    fixture.vault,
    () => Promise.resolve(null),
    1,
  );
  try {
    assertEquals(render.workSummary, null);
    const starting = host.start();
    await workMilestone(starting, entered.promise, "activation RPC admitted");
    assertEquals(host.workSummary!.startup.state, "pending");
    assertEquals(host.workSummary!.ordinary.admitted, 0);
    release.resolve({ revision: 0, values: {} });
    await starting;
    assertEquals(host.workSummary!.startup.state, "succeeded");
    assertEquals(host.workSummary!.ordinary.admitted, 0);
  } finally {
    release.resolve(null);
    host.stop();
    render.stop();
    await fixture.dispose();
  }
});

Deno.test("work summary: overflow settles an admitted hole without retaining completed history", async () => {
  const f = await fixture();
  try {
    await f.create("Note", "v0");
    for (let index = 1; index <= 10; index++) await f.save("Note", `v${index}`);
    await f.command("ping");
    const summary = f.runtime.status(f.id)!.work!.versioning;
    assertEquals(summary.admitted, 10);
    assertEquals(summary.settled, 0);
    assertEquals(summary.pending, 9);
    assertEquals(summary.failures, 1);
    assertEquals(summary.lastFailure, {
      sequence: 2,
      code: "plugin_work_failed",
    });
    assert(
      f.runtime.status(f.id)!.diagnostics.some((item) =>
        item.code === "versioning_gap"
      ),
    );
  } finally {
    await f.close();
  }
});
