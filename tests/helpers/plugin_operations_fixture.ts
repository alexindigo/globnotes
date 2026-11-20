import { testMetadata, testServices } from "./environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { testEnvironment } from "./environment.ts";
import { AuthType, GlobalConfig } from "./config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { AuxiliaryFilesystem } from "../../server/plugins/auxiliary_fs.ts";
import { PluginDataStore } from "../../server/plugins/data.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import { createPluginManager } from "./plugin_manager.ts";
import { servicePluginRpc } from "../../server/plugins/rpc.ts";
import { PluginSettingsEnvironment } from "../../server/plugins/settings_environment.ts";
import {
  bindPluginFixture,
  compatibilityPluginFixture,
  fixtureApiOrigin,
  retainedPluginFixture,
  type ScopedPluginFixture,
  scopedPluginFixture,
} from "./plugin_fixture_engine.ts";
import {
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
} from "./fixture_scope_engine.ts";
import { initState, state } from "../../server/state.ts";
import type { OperationFact } from "../../server/plugins/contracts.ts";
import { restoreState } from "./state.ts";
import { currentBaseFrom } from "./storage.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import { PluginActions } from "../../server/plugins/actions.ts";
import { HubGate } from "../../server/hub/gate.ts";
import type { PluginLimits } from "../../server/plugins/contracts.ts";
import { pluginSettled } from "./plugin_ready.ts";

export type RpcFault = (
  method: string,
  args: unknown[],
  boundary: "before" | "after",
) => void | Promise<void>;

/** Reserve fixture custody before invoking the raw manager constructor. */
export function acquirePluginManager(
  scope: FixtureScope,
  ...args: Parameters<typeof createPluginManager>
) {
  return scope.acquire(
    () => createPluginManager(...args),
    (manager) => manager.stop(),
  );
}
/** One installed plugin with the real runtime, plugin filesystem facade,
 * note operations, vault hub and write gate (with versioning) wired as
 * server/main.ts does. */
export interface PluginOperationsOptions {
  id: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  environment?: string;
  fixture?: ScopedPluginFixture & { dispose?: () => Promise<void> };
  fault?: RpcFault;
  limits?: Partial<PluginLimits>;
}

/** Compatibility entry retains evidence just as its existing close contract did.
 * New scenarios use the callback entry below, which removes owned roots by default.
 * A supplied fixture is borrowed; its enclosing owner retains root custody. */
export async function pluginOperationsFixture(
  options: PluginOperationsOptions,
) {
  const owner = createFixtureScope();
  return await owner.prepare(async (scope) => {
    const result = await scopedPluginOperationsFixture(scope, options, true);
    return {
      ...result,
      fixture: options.fixture
        ? compatibilityPluginFixture(
          result.fixture,
          options.fixture.dispose ?? (() => Promise.resolve()),
        )
        : await retainedPluginFixture(result.fixture),
      close: () => owner.close(),
    };
  });
}

export function withPluginOperationsFixture<T>(
  options: PluginOperationsOptions & { retain?: boolean },
  body: (
    fixture: Awaited<ReturnType<typeof scopedPluginOperationsFixture>>,
  ) => T | PromiseLike<T>,
): Promise<T> {
  return fixtureScope(async (scope) =>
    body(
      await scopedPluginOperationsFixture(
        scope,
        options,
        options.retain ?? false,
      ),
    )
  );
}

async function scopedPluginOperationsFixture(
  scope: FixtureScope,
  options: PluginOperationsOptions,
  retain: boolean,
) {
  const fixture = options.fixture
    ? bindPluginFixture(scope, options.fixture)
    : await scopedPluginFixture(scope, { retain });
  const id = options.id;
  const dir = await fixture.install(id, options.manifest, options.files);
  const env = testEnvironment({
    GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
    fixtureStatePath: fixture.statePath,
    fixtureAuth: { auth_type: "none" },
  });
  const config = new GlobalConfig(env);
  config.authType = AuthType.NONE;
  const previousState = { ...state };
  const lifecycle = new PluginLifecycle(config),
    notes = new FileSystemNotes(fixture.vault, {}, testServices(env).notes),
    fileServing = new FileServing(fixture.vault);
  const hub = (await scope.acquire(
    () =>
      new VaultHub(
        fixture.vault,
        testMetadata(fixture.statePath),
        testServices(env).hub,
      ),
    (hub) => hub.stop(),
  )).value;
  scope.defer(() => restoreState(previousState));
  const manager = (await scope.acquire(() =>
    createPluginManager(
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
    ), (manager) => manager.stop())).value;
  // Register the manager's actual runtime slot before configureRuntime: an
  // injected configure failure can happen after allocation but before return.
  scope.defer(() => manager.runtime?.close());
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
  const runtime = manager.configureRuntime({
    operational: () => lifecycle.operational(),
    writable: () => lifecycle.writable(),
    commit: (effect) => lifecycle.gate.run(effect),
    sanitizeFact: (manifest, fact) =>
      lifecycle.applyReadGrants(manifest, fact as OperationFact),
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
  await runtime.reconcile();
  await pluginSettled(runtime, id, "ready");
  return {
    scope,
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
    command: scope.bind((command: string, payload: unknown = {}) =>
      runtime.invokeCommand(id, command, payload)
    ),
    save: scope.bind(async (
      path: string,
      content: string,
      operationId?: Parameters<NoteOperations["updateNote"]>[5],
    ) => {
      // Like a client: based on the version it reads now.
      const result = await operations.updateNote(
        path,
        { newContent: content, base: currentBaseFrom(notes, path) },
        "none",
        fixtureApiOrigin(lifecycle),
        undefined,
        operationId,
      );
      return result;
    }),
    create: scope.bind(async (path: string, content: string) => {
      return await operations.createNote(
        { path, content },
        fixtureApiOrigin(lifecycle),
      );
    }),
    remove: scope.bind(async (path: string) => {
      return await operations.deleteNote(
        path,
        fixtureApiOrigin(lifecycle),
        undefined,
        undefined,
        undefined,
        currentBaseFrom(notes, path),
      );
    }),
  };
}
