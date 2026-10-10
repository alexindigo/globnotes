// SPDX-License-Identifier: LGPL-3.0-only
import { AuthType, GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { AuxiliaryFilesystem } from "../../server/plugins/auxiliary_fs.ts";
import { PluginDataStore } from "../../server/plugins/data.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import { PluginManager } from "../../server/plugins/manager.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import { servicePluginRpc } from "../../server/plugins/rpc.ts";
import { PluginSettingsEnvironment } from "../../server/plugins/settings_environment.ts";
import { fixtureApiOrigin, pluginFixture } from "./plugin_fixture.ts";
import { initState, state } from "../../server/state.ts";
import type { OperationFact } from "../../server/plugins/contracts.ts";

export interface BackupStatus {
  completed: number;
  skipped: number;
  failed: number;
  pendingRecovery: boolean;
  ringCommitted: boolean;
  lastError: { code: string; effect?: string } | null;
  configuration: { retention: number; basePath: string } | null;
}
export type BackupFault = (
  method: string,
  args: unknown[],
  boundary: "before" | "after",
) => void | Promise<void>;
export async function backupFixture(options: {
  environment?: string;
  fixture?: Awaited<ReturnType<typeof pluginFixture>>;
  fault?: BackupFault;
  variant?: (name: string, text: string) => string;
} = {}) {
  const fixture = options.fixture ?? await pluginFixture();
  const id = "globnotes-backup",
    source = new URL("../../plugins/globnotes-backup/", import.meta.url);
  const files: Record<string, string> = {};
  for (
    const name of [
      "service.js",
      "backup.js",
      "journal.js",
      "state.js",
      "endpoints/status/get.js",
    ]
  ) {
    const text = await Deno.readTextFile(new URL(name, source));
    files[name] = options.variant?.(name, text) ?? text;
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", source)),
  );
  const dir = await fixture.install(id, manifest, files);
  const env = ["GLOBNOTES_PATH", "GLOBNOTES_INDEX_PATH", "GLOBNOTES_AUTH_TYPE"],
    previousEnv = env.map((key) => Deno.env.get(key));
  Deno.env.set(env[0], fixture.vault);
  Deno.env.set(env[1], fixture.statePath);
  Deno.env.set(env[2], "none");
  const config = new GlobalConfig();
  env.forEach((key, index) =>
    previousEnv[index] === undefined
      ? Deno.env.delete(key)
      : Deno.env.set(key, previousEnv[index]!)
  );
  config.authType = AuthType.NONE;
  const previousState = { ...state };
  const lifecycle = new PluginLifecycle(config),
    notes = new FileSystemNotes(fixture.vault),
    fileServing = new FileServing(fixture.vault);
  const manager = new PluginManager(
    fixture.vault,
    undefined,
    0,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/no-internal`,
      settingsEnvironment: new PluginSettingsEnvironment(options.environment),
      persistence: { commit: (effect) => lifecycle.gate.run(effect) },
    },
  );
  initState(config, null, notes, null, fileServing, manager);
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
  });
  const rawRpc = servicePluginRpc({
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    actions: () => null,
    filesystem,
  });
  const ready = Promise.withResolvers<void>();
  const runtime = manager.configureRuntime({
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
  });
  const operations = new NoteOperations({
    notes,
    files: fileServing,
    indexer: null,
    runtime: () => runtime,
    lifecycle,
  });
  lifecycle.onFact((fact) =>
    runtime.post(`on-${fact.action}` as never, fact, {
      operationId: fact.operationId,
      action: fact.action,
    })
  );
  const timer = setTimeout(
    () => ready.reject(new Error("Backup fixture readiness failed")),
    10_000,
  );
  await runtime.reconcile();
  try {
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
    settings: () => data.forPlugin(id).page(readManifest(dir).settings[0]),
    async configure(retention: number, basePath = "") {
      const current = await data.forPlugin(id).page(
        readManifest(dir).settings[0],
      );
      return await data.forPlugin(id).savePage(
        readManifest(dir).settings[0],
        { retention, basePath },
        current.revision,
        current.sourceKey,
      );
    },
    status: () =>
      runtime.invokeCommand(id, "status", {}) as Promise<BackupStatus>,
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
      Object.assign(state, previousState);
      console.log(JSON.stringify({ retainedBackupFixture: fixture.root }));
    },
  };
}
