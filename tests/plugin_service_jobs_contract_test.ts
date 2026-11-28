// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { backupFixture } from "./helpers/backup_fixture.ts";
import { FsError } from "../server/plugins/contracts.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { pluginReady } from "./helpers/plugin_ready.ts";
import {
  pluginOperationsFixture,
  type RpcFault,
} from "./helpers/plugin_operations_fixture.ts";
import { PluginHost } from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { processClock } from "../server/observed_time.ts";
import type { PluginLimits } from "../server/plugins/contracts.ts";
import { fixtureServiceEligibility } from "./helpers/config.ts";
import { driverFixture } from "./helpers/driver_fixture.ts";

const encoder = new TextEncoder();

Deno.test("service jobs: disposal removes active and queued startup invocations from the ordinary FIFO", async () => {
  const fixture = await pluginFixture();
  const dir = await fixture.install("dispose-jobs", {
    runtime: { server: "service.js" },
  }, {
    "service.js":
      `export function activate(ctx){ctx.jobs.afterActivation({id:'active'},()=>new Promise(()=>{}));ctx.jobs.afterActivation({id:'queued'},()=>new Promise(()=>{}));}`,
  });
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    () => Promise.resolve(null),
    1,
    { role: "service" },
  );
  try {
    await host.start();
    host.admitServiceJobs();
    assertEquals(host.serviceJobs.snapshot.map((job) => job.state), [
      "running",
      "pending",
    ]);
    const retired = assertRejects(
      () => host.settleWork(["ordinary"]),
      Error,
      "service job cancelled",
    );
    const result = await host.dispose();
    await retired;
    assertEquals(result.unfinished, 2);
    assertEquals(result.errors, []);
    assertEquals(host.serviceJobs.snapshot, [{
      id: "active",
      state: "cancelled",
    }, { id: "queued", state: "cancelled" }]);
  } finally {
    host.stop();
    await fixture.dispose();
  }
});

Deno.test("service jobs: unused owned disposer cancels once without retiring unrelated work", async () => {
  const b = await generic(`
    const gone=ctx.jobs.afterActivation({id:'removed-before-ready'},()=>{throw Error('must not run');});gone();gone();
    let remove;remove=ctx.jobs.afterActivation({id:'self-cancel'},()=>{remove();remove();});
    ctx.jobs.afterActivation({id:'next'},()=>ctx.fs.writeFile('next.bin',new Uint8Array([65]),{expect:{kind:'absent'}}));
  `);
  try {
    await b.runtime.settleWork(b.id, ["ordinary"]).catch((error) => {
      assert(
        error instanceof Error && error.message === "service job cancelled",
      );
    });
    // Cancellation rejects its cohort immediately; the already-admitted peer
    // still owns its own completion and must finish before inspecting its bytes.
    const status = await jobSettled(b);
    assertEquals(status.status, "ready");
    assertEquals(status.jobs, [{ id: "self-cancel", state: "cancelled" }, {
      id: "next",
      state: "succeeded",
    }]);
    assertEquals(await Deno.readTextFile(`${b.fixture.vault}/next.bin`), "A");
  } finally {
    await b.close();
  }
});

Deno.test("service jobs: shipped held recovery precedes captures while note save and unrelated guard complete", async () => {
  let armed = false, closed = false;
  const first = await backupFixture({
    fault(method, args, at) {
      if (
        armed && method === "fs.writeFile" && at === "before" &&
        String(args[0]).endsWith(".0.bak")
      ) throw new FsError("fs_io_error");
    },
  });
  let next: Awaited<ReturnType<typeof backupFixture>> | undefined;
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const publications: string[] = [];
  try {
    await first.create("Ordered", "A");
    await first.save("Ordered", "B");
    await first.status();
    armed = true;
    await first.save("Ordered", "C");
    await first.status();
    await first.close();
    closed = true;
    next = await backupFixture({
      fixture: first.fixture,
      fault: async (method, args, at) => {
        if (method === "fs.writeFile" && String(args[0]).endsWith(".0.bak")) {
          if (at === "before" && !publications.length) {
            held.resolve();
            await release.promise;
          }
          if (at === "after") {
            publications.push(new TextDecoder().decode(args[1] as Uint8Array));
          }
        }
      },
    });
    await jobBoundary(
      next,
      held.promise,
      "shipped recovery publication entered",
    );
    assertEquals(next.runtime.status(next.id)!.jobs, [{
      id: "backup-recovery",
      state: "running",
    }]);
    await next.fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
    }, {
      "service.js":
        `export function activate(ctx){let count=0;ctx.hooks.on('pre-save',()=>{count++;return {};});ctx.commands.register({id:'count',label:'Count',target:'server'},()=>count);}`,
    });
    await next.runtime.reconcile();
    await pluginReady(next.runtime, "guard");
    await next.save("Ordered", "D");
    assertEquals(await next.runtime.invokeCommand("guard", "count", {}), 1);
    assertEquals(next.runtime.status(next.id)!.versioningPending, 1);
    assertEquals(publications, []);
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Ordered.md`),
      "D",
    );
    assert(
      await Deno.stat(`${first.fixture.vault}/.globnotes-backup/active.json`),
    );
    let statusReturned = false;
    const status = next.status().then((value) => {
      statusReturned = true;
      return value;
    });
    assertEquals(statusReturned, false, "status keeps ordinary FIFO ownership");
    release.resolve();
    assertEquals((await status).completed, 2);
    assertEquals(publications, ["B", "C"]);
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Ordered.md.0.bak`),
      "C",
    );
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Ordered.md.1.bak`),
      "B",
    );
    assertEquals(next.runtime.status(next.id)!.jobs, [{
      id: "backup-recovery",
      state: "succeeded",
    }]);
    console.log(
      JSON.stringify({
        heldRecoveryReady: true,
        job: "running",
        pendingJournal: true,
        captureEffectsWhileHeld: 0,
        guardCompleted: true,
        publicationOrder: publications,
      }),
    );
  } finally {
    release.resolve();
    if (next) await next.close();
    else if (!closed) await first.close();
  }
});
function offer(text: string) {
  return {
    operationId: crypto.randomUUID(),
    path: "Note.md",
    kind: "replace" as const,
    bytes: encoder.encode(text),
    version: "a".repeat(64),
    size: text.length,
    origin: "api",
  };
}
function generic(
  code: string,
  fault?: RpcFault,
  limits?: Partial<PluginLimits>,
  writable?: () => boolean,
) {
  return pluginOperationsFixture({
    serviceEligibility: fixtureServiceEligibility({ writable }),
    id: "jobs",
    manifest: {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
      versioning: { extensions: [".md"] },
      capabilities: {
        read: ["vault"],
        filesystem: { read: ["vault"], write: ["vault"] },
      },
    },
    files: {
      "service.js":
        `export function activate(ctx) { ctx.hooks.on('pre-save',()=>({})); ${code} }`,
    },
    fault,
    limits,
  });
}
async function jobSettled(b: Awaited<ReturnType<typeof generic>>) {
  await b.runtime.settleWork(b.id, ["ordinary"]);
  const status = b.runtime.status(b.id)!;
  assert(
    status.jobs.length &&
      status.jobs.every((job) => !["pending", "running"].includes(job.state)),
  );
  return status;
}

function jobBoundary(
  b: Pick<Awaited<ReturnType<typeof generic>>, "runtime" | "id">,
  entry: Promise<void>,
  label: string,
) {
  return workMilestone(b.runtime.settleWork(b.id, ["ordinary"]), entry, label);
}

/** Observe the real released filesystem RPC, not job status or fixture teardown.
 * Install while its fixture-owned before gate is held; preserve its real outcome. */
function filesystemCompletion(
  b: Pick<Awaited<ReturnType<typeof generic>>, "filesystem">,
  method: string,
  path: string,
): Promise<unknown> {
  const rpc = b.filesystem.rpc.bind(b.filesystem);
  const completion = Promise.withResolvers<unknown>();
  completion.promise.catch(() => undefined);
  b.filesystem.rpc = (...args) => {
    const running = rpc(...args);
    if (args[1] === method && args[2][0] === path) {
      running.then(completion.resolve, completion.reject);
    }
    return running;
  };
  return completion.promise;
}

for (const outcome of ["succeeded", "failed"] as const) {
  Deno.test(`service jobs: ordinary settlement includes post-activation job ${outcome}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const b = await generic(
      `ctx.jobs.afterActivation({id:'observed'},async()=>{
      await ctx.fs.stat('hold');
      ${outcome === "failed" ? "throw Error('expected job failure');" : ""}
    });`,
      async (method, args, at) => {
        if (method === "fs.stat" && args[0] === "hold" && at === "before") {
          entered.resolve();
          await release.promise;
        }
      },
    );
    try {
      await jobBoundary(b, entered.promise, "observed job entered");
      const snapshot = b.runtime.settlement(b.id, ["ordinary"]);
      assertEquals(snapshot.pending, 1);
      assertEquals(
        b.runtime.settlement(b.id, ["versioning", "guard", "startup"]).pending,
        0,
      );
      let settled = false;
      const completion = b.runtime.settleWork(b.id, ["ordinary"]).then(() =>
        settled = true
      );
      await Promise.resolve();
      assertEquals(settled, false);
      assertEquals(b.runtime.status(b.id)!.jobs, [{
        id: "observed",
        state: "running",
      }]);
      release.resolve();
      await completion;
      assert(settled);
      assertEquals(b.runtime.settlement(b.id, ["ordinary"]).pending, 0);
      const status = b.runtime.status(b.id)!;
      assertEquals(status.jobs, [{
        id: "observed",
        state: outcome,
        ...(outcome === "failed" ? { code: "plugin_job_failed" } : {}),
      }]);
      assertEquals(status.degraded, outcome === "failed");
      assertEquals(
        status.diagnostics.some((row) => row.code === "plugin_job_failed"),
        outcome === "failed",
      );
    } finally {
      release.resolve();
      await b.close();
    }
  });
}

Deno.test("service jobs: failed owner rejects a held-boundary wait without entry", async () => {
  const b = await generic(
    `ctx.jobs.afterActivation({id:'one'},()=>{throw Error('before boundary');});`,
  );
  const entry = Promise.withResolvers<void>();
  try {
    await assertRejects(
      () => jobBoundary(b, entry.promise, "unreached job boundary"),
      Error,
      "product work settled without the expected milestone",
    );
  } finally {
    await b.close();
  }
});

for (
  const limits of [{ versioningQueue: 2 }, {
    versioningQueue: 8,
    versioningQueueBytes: 4,
  }]
) {
  Deno.test(`service jobs: bounded dependent FIFO ${JSON.stringify(limits)} waits for recovery, not protection or unrelated versioners; catalogue does not replay`, async () => {
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const effects: string[] = [];
    const b = await generic(
      `
    ctx.jobs.afterActivation({id:'recover'}, async()=>{await ctx.fs.stat('hold');await ctx.fs.writeFile('recovered.bin',new Uint8Array([65]),{expect:{kind:'absent'}});});
    ctx.versioning.onOffer(o=>ctx.fs.writeFile('capture-'+new TextDecoder().decode(o.bytes)+'.bin',o.bytes,{expect:{kind:'absent'}}),{after:['recover']});
  `,
      async (method, args, at) => {
        if (method === "fs.stat" && args[0] === "hold" && at === "before") {
          held.resolve();
          await release.promise;
        }
        if (
          method === "fs.writeFile" && at === "after" &&
          !String(args[0]).startsWith("fast-")
        ) {
          effects.push(
            String(args[0]),
          );
        }
      },
      limits,
    );
    try {
      await jobBoundary(b, held.promise, "bounded FIFO recovery entered");
      assertEquals(b.runtime.status(b.id)!.jobs, [{
        id: "recover",
        state: "running",
      }]);
      await b.fixture.install("fast", {
        runtime: { server: "service.js" },
        versioning: {},
        capabilities: { read: ["vault"], filesystem: { write: ["vault"] } },
      }, {
        "service.js":
          `export function activate(ctx){ctx.versioning.onOffer(o=>ctx.fs.writeFile('fast-'+new TextDecoder().decode(o.bytes)+'.bin',o.bytes,{expect:{kind:'absent'}}));}`,
      });
      await b.runtime.reconcile();
      await pluginReady(b.runtime, "fast");
      for (const text of ["aa", "bb", "cc"]) b.runtime.enqueue([offer(text)]);
      assertEquals(b.runtime.status(b.id)!.versioningPending, 2);
      await b.runtime.guard("pre-save", { operationId: "guard", path: "Note" });
      await b.runtime.settleWork("fast", ["versioning"]);
      assertEquals(
        await Deno.readTextFile(`${b.fixture.vault}/fast-cc.bin`),
        "cc",
      );
      for (let i = 0; i < 3; i++) {
        const catalog = await b.manager.catalog();
        assertEquals(catalog.plugins.find((p) => p.id === b.id)!.jobs, [{
          id: "recover",
          state: "running",
        }]);
      }
      assertEquals(effects, []);
      release.resolve();
      await jobSettled(b);
      await b.runtime.settleWork(b.id, ["versioning"]);
      assertEquals(b.runtime.status(b.id)!.versioningPending, 0);
      assertEquals(effects, [
        "recovered.bin",
        "capture-bb.bin",
        "capture-cc.bin",
      ]);
      assertEquals(
        await Deno.readTextFile(`${b.fixture.vault}/capture-cc.bin`),
        "cc",
      );
      assert(
        b.runtime.status(b.id)!.diagnostics.some((d) =>
          d.code === "versioning_gap"
        ),
      );
      assertEquals(b.runtime.status(b.id)!.jobs, [{
        id: "recover",
        state: "succeeded",
      }]);
    } finally {
      release.resolve();
      await b.close();
    }
  });
}

Deno.test("service jobs: blocked offers retain ordinary deadline", async () => {
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const b = await generic(
    `
    ctx.jobs.afterActivation({id:'one'},()=>ctx.fs.stat('hold'));
    ctx.versioning.onOffer(o=>ctx.fs.writeFile('captured.bin',o.bytes,{expect:{kind:'absent'}}),{after:['one']});
  `,
    async (method, args, at) => {
      if (method === "fs.stat" && args[0] === "hold" && at === "before") {
        held.resolve();
        await release.promise;
      }
    },
  );
  const original = processClock.deadline;
  let expire: (() => void) | undefined;
  try {
    await jobBoundary(b, held.promise, "deadline dependency recovery entered");
    processClock.deadline = (budget, callback) => {
      assertEquals(budget, 30000);
      expire = callback;
      return () => {};
    };
    b.runtime.enqueue([offer("expired")]);
    processClock.deadline = original;
    assert(expire);
    const expired = assertRejects(
      () => b.runtime.settleWork(b.id, ["versioning"]),
      Error,
      "deadline exceeded while queued",
    );
    expire();
    await expired;
    assertEquals(b.runtime.status(b.id)!.versioningPending, 0);
    assertEquals(b.runtime.status(b.id)!.status, "ready");
    release.resolve();
    await jobSettled(b);
    await assertRejects(
      () => Deno.stat(`${b.fixture.vault}/captured.bin`),
      Deno.errors.NotFound,
    );
  } finally {
    processClock.deadline = original;
    release.resolve();
    await b.close();
  }
});

Deno.test("service jobs: render and driver roles cannot register startup work", async () => {
  const fixture = await pluginFixture();
  const dir = await fixture.install("render-job", {}, {
    "main.js":
      `export function onSync(ctx){ctx.jobs.afterActivation({id:'bad'},()=>{});}`,
  });
  const render = new PluginHost(
    readManifest(dir),
    fixture.vault,
    () => Promise.resolve(null),
    1,
  );
  const driver = await driverFixture(
    `export function activate(ctx){ctx.jobs.afterActivation({id:'bad'},()=>{});}`,
  );
  const host = new PluginHost(
    driver.manifest,
    driver.vault,
    () => Promise.resolve(null),
    1,
    { role: "driver", instance: { id: "one", label: "One", settings: {} } },
  );
  try {
    await assertRejects(() => render.start());
    await assertRejects(() => host.start());
    assertEquals(render.serviceJobs.snapshot, []);
    assertEquals(host.serviceJobs.snapshot, []);
  } finally {
    render.stop();
    host.stop();
    await fixture.dispose();
    await driver.dispose();
  }
});

Deno.test("service jobs: documented public example executes unchanged", async () => {
  const docs = await Deno.readTextFile(
    new URL("../docs/plugin-api.md", import.meta.url),
  );
  const source =
    docs.split("## Post-activation service jobs (contract 2)")[1].match(
      /```js\n([\s\S]+?)\n```/,
    )![1];
  const b = await pluginOperationsFixture({
    id: "example",
    manifest: {
      runtime: { server: "service.js" },
      versioning: {},
      capabilities: { read: ["vault"], filesystem: { read: ["vault"] } },
    },
    files: { "service.js": source },
  });
  try {
    assertEquals((await jobSettled(b)).jobs[0]?.state, "succeeded");
    b.runtime.enqueue([offer("example")]);
    await b.runtime.settleWork(b.id, ["versioning"]);
    assertEquals(b.runtime.status(b.id)!.versioningPending, 0);
    assertEquals(b.runtime.status(b.id)!.deliveryFailures, 0);
  } finally {
    await b.close();
  }
});

Deno.test("service jobs: runtime retains timeout failure after host detach and replacement owns fresh records", async () => {
  const original = processClock.deadline;
  let expire: (() => void) | undefined;
  let b: Awaited<ReturnType<typeof generic>> | undefined;
  try {
    processClock.deadline = (budget, callback) => {
      if (budget === 30000 && !expire) {
        expire = callback;
        return () => {};
      }
      return original.call(processClock, budget, callback);
    };
    b = await generic(
      `ctx.jobs.afterActivation({id:'one'},()=>new Promise(()=>{}));`,
    );
    processClock.deadline = original;
    const generation = b.runtime.status(b.id)!.generation;
    assert(expire);
    expire();
    assertEquals(b.runtime.status(b.id)!.status, "failed");
    await b.runtime.retireOwner(b.id, false, true);
    assertEquals(b.runtime.status(b.id)!.generation, null);
    assertEquals(b.runtime.status(b.id)!.jobs, [{
      id: "one",
      state: "failed",
      code: "plugin_job_deadline",
    }]);
    await Deno.writeTextFile(
      `${b.dir}/service.js`,
      `export function activate(ctx){ctx.hooks.on('pre-save',()=>({}));ctx.jobs.afterActivation({id:'one'},()=>{});}`,
    );
    await b.runtime.retireOwner(b.id, true, true);
    await b.runtime.reconcile();
    await pluginReady(b.runtime, b.id);
    assertEquals((await jobSettled(b)).jobs[0]?.state, "succeeded");
    assert(b.runtime.status(b.id)!.generation !== generation);
    assertEquals(b.runtime.status(b.id)!.jobs, [{
      id: "one",
      state: "succeeded",
    }]);
  } finally {
    processClock.deadline = original;
    await b?.close();
  }
});

Deno.test("service jobs: active deadline revokes held real write, not just its status", async () => {
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = processClock.deadline;
  let expire: (() => void) | undefined;
  let b: Awaited<ReturnType<typeof generic>> | undefined;
  try {
    processClock.deadline = (budget, callback) => {
      if (budget === 30000 && !expire) {
        expire = callback;
        return () => {};
      }
      return original.call(processClock, budget, callback);
    };
    b = await generic(
      `ctx.jobs.afterActivation({id:'one'},()=>ctx.fs.writeFile('timeout.bin',new Uint8Array([65]),{expect:{kind:'absent'}}));`,
      async (method, args, at) => {
        if (
          method === "fs.writeFile" && args[0] === "timeout.bin" &&
          at === "before"
        ) {
          held.resolve();
          await release.promise;
        }
      },
    );
    processClock.deadline = original;
    await jobBoundary(b, held.promise, "deadline write entered");
    const completed = filesystemCompletion(b, "fs.writeFile", "timeout.bin");
    assert(expire);
    expire();
    const target = `${b.fixture.vault}/timeout.bin`;
    assertEquals(b.runtime.status(b.id)!.jobs, [{
      id: "one",
      state: "failed",
      code: "plugin_job_deadline",
    }]);
    release.resolve();
    const rejection = await assertRejects(
      () => completed,
      FsError,
      "fs_generation_revoked",
    );
    assertEquals(rejection.effect, "none");
    await assertRejects(() => Deno.stat(target), Deno.errors.NotFound);
  } finally {
    processClock.deadline = original;
    release.resolve();
    await b?.close();
  }
});

Deno.test("service jobs: held disclosure cannot feed retired source bytes into later effects", async () => {
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const fixture = await pluginFixture();
  await Deno.writeTextFile(`${fixture.vault}/input.bin`, "private bytes");
  const b = await pluginOperationsFixture({
    id: "reader",
    fixture,
    manifest: {
      runtime: { server: "service.js" },
      capabilities: { filesystem: { read: ["vault"], write: ["vault"] } },
    },
    files: {
      "service.js":
        `export function activate(ctx){ctx.jobs.afterActivation({id:'read'},async()=>{const bytes=await ctx.fs.readFile('input.bin');await ctx.fs.writeFile('disclosed.bin',bytes,{expect:{kind:'absent'}});});}`,
    },
    fault: async (method, args, at) => {
      if (
        method === "fs.readFile" && args[0] === "input.bin" && at === "after"
      ) {
        held.resolve();
        await release.promise;
      }
    },
  });
  try {
    await jobBoundary(b, held.promise, "held disclosure read entered");
    await Deno.writeTextFile(`${b.dir}/extra.js`, "new source");
    release.resolve();
    assertEquals((await jobSettled(b)).jobs[0].state, "failed");
    await assertRejects(
      () => Deno.stat(`${fixture.vault}/disclosed.bin`),
      Deno.errors.NotFound,
    );
  } finally {
    release.resolve();
    await b.close();
  }
});

Deno.test("service jobs: backup recovery rejection stays visible and a genuine capture retries before publishing", async () => {
  let armed = false;
  const first = await backupFixture({
    fault(method, args, at) {
      if (
        armed && method === "fs.writeFile" && at === "before" &&
        String(args[0]).endsWith(".0.bak")
      ) throw new FsError("fs_io_error");
    },
  });
  let next: Awaited<ReturnType<typeof backupFixture>> | undefined,
    closed = false;
  try {
    await first.create("Retry", "A");
    await first.save("Retry", "B");
    await first.status();
    armed = true;
    await first.save("Retry", "C");
    await first.status();
    await first.close();
    closed = true;
    let failOnce = true;
    const publications: string[] = [];
    next = await backupFixture({
      fixture: first.fixture,
      fault(method, args, at) {
        if (
          method === "fs.writeFile" && at === "before" &&
          String(args[0]).endsWith(".0.bak")
        ) {
          if (failOnce) {
            failOnce = false;
            throw new FsError("fs_io_error");
          }
          publications.push(new TextDecoder().decode(args[1] as Uint8Array));
        }
      },
    });
    const failed = await next.status();
    assertEquals(failed.failed, 1);
    assert(failed.pendingRecovery);
    assertEquals(next.runtime.status(next.id)!.jobs, [{
      id: "backup-recovery",
      state: "failed",
      code: "plugin_job_failed",
    }]);
    assertEquals(next.runtime.status(next.id)!.status, "ready");
    assert(
      await Deno.stat(`${first.fixture.vault}/.globnotes-backup/active.json`),
    );
    await next.save("Retry", "D");
    const recovered = await next.status();
    assertEquals(publications, ["B", "C"]);
    assertEquals(recovered.completed, 2);
    assertEquals(recovered.failed, 1);
    assertEquals(recovered.pendingRecovery, false);
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Retry.md.0.bak`),
      "C",
    );
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Retry.md.1.bak`),
      "B",
    );
    assertEquals(next.runtime.status(next.id)!.jobs[0].state, "failed");
    await assertRejects(
      () => Deno.stat(`${first.fixture.vault}/.globnotes-backup/active.json`),
      Deno.errors.NotFound,
    );
  } finally {
    if (next) await next.close();
    else if (!closed) await first.close();
  }
});

Deno.test("service jobs: rejection releases settlement dependency with value-free failure and live worker", async () => {
  const b = await generic(`
    ctx.jobs.afterActivation({id:'recover'},()=>{throw Error('PRIVATE-JOURNAL-CONTENT');});
    ctx.versioning.onOffer(o=>ctx.fs.writeFile('later.bin',o.bytes,{expect:{kind:'absent'}}),{after:['recover']});
  `);
  try {
    const status = await jobSettled(b);
    assertEquals(status.status, "ready");
    assert(status.degraded);
    assertEquals(status.jobs, [{
      id: "recover",
      state: "failed",
      code: "plugin_job_failed",
    }]);
    assertEquals(
      status.diagnostics.filter((d) => d.code === "plugin_job_failed").length,
      1,
    );
    assert(
      !JSON.stringify(await b.manager.catalog()).includes(
        "PRIVATE-JOURNAL-CONTENT",
      ),
    );
    b.runtime.enqueue([offer("later")]);
    await b.runtime.settleWork(b.id, ["versioning"]);
    assertEquals(b.runtime.status(b.id)!.versioningPending, 0);
    assertEquals(
      await Deno.readTextFile(`${b.fixture.vault}/later.bin`),
      "later",
    );
  } finally {
    await b.close();
  }
});

for (const mode of ["active", "queued"] as const) {
  Deno.test(`service jobs: ${mode} observed deadline preserves terminal failure through retirement`, async () => {
    const fixture = await pluginFixture();
    const dir = await fixture.install("deadlines", {
      runtime: { server: "service.js" },
    }, {
      "service.js": `export function activate(ctx){
        ctx.jobs.afterActivation({id:'first'},()=>new Promise(()=>{}));
        ctx.jobs.afterActivation({id:'second'},()=>new Promise(()=>{}));
        ctx.commands.register({id:'guard',label:'Guard',target:'server'},()=>null);
      }`,
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      () => Promise.resolve(null),
      1,
      { role: "service" },
    );
    const original = processClock.deadline;
    const deadlines: { fire(): void; cancelled: boolean }[] = [];
    try {
      await host.start();
      processClock.deadline = (budget, fire) => {
        assertEquals(budget, 30_000);
        const entry = { fire, cancelled: false };
        deadlines.push(entry);
        return () => {
          entry.cancelled = true;
        };
      };
      host.admitServiceJobs();
      processClock.deadline = original;
      assertEquals(host.serviceJobs.snapshot.map((j) => j.state), [
        "running",
        "pending",
      ]);
      assert(
        host.available,
        "native heartbeat-qualified async hang stays live until invocation deadline",
      );
      deadlines[mode === "active" ? 0 : 1].fire();
      if (mode === "queued") {
        assert(host.available);
        assertEquals(host.serviceJobs.snapshot.map((j) => j.state), [
          "running",
          "failed",
        ]);
      } else assert(!host.available);
      host.stop();
      assertEquals(
        host.serviceJobs.snapshot,
        mode === "active"
          ? [
            { id: "first", state: "failed", code: "plugin_job_deadline" },
            { id: "second", state: "cancelled" },
          ]
          : [
            { id: "first", state: "cancelled" },
            { id: "second", state: "failed", code: "plugin_job_deadline" },
          ],
      );
    } finally {
      processClock.deadline = original;
      host.stop();
      await fixture.dispose();
    }
  });
}

for (
  const code of [
    `ctx.jobs.afterActivation({id:'same'},()=>{});ctx.jobs.afterActivation({id:'same'},()=>{});`,
    `ctx.jobs.afterActivation({id:'bad',timeout:1},()=>{});`,
    `ctx.jobs.afterActivation({id:'../bad'},()=>{});`,
    `ctx.versioning.onOffer(()=>{},{after:['missing']});`,
    `ctx.jobs.afterActivation({id:'one'},()=>{});ctx.versioning.onOffer(()=>{},{after:['one','one']});`,
    `ctx.versioning.onOffer(()=>{},{later:[]});`,
    `ctx.versioning.onOffer(()=>{},null);`,
    `ctx.versioning.onOffer(()=>{},{after:'one'});`,
    `ctx.jobs.afterActivation({id:'one'},null);`,
    `const dispose=ctx.jobs.afterActivation({id:'gone'},()=>{});ctx.versioning.onOffer(()=>{},{after:['gone']});dispose();`,
  ]
) {
  Deno.test(`service jobs: invalid declaration fails activation ${code}`, async () => {
    await assertRejects(() => generic(code));
  });
}

Deno.test("service jobs: required disposer retires generation; late registration is rejected", async () => {
  for (
    const code of [
      `const remove=ctx.jobs.afterActivation({id:'one'},()=>{});ctx.versioning.onOffer(()=>{},{after:['one']});ctx.commands.register({id:'change',label:'Change',target:'server'},()=>remove());`,
      `const remove=ctx.jobs.afterActivation({id:'one'},()=>{});const off=ctx.versioning.onOffer(()=>{},{after:['one']});ctx.commands.register({id:'change',label:'Change',target:'server'},()=>{off();remove();});`,
      `ctx.commands.register({id:'change',label:'Change',target:'server'},()=>ctx.jobs.afterActivation({id:'late'},()=>{}));`,
    ]
  ) {
    const b = await generic(code);
    try {
      const changed = b.command("change");
      if (code.includes("remove()")) {
        await assertRejects(
          () => changed,
          Error,
          "required job registration disposed",
        );
        assertEquals(b.runtime.status(b.id)!.status, "failed");
      } else {
        await assertRejects(() => changed);
        assertEquals(b.runtime.status(b.id)!.jobs, []);
      }
    } finally {
      await b.close();
    }
  }
});

for (
  const change of [
    "disable",
    "source",
    "read-only",
    "suspend",
    "shutdown",
  ] as const
) {
  Deno.test(`service jobs: held real filesystem effect cannot borrow ${change} authority`, async () => {
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let writable = true;
    const b = await generic(
      `ctx.jobs.afterActivation({id:'one'},()=>ctx.fs.writeFile('late.bin',new Uint8Array([65]),{expect:{kind:'absent'}}));`,
      async (method, args, at) => {
        if (
          method === "fs.writeFile" && args[0] === "late.bin" && at === "before"
        ) {
          held.resolve();
          await release.promise;
        }
      },
      undefined,
      () => writable,
    );
    try {
      await jobBoundary(b, held.promise, `${change} write entered`);
      const completed = filesystemCompletion(b, "fs.writeFile", "late.bin");
      if (change === "disable") await b.runtime.retireOwner(b.id, false, true);
      if (change === "source") {
        await Deno.writeTextFile(`${b.dir}/extra.js`, "changed");
      }
      if (change === "read-only") writable = false;
      if (change === "suspend") b.runtime.suspend();
      if (change === "shutdown") await b.runtime.close();
      release.resolve();
      const code = change === "source"
        ? "fs_source_changed"
        : change === "read-only"
        ? "fs_denied"
        : "fs_generation_revoked";
      const rejection = await assertRejects(() => completed, FsError, code);
      assertEquals(rejection.effect, "none");
      if (["source", "read-only"].includes(change)) await jobSettled(b);
      assert(b.runtime.status(b.id)!.jobs[0].state !== "running");
      await assertRejects(
        () => Deno.stat(`${b.fixture.vault}/late.bin`),
        Deno.errors.NotFound,
      );
      if (["disable", "suspend", "shutdown"].includes(change)) {
        assertEquals(b.runtime.status(b.id)!.jobs[0].state, "cancelled");
      } else assertEquals(b.runtime.status(b.id)!.jobs[0].state, "failed");
    } finally {
      release.resolve();
      await b.close();
    }
  });
}
