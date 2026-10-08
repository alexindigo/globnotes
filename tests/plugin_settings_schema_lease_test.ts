// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { GlobalConfig } from "../server/config.ts";
import {
  type JsonValues,
  PluginContractError,
} from "../server/plugins/contracts.ts";
import {
  PluginDataStore,
  type SettingsCommitChange,
} from "../server/plugins/data.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { state } from "../server/state.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";

const settingsPut = (await import(
  new URL(
    "../server/api/endpoints/_/api/plugin-host/%23id/settings/%23page/put.ts",
    import.meta.url,
  ).href
)).default;
const descriptor = (maximum: number) => ({
  id: "preferences",
  label: "Preferences",
  renderer: { kind: "declarative-v1", version: 1 },
  fields: [{
    key: "limit",
    label: "Limit",
    type: "number",
    default: 5,
    min: 0,
    max: maximum,
  }],
});

async function bundle() {
  const fixture = await pluginFixture();
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_READ_ONLY_SETTINGS",
  ];
  const env = keys.map((key) => Deno.env.get(key));
  const previous = {
    config: state.config,
    auth: state.auth,
    lifecycle: state.lifecycle,
    plugins: state.plugins,
    pluginData: state.pluginData,
  };
  Deno.env.set("GLOBNOTES_PATH", fixture.vault);
  Deno.env.set("GLOBNOTES_INDEX_PATH", fixture.statePath);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  Deno.env.delete("GLOBNOTES_READ_ONLY_SETTINGS");
  const config = new GlobalConfig(), lifecycle = new PluginLifecycle(config);
  const commit = <T>(effect: () => Promise<T>) => lifecycle.gate.run(effect);
  const oldPage = validateSettingsPages([descriptor(100)])[0];
  const dir = await fixture.install("coherent", {
    runtime: { server: "service.js" },
    settings: [descriptor(100)],
    capabilities: { network: false, imports: false, read: [], write: [] },
  }, {
    "service.js":
      "export function activate(ctx){ctx.commands.register({id:'inspect',label:'Inspect current schema',target:'server'},()=>ctx.settings.read());}",
  });
  await new PluginDataStore(fixture.statePath, { commit }).forPlugin("coherent")
    .savePage(oldPage, { limit: 5 }, 0);
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    0,
    fixture.statePath,
    { internalRoot: `${fixture.root}/empty-internal`, persistence: { commit } },
  );
  const runtime = manager.configureRuntime({
    operational: () => lifecycle.operational(),
    writable: () => lifecycle.writable(),
    commit,
  });
  // A source-owned synchronous schema resolver is supplied at the existing
  // adapter seam. The old implementation ignores it; no future helper import.
  const adapters = {
    commit,
    prepareSettingsCommit: (change: SettingsCommitChange) =>
      manager.network.prepareSettingsCommit(change),
    settingsSchema: (_id: string) => readManifest(dir).settings,
  };
  const data = new PluginDataStore(fixture.statePath, adapters);
  Object.assign(state, {
    config,
    auth: null,
    lifecycle,
    plugins: manager,
    pluginData: data,
  });
  const untilReady = async () => {
    const deadline = Date.now() + 5000;
    while (runtime.status("coherent")?.status !== "ready") {
      assert(Date.now() < deadline, JSON.stringify(runtime.status("coherent")));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await runtime.reconcile();
  await untilReady();
  const file = `${fixture.statePath}/plugin-data/coherent/settings.json`,
    before = await Deno.readTextFile(file);
  await Deno.writeTextFile(`${fixture.root}/schema-source-before.json`, before);
  console.log(JSON.stringify({ retainedSchemaSourceFixture: fixture.root }));
  return {
    fixture,
    dir,
    oldPage,
    data,
    manager,
    runtime,
    lifecycle,
    file,
    before,
    untilReady,
    async replace(pages: unknown[]) {
      const manifest = JSON.parse(
        await Deno.readTextFile(`${dir}/manifest.json`),
      );
      manifest.settings = pages;
      await Deno.writeTextFile(
        `${dir}/manifest.json`,
        JSON.stringify(manifest),
      );
      const { metadata } = await manager.policy.read();
      await manager.policy.setEnabled("coherent", true, metadata);
      await manager.reconcileOwners({ replaceId: "coherent" });
      await untilReady();
    },
    async close() {
      manager.stop();
      await runtime.close();
      Object.assign(state, previous);
      keys.forEach((key, index) =>
        env[index] === undefined
          ? Deno.env.delete(key)
          : Deno.env.set(key, env[index]!)
      );
    },
  };
}

for (const variant of ["constraint", "field", "page"] as const) {
  Deno.test(`review repairs: R18 schema source coherence held HTTP ${variant} replacement rejects before persistence`, async () => {
    const b = await bundle(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const raw = new Request(
      "http://fixture/_/api/plugin-host/coherent/settings/preferences",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { limit: 50 }, revision: 1 }),
      },
    );
    let pending: Promise<unknown> | undefined;
    try {
      pending = settingsPut(
        {
          _raw: raw,
          params: { id: "coherent", page: "preferences" },
          body: {
            json: async () => {
              entered.resolve();
              await release.promise;
              return raw.json();
            },
          },
        } as unknown as PathfinderRequest,
      );
      await entered.promise;
      const next = variant === "constraint"
        ? [descriptor(10)]
        : variant === "field"
        ? [{
          ...descriptor(10),
          fields: [{
            key: "replacement",
            label: "Replacement",
            type: "text",
            default: "current default",
          }],
        }]
        : [];
      await b.replace(next);
      release.resolve();
      const response = await pending;
      assert(
        response instanceof Response,
        "stale definition must return a structured conflict",
      );
      assertEquals(response.status, 409);
      assertEquals(
        (await response.json()).code,
        "plugin_settings_schema_conflict",
      );
      assertEquals(await Deno.readTextFile(b.file), b.before);
      const consumer = await b.runtime.invokeCommand(
        "coherent",
        "inspect",
        {},
      ) as { revision: number; values: unknown };
      assertEquals(consumer.revision, 1);
      const currentPages = readManifest(b.dir).settings;
      if (currentPages.length) {
        const values: JsonValues = variant === "constraint"
          ? { limit: 8 }
          : { replacement: "fresh current choice" };
        const saved = await b.data.forPlugin("coherent").savePage(
          currentPages[0],
          values,
          1,
        );
        assertEquals(saved.revision, 2);
        assertEquals(saved.values, values);
        assertEquals(
          (await b.data.forPlugin("coherent").page(currentPages[0])).values,
          values,
        );
      } else {
        assertEquals(consumer.values, {});
        assertEquals(
          JSON.parse(await Deno.readTextFile(b.file)).values.preferences,
          { limit: 5 },
        );
      }
      console.log(
        JSON.stringify({
          variant,
          oldWriteNoEffect: true,
          actualCurrentWorkerConsumer: consumer,
        }),
      );
    } finally {
      release.resolve();
      if (pending) await pending.catch(() => undefined);
      await b.close();
    }
  });
}

Deno.test("review repairs: R18 schema source coherence direct owned write rechecks definition after commit-gate wait", async () => {
  const b = await bundle(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const adapters = {
      commit: async <T>(effect: () => Promise<T>) => {
        entered.resolve();
        await release.promise;
        return b.lifecycle.gate.run(effect);
      },
      settingsSchema: (_id: string) => readManifest(b.dir).settings,
    };
    const owner = new PluginDataStore(b.fixture.statePath, adapters).forPlugin(
      "coherent",
    );
    pending = owner.savePage(b.oldPage, { limit: 50 }, 1);
    const rejected = assertRejects(() => pending!, PluginContractError);
    await entered.promise;
    await b.replace([descriptor(10)]);
    release.resolve();
    const error = await rejected;
    assertEquals(error.code, "plugin_settings_schema_conflict");
    assertEquals(await Deno.readTextFile(b.file), b.before);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => undefined);
    await b.close();
  }
});

Deno.test("review repairs: R18 schema source coherence owned read cannot return a replaced definition after storage await", async () => {
  const b = await bundle(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const originalRead = Deno.readTextFile;
  let held = false, pending: Promise<unknown> | undefined;
  try {
    Deno.readTextFile = async (
      ...args: Parameters<typeof Deno.readTextFile>
    ) => {
      const result = await originalRead(...args);
      if (String(args[0]) === b.file && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    pending = b.data.forPlugin("coherent").page(b.oldPage);
    const rejected = assertRejects(() => pending!, PluginContractError);
    await entered.promise;
    await b.replace([{
      ...descriptor(10),
      fields: [{
        key: "replacement",
        label: "Replacement",
        type: "text",
        default: "current default",
      }],
    }]);
    release.resolve();
    const error = await rejected;
    assertEquals(error.code, "plugin_settings_schema_conflict");
    assertEquals(await originalRead(b.file), b.before);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => undefined);
    Deno.readTextFile = originalRead;
    await b.close();
  }
});

Deno.test("review repairs: R18 schema source coherence prepared transition checks after its last asynchronous validation", async () => {
  const b = await bundle(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    // No optional schema resolver here: the prepared owning-source contract
    // independently protects writes through the shared persistence boundary.
    const adapters = {
      commit: <T>(effect: () => Promise<T>) => b.lifecycle.gate.run(effect),
      prepareSettingsCommit: async (change: SettingsCommitChange) => {
        const prepared = await b.manager.network.prepareSettingsCommit(change);
        return {
          ...prepared,
          validateLedgerSnapshot: async () => {
            await prepared.validateLedgerSnapshot();
            entered.resolve();
            await release.promise;
          },
        };
      },
    };
    pending = new PluginDataStore(b.fixture.statePath, adapters).forPlugin(
      "coherent",
    ).savePage(b.oldPage, { limit: 50 }, 1);
    const rejected = assertRejects(() => pending!, PluginContractError);
    await entered.promise;
    const manifest = JSON.parse(
      await Deno.readTextFile(`${b.dir}/manifest.json`),
    );
    manifest.settings = [descriptor(10)];
    // An external source edit does not acquire the host commit gate.
    await Deno.writeTextFile(
      `${b.dir}/manifest.json`,
      JSON.stringify(manifest),
    );
    release.resolve();
    const error = await rejected;
    assertEquals(error.code, "plugin_settings_schema_conflict");
    assertEquals(await Deno.readTextFile(b.file), b.before);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => undefined);
    await b.close();
  }
});
