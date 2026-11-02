// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { readManifest } from "../../server/plugins/manifest.ts";
import {
  PluginRuntime,
  type RuntimeSource,
} from "../../server/plugins/runtime.ts";
import { pluginFixture } from "../helpers/plugin_fixture.ts";

Deno.test("plugin runtime: unknown post-side-effect timeout is not replayed during recovery", async () => {
  const fixture = await pluginFixture();
  const sources: RuntimeSource[] = [];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  }, { serviceCallMs: 80 });
  try {
    const dir = await fixture.install("uncertain", {
      runtime: { server: "service.js" },
    }, {
      "service.js": `export function activate(ctx) {
      ctx.commands.register({ id: 'partial', label: 'Partial', target: 'server' }, async () => { const data = await ctx.data.load(); await ctx.data.save({ n: (data.values.n || 0) + 1 }, data.revision); await new Promise(() => {}); });
      ctx.commands.register({ id: 'inspect', label: 'Inspect', target: 'server' }, async () => (await ctx.data.load()).values);
    }`,
    });
    const manifest = readManifest(dir);
    sources.push({ id: manifest.id, enabled: true, manifest, hooks: [] });
    await runtime.reconcile();
    const deadline = Date.now() + 3000;
    while (
      runtime.status("uncertain")?.status === "starting" &&
      Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    const generation = runtime.status("uncertain")?.generation;
    await assertRejects(
      () => runtime.invokeCommand("uncertain", "partial", {}),
      Error,
      "unknown",
    );
    assertEquals(runtime.status("uncertain")?.status, "failed");
    await runtime.reconcile();
    while (
      runtime.status("uncertain")?.status === "starting" &&
      Date.now() < deadline + 3000
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(await runtime.invokeCommand("uncertain", "inspect", {}), {
      n: 1,
    });
    assert(runtime.status("uncertain")?.generation !== generation);
    assertEquals(runtime.commands().length, 2);
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});
