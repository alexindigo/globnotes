// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  installedSource,
  sourceDigest,
} from "../server/plugins/installed_source.ts";
import { installedCodeFingerprint } from "../server/plugins/network_requests.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { PluginContractError } from "../server/plugins/contracts.ts";
import { PluginSettingsEnvironment } from "../server/plugins/settings_environment.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

async function bundle(environment?: string) {
  const fixture = await pluginFixture();
  const dir = await fixture.install("inventory-probe", {
    settings: [fixturePage],
  });
  const manager = createPluginManager(
    fixture.vault,
    undefined,
    0,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/internal`,
      persistence: { commit: (effect) => effect() },
      settingsEnvironment: new PluginSettingsEnvironment(environment),
    },
  );
  return {
    ...fixture,
    dir,
    manager,
    close: async () => {
      manager.stop();
      await fixture.dispose();
    },
  };
}

Deno.test("inventory owner: unchanged bytes, policy and nested projections keep one immutable source revision", async () => {
  const b = await bundle();
  try {
    await b.manager.catalog();
    const source = b.manager.installed.get("inventory-probe")!;
    const revision = b.manager.installed.revision;
    assert(Object.isFrozen(source.manifest!.settings[0].fields));
    const raw = await Deno.readTextFile(`${b.dir}/manifest.json`);
    await Deno.writeTextFile(`${b.dir}/manifest.json`, raw);
    const { metadata } = await b.manager.policy.read();
    await b.manager.policy.setEnabled("inventory-probe", false, metadata);
    const disabled = await b.manager.catalog();
    assertEquals(disabled.plugins[0].status, "disabled");
    assertEquals(b.manager.installed.revision, revision);
    assertEquals(b.manager.installed.get("inventory-probe"), source);
    assertEquals(
      b.manager.network.settingsSchema("inventory-probe"),
      source.manifest!.settings,
    );
    assertEquals(
      b.manager.driverOwner("inventory-probe").manifest,
      source.manifest,
    );
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: same-size same-mtime external bytes invalidate old leases without refresh", async () => {
  const b = await bundle();
  try {
    await Deno.writeTextFile(`${b.dir}/extra.js`, "old");
    const context = b.manager.network.settingsContext("inventory-probe");
    const before = b.manager.installed.revision;
    const stat = await Deno.stat(`${b.dir}/extra.js`);
    await Deno.writeTextFile(`${b.dir}/extra.js`, "new");
    await Deno.utime(`${b.dir}/extra.js`, stat.atime!, stat.mtime!);
    assertEquals(
      assertThrows(() => context.assertCurrent(), PluginContractError).code,
      "plugin_settings_source_conflict",
    );
    assertEquals(b.manager.installed.revision, before + 1);
    assertNotEquals(
      b.manager.network.settingsContext("inventory-probe").codeFingerprint,
      context.codeFingerprint,
    );
    assertEquals(b.manager.installed.revision, before + 1);
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: only the changed selected entry is reparsed", async () => {
  const b = await bundle();
  const parse = JSON.parse;
  let parses = 0;
  try {
    await b.install("sibling", { settings: [fixturePage] });
    b.manager.validateConfiguration();
    const sibling = b.manager.installed.get("sibling");
    const raw = await Deno.readTextFile(`${b.dir}/manifest.json`);
    const changed = raw.replace('"fixture"', '"changed"');
    assertNotEquals(changed, raw);
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === changed) parses++;
      return parse(...args);
    };
    await Deno.writeTextFile(`${b.dir}/manifest.json`, changed);
    b.manager.network.settingsSchema("inventory-probe");
    await b.manager.catalog();
    assertEquals(parses, 1);
    assertEquals(b.manager.installed.get("sibling"), sibling);
  } finally {
    JSON.parse = parse;
    await b.close();
  }
});

Deno.test("inventory owner: invalid override remains selected with protection; removal selects built-in and fences its old lease", async () => {
  const b = await bundle();
  try {
    const internal = `${b.root}/internal/inventory-probe`;
    await Deno.mkdir(internal, { recursive: true });
    await Deno.writeTextFile(
      `${internal}/manifest.json`,
      JSON.stringify({
        id: "inventory-probe",
        name: "Built-in",
        settings: [fixturePage],
      }),
    );
    const lease = b.manager.installed.lease("inventory-probe");
    await Deno.writeTextFile(
      `${b.dir}/service.js`,
      "export function activate(){}",
    );
    await Deno.writeTextFile(
      `${b.dir}/manifest.json`,
      JSON.stringify({
        id: "inventory-probe",
        runtime: { server: "service.js" },
        hooks: ["pre-delete"],
        settings: "invalid",
      }),
    );
    const invalid = b.manager.installed.current("inventory-probe")!;
    assertEquals(invalid.dir, b.dir);
    assertEquals(invalid.manifest, undefined);
    assertEquals(invalid.hooks, ["pre-delete"]);
    assertEquals((await b.manager.catalog()).plugins[0].blocking.actions, [
      "delete",
    ]);
    assertThrows(() => lease.assertCurrent(), PluginContractError);
    await Deno.remove(b.dir, { recursive: true });
    assertEquals(
      b.manager.driverOwner("inventory-probe").manifest?.name,
      "Built-in",
    );
    assertThrows(() => lease.assertCurrent(), PluginContractError);
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: outer discovery sees additions/removals and keeps policy order separate", async () => {
  const b = await bundle();
  try {
    b.manager.validateConfiguration();
    const before = b.manager.installed.revision;
    const dir = await b.install("added", { settings: [fixturePage] });
    // Per-ID admission can discover a new entry before an outer list refresh.
    b.manager.driverOwner("added");
    assertEquals(b.manager.installed.revision, before + 1);
    assertEquals(b.manager.listPlugins().map((p) => p.id), [
      "added",
      "inventory-probe",
    ]);
    assertEquals(b.manager.installed.revision, before + 1);
    await Deno.remove(dir, { recursive: true });
    assertEquals((await b.manager.catalog()).plugins.map((p) => p.id), [
      "inventory-probe",
    ]);
    assertEquals(b.manager.installed.revision, before + 2);
    await Deno.remove(b.dir, { recursive: true });
    assertEquals(b.manager.driverOwner("inventory-probe").enabled, false);
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: contained symlink retarget, cycle and external escape invalidate source without watcher delivery", async () => {
  const b = await bundle();
  try {
    await Deno.writeTextFile(`${b.dir}/one.js`, "same");
    await Deno.writeTextFile(`${b.dir}/two.js`, "same");
    await Deno.symlink("one.js", `${b.dir}/link.js`);
    const lease = b.manager.installed.lease("inventory-probe");
    await Deno.remove(`${b.dir}/link.js`);
    await Deno.symlink("two.js", `${b.dir}/link.js`);
    assertThrows(() => lease.assertCurrent(), PluginContractError);
    const retargeted = b.manager.installed.lease("inventory-probe");
    await Deno.symlink(".", `${b.dir}/cycle`);
    assertThrows(() => retargeted.assertCurrent(), PluginContractError);
    assertEquals(
      b.manager.installed.current("inventory-probe")?.manifest,
      undefined,
    );
    await Deno.remove(`${b.dir}/cycle`);
    await Deno.remove(`${b.dir}/link.js`);
    await Deno.writeTextFile(`${b.root}/outside.js`, "outside");
    await Deno.symlink(`${b.root}/outside.js`, `${b.dir}/link.js`);
    assertEquals(
      b.manager.installed.current("inventory-probe")?.manifest,
      undefined,
    );
    await Deno.remove(`${b.dir}/link.js`);
    assert(b.manager.installed.current("inventory-probe")?.manifest);
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: discovery topology changes revision even when historical code digest is unchanged", async () => {
  const b = await bundle();
  try {
    const lease = b.manager.installed.lease("inventory-probe");
    const before = b.manager.installed.revision;
    await Deno.mkdir(`${b.dir}/endpoints`);
    assertThrows(() => lease.assertCurrent(), PluginContractError);
    const current = b.manager.installed.current("inventory-probe")!;
    assertEquals(current.fingerprint, lease.entry.fingerprint);
    assertEquals(current.manifest?.hasEndpoints, true);
    assertEquals(b.manager.installed.revision, before + 1);
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: manifest and fingerprint share captured bytes and preserve code hash compatibility", async () => {
  const b = await bundle();
  try {
    const raw = await Deno.readTextFile(`${b.dir}/manifest.json`);
    await Deno.writeTextFile(`${b.dir}/extra.js`, "example");
    const source = installedSource(b.dir);
    const expected = sourceDigest(JSON.stringify([
      { path: "extra.js", hash: sourceDigest("example") },
      { path: "manifest.json", hash: sourceDigest(raw) },
    ]));
    assertEquals(source.fingerprint, expected);
    assertEquals(await installedCodeFingerprint(b.dir), expected);
    await Deno.writeTextFile(
      `${b.dir}/manifest.json`,
      raw.replace('"fixture"', '"changed"'),
    );
    assertEquals(
      readManifest(b.dir, source).settings,
      validateSettingsPages([fixturePage]),
    );
    assertNotEquals(
      readManifest(b.dir).settings,
      validateSettingsPages([fixturePage]),
    );
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: addressed settings validate failed and disabled entries, retaining invalidation until repaired", async () => {
  const b = await bundle(
    JSON.stringify({ "inventory-probe": { preferences: { limit: 3 } } }),
  );
  try {
    const { metadata } = await b.manager.policy.read();
    await b.manager.policy.setEnabled("inventory-probe", false, metadata);
    b.manager.validateConfiguration();
    const raw = await Deno.readTextFile(`${b.dir}/manifest.json`);
    await Deno.writeTextFile(
      `${b.dir}/manifest.json`,
      raw.replace('"limit"', '"other"'),
    );
    assertThrows(() => b.manager.validateConfiguration(), PluginContractError);
    assertThrows(
      () => b.manager.installed.get("inventory-probe"),
      PluginContractError,
    );
    await Deno.writeTextFile(`${b.dir}/manifest.json`, raw);
    b.manager.validateConfiguration();
    assert(b.manager.installed.get("inventory-probe")?.manifest);
  } finally {
    await b.close();
  }
});

Deno.test("inventory owner: settings commit after gate wait rechecks external schema without explicit refresh", async () => {
  const b = await bundle();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const definition = b.manager.network.settingsSchema("inventory-probe")[0];
    const data = new PluginDataStore(b.statePath, {
      commit: async (effect) => {
        entered.resolve();
        await release.promise;
        return effect();
      },
      settingsSchema: (id) => b.manager.network.settingsSchema(id),
      settingsContext: (id) => b.manager.network.settingsContext(id),
    });
    pending = data.forPlugin("inventory-probe").savePage(definition, {
      limit: 7,
    }, 0);
    const rejected = assertRejects(() => pending!, PluginContractError);
    await entered.promise;
    const raw = await Deno.readTextFile(`${b.dir}/manifest.json`);
    await Deno.writeTextFile(
      `${b.dir}/manifest.json`,
      raw.replace('"max":10', '"max":4'),
    );
    release.resolve();
    const error = await rejected;
    assert(
      ["plugin_settings_schema_conflict", "plugin_settings_source_conflict"]
        .includes(error.code),
    );
    await assertRejects(
      () =>
        Deno.stat(`${b.statePath}/plugin-data/inventory-probe/settings.json`),
      Deno.errors.NotFound,
    );
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await b.close();
  }
});
