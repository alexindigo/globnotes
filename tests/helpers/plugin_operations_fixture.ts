// SPDX-License-Identifier: LGPL-3.0-only
import { testEnvironment } from "./environment.ts";
import { AuthType, GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { AuxiliaryFilesystem } from "../../server/plugins/auxiliary_fs.ts";
import { PluginDataStore } from "../../server/plugins/data.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import {
  cleanupFailedPluginSetup,
  createPluginManager,
} from "./plugin_manager.ts";
import { servicePluginRpc } from "../../server/plugins/rpc.ts";
import { PluginSettingsEnvironment } from "../../server/plugins/settings_environment.ts";
import { fixtureApiOrigin, pluginFixture } from "./plugin_fixture.ts";
import { initState, state } from "../../server/state.ts";
import type { OperationFact } from "../../server/plugins/contracts.ts";
import { restoreState } from "./state.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import { PluginActions } from "../../server/plugins/actions.ts";
import { HubGate } from "../../server/hub/gate.ts";
import type { PluginLimits } from "../../server/plugins/contracts.ts";

export type RpcFault = (
  method: string,
  args: unknown[],
  boundary: "before" | "after",
) => void | Promise<void>;
/** One installed plugin with the real runtime, plugin filesystem facade,
 * note operations, vault hub and write gate (with versioning) wired as
 * server/main.ts does. */
export async function pluginOperationsFixture(options: {
  id: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  environment?: string;
  fixture?: Awaited<ReturnType<typeof pluginFixture>>;
  fault?: RpcFault;
  limits?: Partial<PluginLimits>;
}) {
  const fixture = options.fixture ?? await pluginFixture();
  const id = options.id;
  const dir = await fixture.install(id, options.manifest, options.files);
  const env = testEnvironment({
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: "none",
  });
  const config = new GlobalConfig(env);
  config.authType = AuthType.NONE;
  const previousState = { ...state };
  const lifecycle = new PluginLifecycle(config),
    notes = new FileSystemNotes(fixture.vault, {}, env),
    fileServing = new FileServing(fixture.vault);
  const manager = createPluginManager(
    fixture.vault,
    undefined,
    0,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/no-internal`,
      settingsEnvironment: new PluginSettingsEnvironment(options.environment),
      persistence: { commit: (effect) => lifecycle.gate.run(effect) },
      env,
    },
  );
  let runtimeToClose: ReturnType<typeof manager.configureRuntime> | undefined;
  try {
    const hub = new VaultHub(fixture.vault, fixture.statePath, env);
    hub.scanNow();
    const gate = new HubGate({ hub, versioning: () => runtime });
    initState(config, null, notes, null, fileServing, manager, hub);
    const data = new PluginDataStore(fixture.statePath, {
      commit: (effect) => lifecycle.gate.run(effect),
      settingsSchema: (id) => manager.network.settingsSchema(id),
      settingsContext: (id) => manager.network.settingsContext(id),
      settingsEnvironment: manager.settingsEnvironment,
      prepareSettingsCommit: (change) =>
        manager.network.prepareSettingsCommit(change),
      settingsChanged: (id, page, revision) =>
        runtime.settingsChanged(id, page, revision),
    });
    const filesystem = new AuxiliaryFilesystem({
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      operational: () => lifecycle.operational(),
      writable: () => lifecycle.writable(),
      settings: (manifest) =>
        data.forPlugin(manifest.id).settingsLease(manifest.settings),
      commit: (effect) => lifecycle.gate.run(effect),
      gate,
    });
    const rawRpc = servicePluginRpc({
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      actions: () => actions,
      filesystem,
    });
    const ready = Promise.withResolvers<void>();
    // Observe rejection while reconciliation is still in progress; it is awaited
    // below and remains the setup failure, rather than an unhandled rejection.
    ready.promise.catch(() => undefined);
    const runtime = runtimeToClose = manager.configureRuntime({
      operational: () => lifecycle.operational(),
      writable: () => lifecycle.writable(),
      commit: (effect) => lifecycle.gate.run(effect),
      sanitizeFact: (manifest, fact) =>
        lifecycle.applyReadGrants(manifest, fact as OperationFact),
      changed: () => {
        if (runtime.status(id)?.status === "ready") ready.resolve();
        if (runtime.status(id)?.status === "failed") {
          ready.reject(new Error(JSON.stringify(runtime.status(id))));
        }
      },
      rpc: async (manifest, method, args, authority) => {
        await options.fault?.(method, args, "before");
        const result = await rawRpc(manifest, method, args, authority);
        await options.fault?.(method, args, "after");
        return result;
      },
    }, options.limits);
    const operations = new NoteOperations({
      notes,
      files: fileServing,
      indexer: null,
      hub,
      gate,
      runtime: () => runtime,
      lifecycle,
    });
    const actions: PluginActions = new PluginActions({
      operations,
      runtime: () => runtime,
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
    });
    lifecycle.onFact((fact) =>
      runtime.post(`on-${fact.action}` as never, fact, {
        operationId: fact.operationId,
        action: fact.action,
      })
    );
    const timer = setTimeout(
      () => ready.reject(new Error(`${id} fixture readiness failed`)),
      10_000,
    );
    try {
      await runtime.reconcile();
      await ready.promise;
    } finally {
      clearTimeout(timer);
    }
    return {
      fixture,
      dir,
      id,
      config,
      lifecycle,
      manager,
      runtime,
      data,
      operations,
      actions,
      hub,
      gate,
      filesystem,
      command: (command: string, payload: unknown = {}) =>
        runtime.invokeCommand(id, command, payload),
      async save(
        path: string,
        content: string,
        operationId?: Parameters<NoteOperations["updateNote"]>[5],
      ) {
        const result = await operations.updateNote(
          path,
          { newContent: content },
          "none",
          fixtureApiOrigin(lifecycle),
          undefined,
          operationId,
        );
        return result;
      },
      async create(path: string, content: string) {
        return await operations.createNote(
          { path, content },
          fixtureApiOrigin(lifecycle),
        );
      },
      async remove(path: string) {
        return await operations.deleteNote(path, fixtureApiOrigin(lifecycle));
      },
      async close() {
        manager.stop();
        await runtime.close();
        restoreState(previousState);
        hub.stop();
        console.log(JSON.stringify({ retainedPluginFixture: fixture.root }));
      },
    };
  } catch (error) {
    await cleanupFailedPluginSetup(manager, runtimeToClose);
    restoreState(previousState);
    throw error;
  }
}
