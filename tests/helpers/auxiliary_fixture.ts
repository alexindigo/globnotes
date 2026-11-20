import { testMetadata, testServices } from "./environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { AuxiliaryFilesystem } from "../../server/plugins/auxiliary_fs.ts";
import { PluginDataStore } from "../../server/plugins/data.ts";
import { createPluginManager } from "./plugin_manager.ts";
import {
  type PluginManifest,
  readManifest,
} from "../../server/plugins/manifest.ts";
import { servicePluginRpc } from "../../server/plugins/rpc.ts";
import { PluginSettingsEnvironment } from "../../server/plugins/settings_environment.ts";
import { validateSettingsPages } from "../../server/plugins/settings.ts";
import {
  retainedPluginFixture,
  scopedPluginFixture,
} from "./plugin_fixture_engine.ts";
import { createFixtureScope } from "./fixture_scope_engine.ts";
import type { ObservedClock } from "../../server/observed_time.ts";
import { HubGate } from "../../server/hub/gate.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import { testEnvironment } from "./environment.ts";
import { pluginSettled } from "./plugin_ready.ts";

export const auxiliaryPage = {
  id: "preferences",
  label: "Preferences",
  renderer: { kind: "declarative-v1", version: 1 },
  fields: [{ key: "base", label: "Base", type: "folder", default: "" }, {
    key: "count",
    label: "Count",
    type: "slider",
    default: 2,
    min: 1,
    max: 10,
    step: 1,
  }],
};
export async function auxiliaryFixture(options: {
  read?: unknown[];
  write?: unknown[];
  environment?: string;
  pinSource?: "toml" | "environment";
  stateInVault?: boolean;
  prepare?(): Promise<void>;
  commit?<T>(effect: () => T | Promise<T>): Promise<T>;
  observe?(method: string, args: unknown[]): void;
  /** The filesystem deadline clock (default: the process clock). */
  clock?: ObservedClock;
  /** Attach a vault hub, so facade effects go through its gate records. */
  hub?: boolean;
} = {}) {
  const owner = createFixtureScope();
  return await owner.prepare(async (scope) => {
    const fixture = await scopedPluginFixture(scope, {
        ...options,
        retain: true,
      }),
      id = "auxiliary";
    const dir = await fixture.install(id, {
      runtime: { server: "service.js" },
      hooks: ["on-save", "pre-save"],
      settings: [auxiliaryPage],
      capabilities: {
        network: false,
        imports: false,
        read: ["vault"],
        write: [],
        filesystem: {
          read: options.read ?? ["vault"],
          write: options.write ?? ["vault"],
        },
      },
    }, {
      "service.js": `let last;
    export function activate(ctx){
      ctx.commands.register({id:'run',label:'Run consumer',target:'server'},async(request)=>{
        if(request.method==='settings')return ctx.settings.read();
        if(request.method==='last')return last;
        if(request.method==='capture'){
          const buffer=request.args[0]?new SharedArrayBuffer(8192):new ArrayBuffer(8192),bytes=new Uint8Array(buffer,0,1);bytes[0]=7;
          const pending=ctx.fs.writeFile('capture-'+request.args[0],bytes,{expect:{kind:'absent'}});bytes[0]=99;await pending;
          return {value:[...await ctx.fs.readFile('capture-'+request.args[0])]};
        }
        if(request.method==='capacity'){
          const calls=[];
          for(let index=0;index<65;index++){try{calls.push(ctx.fs.stat('capacity-'+index))}catch(error){calls.push(Promise.reject(error))}}
          const results=await Promise.allSettled(calls);
          return {value:{completed:results.filter(result=>result.status==='fulfilled'&&result.value===null).length,busy:results.filter(result=>result.status==='rejected'&&result.reason.code==='fs_busy'&&result.reason.effect==='none').length}};
        }
        try{return {value:await ctx.fs[request.method](...request.args)}}catch(error){return {error:{code:error.code,effect:error.effect}}}
      });
      ctx.hooks.on('on-save',async()=>{const setting=await ctx.settings.read();await ctx.fs.writeFile('post.bin',new Uint8Array([7]),{sourceKey:setting.sourceKey,expect:{kind:'absent'}});last='post-completed'});
      ctx.hooks.on('pre-save',async()=>{try{ctx.fs.mkdir('pre')}catch(error){last={code:error.code,root:await ctx.fs.realPath('.')}}});
    }`,
    });
    const commit = options.commit ??
      (async <T>(effect: () => T | Promise<T>): Promise<T> => await effect());
    const manager = (await scope.acquire(() =>
      createPluginManager(
        fixture.vault,
        undefined,
        0,
        fixture.statePath,
        {
          internalRoot: `${fixture.root}/no-internal`,
          settingsEnvironment: new PluginSettingsEnvironment(
            options.environment,
            options.pinSource,
          ),
          persistence: { commit },
        },
      ), (manager) => manager.stop())).value;
    scope.onCancel(() => manager.runtime?.suspend());
    const data = new PluginDataStore(fixture.statePath, {
      commit,
      settingsSchema: (id) => manager.network.settingsSchema(id),
      settingsContext: (id) => manager.network.settingsContext(id),
      settingsEnvironment: manager.settingsEnvironment,
      prepareSettingsCommit: (change) =>
        manager.network.prepareSettingsCommit(change),
      settingsChanged: (id, page, revision) =>
        runtime.settingsChanged(id, page, revision),
    });
    const hub = options.hub
      ? (await scope.acquire(() =>
        new VaultHub(
          fixture.vault,
          testMetadata(fixture.statePath),
          testServices(testEnvironment({})).hub,
        ), (hub) => hub.stop())).value
      : undefined;
    scope.defer(() => manager.runtime?.close());
    const filesystem = new AuxiliaryFilesystem({
      gate: hub ? new HubGate({ hub }) : undefined,
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      operational: () => operational,
      writable: () => writable,
      settings: (manifest) =>
        data.forPlugin(manifest.id).settingsLease(manifest.settings),
      commit,
      prepare: options.prepare,
      clock: options.clock,
    });
    let writable = true, operational = true;
    const rpc = servicePluginRpc({
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      actions: () => null,
      filesystem,
    });
    const runtime = manager.configureRuntime({
      operational: () => operational,
      writable: () => writable,
      commit,
      rpc: (manifest, method, args, authority) => {
        options.observe?.(method, args);
        return rpc(manifest, method, args, authority);
      },
    });
    await runtime.reconcile();
    await pluginSettled(runtime, id, "ready");
    return {
      ...await retainedPluginFixture(fixture),
      manager,
      runtime,
      data,
      filesystem,
      hub,
      dir,
      id,
      manifest: scope.bind(() => readManifest(dir)),
      page: validateSettingsPages([auxiliaryPage])[0],
      settings: async () =>
        (await fixture.admit(() =>
          runtime.invokeCommand(id, "run", { method: "settings" })
        )).value as {
          revision: number;
          sourceKey: string;
          values: Record<string, Record<string, unknown>>;
        },
      last: async () =>
        (await fixture.admit(() =>
          runtime.invokeCommand(id, "run", { method: "last" })
        )).value,
      call: async (method: string, ...args: unknown[]) =>
        (await fixture.admit(() =>
          runtime.invokeCommand(id, "run", { method, args })
        )).value as {
          value?: unknown;
          error?: { code: string; effect: string };
        },
      writable: scope.bind((value: boolean) => {
        writable = value;
      }),
      operational: scope.bind((value: boolean) => {
        operational = value;
      }),
      close: () => owner.close(),
    };
  });
}
export async function assertFsCode(
  call: Promise<{ error?: { code: string; effect: string } }>,
  code: string,
  effect = "none",
) {
  assertEquals((await call).error, { code, effect });
}
export type AuxiliaryManifest = PluginManifest;
