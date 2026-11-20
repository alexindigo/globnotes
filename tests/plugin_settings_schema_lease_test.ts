// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { GlobalConfig } from "./helpers/config.ts";
import {
  type JsonValues,
  PluginContractError,
} from "../server/plugins/contracts.ts";
import {
  PluginDataStore,
  type SettingsCommitChange,
} from "../server/plugins/data.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { state } from "../server/state.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";
import type { FixtureScope } from "./helpers/fixture_scope.ts";
import { testEnvironment } from "./helpers/environment.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { heldOperation } from "./helpers/owned_operation.ts";

const settingsPut = (await import(
  "../server/api/endpoints/_/api/plugin-host/%23id/settings/%23page/put.ts"
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
const schemaConflictMessage =
  "plugin settings definition changed; review the current schema before retrying";

function withBundle<T>(body: (bundle: SchemaBundle) => T | Promise<T>) {
  return withPluginFixture(async (fixture, scope) => {
    const bundle = await fixture.admit(() => prepareBundle(fixture, scope));
    return (await fixture.admit(() => body(bundle.value))).value;
  });
}
type SchemaBundle = Awaited<ReturnType<typeof prepareBundle>>;
async function prepareBundle(
  fixture: Parameters<Parameters<typeof withPluginFixture>[0]>[0],
  scope: FixtureScope,
) {
  const admit = async <V>(effect: () => V | PromiseLike<V>) =>
    (await fixture.admit(effect)).value;
  const previous = {
    config: state.config,
    auth: state.auth,
    lifecycle: state.lifecycle,
    plugins: state.plugins,
    pluginData: state.pluginData,
  };
  const config = new GlobalConfig(
      testEnvironment({
        GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
        fixtureStatePath: fixture.statePath,
        fixtureAuth: { auth_type: "none" },
      }),
    ),
    lifecycle = new PluginLifecycle(config);
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
  const manager = (await scope.acquire(() =>
    createPluginManager(
      fixture.vault,
      () => Promise.resolve(null),
      0,
      fixture.statePath,
      {
        internalRoot: `${fixture.root}/empty-internal`,
        persistence: { commit },
      },
    ), (manager) => manager.stop())).value;
  scope.onCancel(() => manager.runtime?.suspend());
  scope.defer(() => manager.runtime?.close());
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
  scope.defer(() => Object.assign(state, previous));
  Object.assign(state, {
    config,
    auth: null,
    lifecycle,
    plugins: manager,
    pluginData: data,
  });
  const untilReady = () => pluginSettled(runtime, "coherent", "ready");
  await runtime.reconcile();
  await untilReady();
  const file = `${fixture.statePath}/plugin-data/coherent/settings.json`,
    before = await Deno.readTextFile(file);
  return {
    admit,
    signal: scope.signal,
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
    replace: (pages: unknown[]) =>
      admit(async () => {
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
      }),
  };
}

for (const variant of ["constraint", "field", "page"] as const) {
  Deno.test(`review repairs: R18 schema source coherence held HTTP ${variant} replacement rejects before persistence`, async () => {
    await withBundle(async (b) => {
      const raw = new Request(
        "http://fixture/_/api/plugin-host/coherent/settings/preferences",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { limit: 50 }, revision: 1 }),
        },
      );
      await heldOperation({
        signal: b.signal,
        label: `schema HTTP ${variant}`,
        owner: () => raw,
        progress: { kind: "controlled", clock: "external" },
      }, (hold) =>
        settingsPut(
          {
            _raw: raw,
            params: { id: "coherent", page: "preferences" },
            body: {
              json: async () => {
                await hold();
                return raw.json();
              },
            },
          } as unknown as PathfinderRequest,
        ), async (operation) => {
        await operation.reached();
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
        const response = await operation.result();
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
      });
    });
  });
}

Deno.test("review repairs: R18 schema source coherence direct owned write rechecks definition after commit-gate wait", async () => {
  await withBundle(async (b) => {
    await heldOperation({
      signal: b.signal,
      label: "schema write commit gate",
      owner: () => b.lifecycle,
      progress: { kind: "controlled", clock: "external" },
    }, (hold) => {
      const adapters = {
        commit: async <T>(effect: () => Promise<T>) => {
          await hold();
          return b.lifecycle.gate.run(effect);
        },
        settingsSchema: (_id: string) => readManifest(b.dir).settings,
      };
      const owner = new PluginDataStore(b.fixture.statePath, adapters)
        .forPlugin(
          "coherent",
        );
      return owner.savePage(b.oldPage, { limit: 50 }, 1);
    }, async (operation) => {
      await operation.reached();
      await b.replace([descriptor(10)]);
      const error = await assertRejects(
        () => operation.result(),
        PluginContractError,
        schemaConflictMessage,
      );
      assertEquals(error.code, "plugin_settings_schema_conflict");
      assertEquals(await Deno.readTextFile(b.file), b.before);
    });
  });
});

Deno.test("review repairs: R18 schema source coherence owned read cannot return a replaced definition after storage await", async () => {
  await withBundle(async (b) => {
    const originalRead = Deno.readTextFile;
    let held = false;
    try {
      await heldOperation({
        signal: b.signal,
        label: "schema read storage boundary",
        owner: () => b.data,
        progress: { kind: "controlled", clock: "external" },
      }, (hold) => {
        Deno.readTextFile = async (
          ...args: Parameters<typeof Deno.readTextFile>
        ) => {
          const result = await originalRead(...args);
          if (String(args[0]) === b.file && !held) {
            held = true;
            await hold();
          }
          return result;
        };
        return b.data.forPlugin("coherent").page(b.oldPage);
      }, async (operation) => {
        await operation.reached();
        await b.replace([{
          ...descriptor(10),
          fields: [{
            key: "replacement",
            label: "Replacement",
            type: "text",
            default: "current default",
          }],
        }]);
        const error = await assertRejects(
          () => operation.result(),
          PluginContractError,
          schemaConflictMessage,
        );
        assertEquals(error.code, "plugin_settings_schema_conflict");
        assertEquals(await originalRead(b.file), b.before);
      });
    } finally {
      Deno.readTextFile = originalRead;
    }
  });
});

Deno.test("review repairs: R18 schema source coherence prepared transition checks after its last asynchronous validation", async () => {
  await withBundle(async (b) => {
    await heldOperation({
      signal: b.signal,
      label: "schema prepared transition validation",
      owner: () => b.manager,
      progress: { kind: "controlled", clock: "external" },
    }, (hold) => {
      // No optional schema resolver here: the prepared owning-source contract
      // independently protects writes through the shared persistence boundary.
      const adapters = {
        commit: <T>(effect: () => Promise<T>) => b.lifecycle.gate.run(effect),
        prepareSettingsCommit: async (change: SettingsCommitChange) => {
          const prepared = await b.manager.network.prepareSettingsCommit(
            change,
          );
          return {
            ...prepared,
            validateLedgerSnapshot: async () => {
              await prepared.validateLedgerSnapshot();
              await hold();
            },
          };
        },
      };
      return new PluginDataStore(b.fixture.statePath, adapters).forPlugin(
        "coherent",
      ).savePage(b.oldPage, { limit: 50 }, 1);
    }, async (operation) => {
      await operation.reached();
      const manifest = JSON.parse(
        await Deno.readTextFile(`${b.dir}/manifest.json`),
      );
      manifest.settings = [descriptor(10)];
      // An external source edit does not acquire the host commit gate.
      await Deno.writeTextFile(
        `${b.dir}/manifest.json`,
        JSON.stringify(manifest),
      );
      const error = await assertRejects(
        () => operation.result(),
        PluginContractError,
        schemaConflictMessage,
      );
      assertEquals(error.code, "plugin_settings_schema_conflict");
      assertEquals(await Deno.readTextFile(b.file), b.before);
    });
  });
});

for (const phase of ["before", "after", "missing"] as const) {
  Deno.test(`schema lease held operation: real HTTP body ${phase} entry cannot orphan the request`, async () => {
    await withBundle(async (b) => {
      const cause = new Error(`body rejected ${phase} entry`);
      const raw = new Request(
        "http://fixture/_/api/plugin-host/coherent/settings/preferences",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { limit: 8 }, revision: 1 }),
        },
      );
      const error = await assertRejects(
        () =>
          heldOperation({
            signal: b.signal,
            label: `schema HTTP body ${phase}`,
            owner: () => raw,
            progress: { kind: "controlled", clock: "external" },
          }, (hold) =>
            settingsPut({
              _raw: raw,
              params: { id: "coherent", page: "preferences" },
              body: {
                json: async () => {
                  if (phase === "before") throw cause;
                  if (phase === "after") {
                    await hold();
                    throw cause;
                  }
                  return await raw.json();
                },
              },
            } as unknown as PathfinderRequest), async (operation) => {
            await operation.reached();
            return await operation.result();
          }),
        Error,
        phase === "missing"
          ? "schema HTTP body missing: product work settled without the expected milestone"
          : cause.message,
      );
      if (phase === "missing") {
        assertEquals(
          error.message,
          "schema HTTP body missing: product work settled without the expected milestone",
        );
        // A successful original request is not undone by failing its fixture
        // milestone. The real write remains visible and has been drained.
        const saved = JSON.parse(await Deno.readTextFile(b.file));
        assertEquals(saved.revision, 2);
        assertEquals(saved.values.preferences, { limit: 8 });
      } else {
        assertEquals(error, cause);
        assertEquals(await Deno.readTextFile(b.file), b.before);
      }
    });
  });
}
