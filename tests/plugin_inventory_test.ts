// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

Deno.test("inventory mechanism regression: unchanged nested consumers never reparse installed manifests", async () => {
  const fixture = await pluginFixture();
  const dir = await fixture.install("inventory-probe", {
    settings: [fixturePage],
  });
  const manifest = await Deno.readTextFile(`${dir}/manifest.json`);
  const manager = createPluginManager(
    fixture.vault,
    undefined,
    0,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/internal`,
      persistence: { commit: (effect) => effect() },
    },
  );
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    if (args[0] === manifest) parses++;
    return parse(...args);
  };
  try {
    await manager.catalog();
    const initial = parses;
    for (let i = 0; i < 3; i++) {
      const context = manager.network.settingsContext("inventory-probe");
      context.assertCurrent();
      manager.driverOwner("inventory-probe");
      await manager.catalog();
    }
    console.log(
      JSON.stringify({
        initialManifestParses: initial,
        warmManifestParses: parses - initial,
      }),
    );
    assertEquals(
      parses - initial,
      0,
      "warm nested reads must not reconstruct installed inventory",
    );
    assertEquals(initial, 1, "one selected source owns one parsed descriptor");
  } finally {
    JSON.parse = parse;
    manager.stop();
    await fixture.dispose();
  }
});
