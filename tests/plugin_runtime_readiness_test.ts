// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { PluginManager } from "../server/plugins/manager.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import {
  bounded as livenessBounded,
  until,
  WorkerDeliveryGate,
} from "./helpers/worker_liveness.ts";
import { GlobalConfig } from "../server/config.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { fixtureApiOrigin } from "./helpers/plugin_fixture.ts";

Deno.test("plugin runtime: failed Worker cannot become ready after final policy await", async () => {
  const fixture = await pluginFixture();
  await fixture.install("waiting-observer", {
    runtime: { server: "service.js" },
    hooks: ["on-save"],
  }, {
    "service.js": `export function activate(ctx) {
      ctx.hooks.on('on-save', () => {});
      ctx.commands.register({id:'counts',label:'Counts',target:'server'},()=>0);
      setTimeout(()=>{console.log('POLICY_WAIT_FIXTURE_THROW');throw Error('real policy-wait Worker crash');},500);
    }`,
  });
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    1,
    fixture.statePath,
    { internalRoot: `${fixture.root}/internal` },
  );
  const finalPolicy = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  let reads = 0, released = false;
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
    changed: () => {
      if (
        released &&
        runtime.status("waiting-observer")?.status !== "starting"
      ) settled.resolve();
    },
  });
  const original = manager.network.policy.bind(manager.network);
  manager.network.policy = async (id) => {
    const policy = await original(id);
    if (id === "waiting-observer" && ++reads === 3) {
      finalPolicy.resolve();
      await gate.promise;
    }
    return policy;
  };
  async function bounded(promise: Promise<void>, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error(label)), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await runtime.reconcile();
    await bounded(
      finalPolicy.promise,
      "Final real policy read was not reached",
    );
    const deadline = Date.now() + 3000;
    while (runtime.status("waiting-observer")?.status !== "failed") {
      assert(
        Date.now() < deadline,
        "Real Worker did not fail during policy await",
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const before = runtime.status("waiting-observer");
    assert(
      before?.diagnostics.some((item) => item.code === "plugin_runtime_failed"),
    );
    await Deno.writeTextFile(
      `${fixture.root}/before-policy-release.json`,
      JSON.stringify({ before, commands: runtime.commands(), reads }, null, 2),
    );
    released = true;
    gate.resolve();
    await bounded(settled.promise, "Final policy continuation did not settle");
    const catalogue = await manager.catalog();
    const after = catalogue.plugins.find((plugin) =>
      plugin.id === "waiting-observer"
    );
    await Deno.writeTextFile(
      `${fixture.root}/after-policy-release.json`,
      JSON.stringify(
        {
          after,
          enabled: runtime.isEnabled("waiting-observer"),
          commands: runtime.commands(),
        },
        null,
        2,
      ),
    );
    assertEquals(
      after?.status,
      "failed",
      "A failed candidate was republished ready",
    );
    assertEquals(runtime.isEnabled("waiting-observer"), false);
    assertEquals(runtime.commands(), []);
    await assertRejects(
      () => runtime.invokeCommand("waiting-observer", "counts", {}),
      Error,
      "unavailable",
    );
    assertEquals(await runtime.guard("pre-save", {}), []);
  } finally {
    released = true;
    gate.resolve();
    manager.network.policy = original;
    await runtime.close();
    manager.stop();
    console.log(JSON.stringify({ retainedFixture: fixture.root }));
  }
});

Deno.test("startup liveness: service catalog commands endpoints and SDK permissions await accepted heartbeat", async () => {
  const fixture = await pluginFixture();
  await fixture.install("liveness-catalog", {
    runtime: { server: "service.js" },
    capabilities: { network: false, imports: false },
  }, {
    "service.js":
      `export async function activate(ctx){const settings=await ctx.settings.read();const request=await ctx.permissions.requestAccess({kind:'network',hosts:['example.com:443'],reason:'startup admission'});await ctx.permissions.declare({network:['example.com:443'],imports:false});ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>({request,settings}));}`,
    "endpoints/get.js":
      `export default()=>({status:200,body:'actual endpoint consumer'})`,
  });
  const manager = new PluginManager(
    fixture.vault,
    undefined,
    1,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/empty`,
      persistence: { commit: (effect) => effect() },
    },
  );
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  });
  const gate = new WorkerDeliveryGate();
  try {
    await runtime.reconcile();
    await livenessBounded(
      gate.ready.promise,
      "actual service initialized ready",
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const pending = (await manager.catalog()).plugins.find((item) =>
      item.id === "liveness-catalog"
    )!;
    assertEquals(pending.status, "starting");
    assertEquals(pending.commands, []);
    assertEquals(runtime.endpointDescriptors("liveness-catalog"), []);
    assertEquals(pending.permissions!.pendingRequests.length, 1);
    assertEquals(runtime.isEnabled("liveness-catalog"), false);
    await assertRejects(
      () => runtime.invokeCommand("liveness-catalog", "inspect", {}),
      Error,
      "unavailable",
    );
    await livenessBounded(
      gate.heartbeat.promise,
      "actual held service heartbeat",
    );
    gate.holdHeartbeat = false;
    gate.releaseHeartbeat();
    await until(
      () => runtime.status("liveness-catalog")?.status === "ready",
      "final runtime policy/catalog publication",
    );
    const consumed = await runtime.invokeCommand(
      "liveness-catalog",
      "inspect",
      {},
    ) as { request: { requestId: string }; settings: { revision: number } };
    assert(consumed.request.requestId);
    assertEquals(consumed.settings.revision, 0);
    const endpoint = runtime.endpointDescriptors("liveness-catalog")[0];
    assertEquals(
      await runtime.invokeHandler("liveness-catalog", endpoint.handlerId, [{}]),
      { status: 200, body: "actual endpoint consumer" },
    );
    assertEquals(
      (await manager.catalog()).plugins.find((item) =>
        item.id === "liveness-catalog"
      )!.status,
      "ready",
    );
  } finally {
    await runtime.close();
    manager.stop();
    gate.restore();
    console.log(JSON.stringify({ retainedLivenessFixture: fixture.root }));
  }
});

for (const boundary of ["operation", "per-plugin"] as const) {
  Deno.test(`startup liveness: registered required guard awaiting heartbeat fails closed at ${boundary} bound`, async () => {
    const fixture = await pluginFixture();
    await fixture.install("liveness-guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-create"],
    }, {
      "service.js":
        `export function activate(ctx){ctx.hooks.on('pre-create',()=>{});}`,
    });
    const keys = [
        "GLOBNOTES_PATH",
        "GLOBNOTES_INDEX_PATH",
        "GLOBNOTES_AUTH_TYPE",
      ],
      old = keys.map((key) => Deno.env.get(key));
    Deno.env.set(keys[0], fixture.vault);
    Deno.env.set(keys[1], fixture.statePath);
    Deno.env.set(keys[2], "none");
    const config = new GlobalConfig();
    keys.forEach((key, index) =>
      old[index] === undefined
        ? Deno.env.delete(key)
        : Deno.env.set(key, old[index]!)
    );
    const lifecycle = new PluginLifecycle(config);
    const manager = new PluginManager(
      fixture.vault,
      undefined,
      1,
      fixture.statePath,
      {
        internalRoot: `${fixture.root}/empty`,
        persistence: { commit: (effect) => effect() },
      },
    );
    const runtime = manager.configureRuntime({
      operational: () => true,
      writable: () => true,
      commit: (effect) => effect(),
    });
    const gate = new WorkerDeliveryGate();
    try {
      await runtime.reconcile();
      await livenessBounded(
        gate.ready.promise,
        "registered real required guard",
      );
      const origin = performance.now();
      const guarded = boundary === "operation"
        ? runtime.guard("pre-create", {}, Date.now() + 100)
        : new NoteOperations({
          notes: new FileSystemNotes(fixture.vault),
          files: new FileServing(fixture.vault),
          indexer: null,
          runtime: () => runtime,
          lifecycle,
        }).createNote(
          { path: "forbidden", content: "must not mutate" },
          fixtureApiOrigin(lifecycle),
        );
      const error = await livenessBounded(
        guarded.catch((error) => error),
        "required guard deadline",
        7000,
      );
      assertEquals(error.code, "plugin_guard_failed");
      assertEquals(error.status, 503);
      const elapsed = performance.now() - origin;
      assert(
        elapsed >= (boundary === "operation" ? 90 : 4900) &&
          elapsed < (boundary === "operation" ? 1500 : 6500),
      );
      assertEquals(runtime.status("liveness-guard")!.status, "starting");
      await assertRejects(
        () => Deno.stat(`${fixture.vault}/forbidden.md`),
        Deno.errors.NotFound,
      );
      assertEquals(
        (await manager.catalog()).plugins.find((item) =>
          item.id === "liveness-guard"
        )!.blocking.active,
        true,
      );
      console.log(
        JSON.stringify({
          guardBoundary: boundary,
          elapsed,
          errorCode: error.code,
          noFilesystemMutation: true,
          retainedLivenessFixture: fixture.root,
        }),
      );
    } finally {
      await runtime.close();
      manager.stop();
      gate.restore();
    }
  });
}
