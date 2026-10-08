// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { PluginManager } from "../server/plugins/manager.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";

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
