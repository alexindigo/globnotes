import { testMetadata, testServices } from "./environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { publicScenario } from "./fixture_scenarios.ts";

import * as path from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { GlobalConfig } from "./config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import {
  subscribeExternalFacts,
  subscribeIndex,
} from "../../server/hub/subscribers.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { PluginActions } from "../../server/plugins/actions.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import type { PluginManager } from "../../server/plugins/manager.ts";
import { createPluginManager } from "./plugin_manager.ts";
import type { PluginRuntime } from "../../server/plugins/runtime.ts";
import { servicePluginRpc } from "../../server/plugins/rpc.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { state } from "../../server/state.ts";
import { fixtureApiOrigin, pluginFixture } from "./plugin_fixture.ts";
import { testEnvironment } from "./environment.ts";
import { pluginSettled } from "./plugin_ready.ts";
import { installFixtureState } from "./state.ts";
import { createFixtureScope, fixtureScope } from "./fixture_scope_engine.ts";
import {
  compatibilityPluginFixture,
  retainedPluginFixture,
  scopedPluginFixture,
} from "./plugin_fixture_engine.ts";

export const RECORDER_SERVICE = `export function activate(ctx) {
  globalThis.__facts = [];
  ctx.register(() => { globalThis.__facts = []; });
  const facts = () => globalThis.__facts;
  const record = (kind) => (fact) => { facts().push({ kind, fact }); };
  ctx.hooks.on('on-create', record('on-create'));
  ctx.hooks.on('on-save', record('on-save'));
  ctx.hooks.on('on-rename', record('on-rename'));
  ctx.hooks.on('on-delete', record('on-delete'));
  ctx.hooks.on('on-upload', record('on-upload'));
  ctx.hooks.on('on-rewrite-refs', record('on-rewrite-refs'));
  ctx.hooks.on('on-file-write', record('on-file-write'));
  ctx.hooks.on('on-operation-error', record('on-operation-error'));
  ctx.hooks.on('on-sync', record('on-sync'));
  const protect = (fact) => {
    const content = fact?.proposed?.content ?? fact?.before?.content ?? '';
    if (content.includes('#BLOCK#')) return { cancel: true, reason: 'fixture protection' };
  };
  ctx.hooks.on('pre-create', protect);
  ctx.hooks.on('pre-save', protect);
  ctx.hooks.on('pre-delete', protect);
  ctx.hooks.on('pre-rename', protect);
  ctx.hooks.on('pre-upload', () => {});
  ctx.hooks.on('pre-rewrite-refs', () => {});
  ctx.hooks.on('pre-file-write', protect);
  ctx.commands.register({ id: 'facts', label: 'Facts', target: 'server' }, () => facts());
  ctx.commands.register({ id: 'clear', label: 'Clear', target: 'server' }, () => { globalThis.__facts = []; });
  ctx.commands.register({ id: 'request', label: 'Request', target: 'server' }, (args) =>
    ctx.actions.request(args.action, args.args));
  ctx.commands.register({ id: 'receipt', label: 'Receipt', target: 'server' }, (id) =>
    ctx.actions.result(id));
}`;

export const HOOKS = [
  "on-create",
  "on-save",
  "on-rename",
  "on-delete",
  "on-upload",
  "on-rewrite-refs",
  "on-file-write",
  "on-operation-error",
  "on-sync",
  "pre-create",
  "pre-save",
  "pre-delete",
  "pre-rename",
  "pre-upload",
  "pre-rewrite-refs",
  "pre-file-write",
];

export interface RecordedFact {
  operationId: string;
  origin?: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  initial?: boolean;
  changedPaths?: string[];
  before?: {
    path: string;
    content?: string;
    contentAvailable: boolean;
    lastModified?: number;
  } | null;
  proposed?: { path: string; content?: string; contentAvailable: boolean };
  after?: {
    path: string;
    content?: string;
    contentAvailable: boolean;
    lastModified?: number;
  } | null;
  metadata?: Record<string, unknown>;
}

interface Bundle {
  fixture: Awaited<ReturnType<typeof pluginFixture>>;
  lifecycle: PluginLifecycle;
  operations: NoteOperations;
  actions: PluginActions;
  indexer: Fts5Indexer;
  hub: VaultHub;
  runtime: PluginRuntime;
  manager: PluginManager;
  facts(): Promise<{ kind: string; fact: RecordedFact }[]>;
  clearFacts(): Promise<void>;
  dispose(): Promise<void>;
}

export async function bundle(opts: {
  recorder?: boolean;
  probes?: ConstructorParameters<typeof FileSystemNotes>[1];
  limits?: Parameters<PluginManager["configureRuntime"]>[1];
  workers?: number;
  retain?: boolean;
  scanCacheTtl?: string;
  beforeRead?(method: string, args: unknown[]): Promise<void> | void;
} = {}): Promise<Bundle> {
  const owner = createFixtureScope();
  return await owner.prepare(async (scope) => {
    const fixture = await scopedPluginFixture(scope, {
      retain: opts.retain !== false,
    });
    if (opts.recorder !== false) {
      await fixture.install("recorder", {
        runtime: { server: "service.js" },
        hooks: HOOKS,
        capabilities: { read: ["vault"], write: ["vault"] },
      }, { "service.js": RECORDER_SERVICE });
    }
    const env = testEnvironment({
      GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
      fixtureStatePath: fixture.statePath,
      fixtureScenario: publicScenario(),
      // External writes bypass the storage layer; scans must see them
      // immediately rather than through the 15s scan-cache TTL.
      GLOBNOTES__INDEX_SCANCACHETTL: opts.scanCacheTtl ?? "0",
    });
    const config = new GlobalConfig(env);
    const notes = new FileSystemNotes(
      fixture.vault,
      opts.probes ?? {},
      testServices(env).notes,
    );
    const indexer = new Fts5Indexer(
      testMetadata(fixture.statePath),
      testServices(env).index,
      {
        openDatabase(filename) {
          // The indexer has no public close port. Its existing adapter lets the
          // fixture reserve each native handle before construction can fail.
          let db: DatabaseSync | undefined = undefined;
          scope.defer(() => {
            if (db?.isOpen) db.close();
          });
          db = new DatabaseSync(filename);
          return db;
        },
      },
    );
    const files = new FileServing(fixture.vault);
    const hub = (await scope.acquire(() =>
      new VaultHub(
        fixture.vault,
        testMetadata(fixture.statePath),
        testServices(env).hub,
      ), (hub) => hub.stop())).value;
    hub.scanNow(); // Initial inventory precedes subscriber admission, as at boot.
    scope.defer(subscribeIndex(hub, indexer));
    const manager = (await scope.acquire(() =>
      createPluginManager(
        fixture.vault,
        undefined,
        opts.workers ?? 1,
        fixture.statePath,
        { internalRoot: path.join(fixture.root, "internal"), env },
      ), (manager) => manager.stop())).value;
    installFixtureState(
      scope.defer,
      config,
      null,
      notes,
      indexer,
      files,
      manager,
    );
    const lifecycle = new PluginLifecycle(config);
    scope.onCancel(() => manager.runtime?.suspend());
    scope.defer(() => manager.runtime?.close());
    scope.defer(subscribeExternalFacts(hub, lifecycle));
    const operations = new NoteOperations({
      notes,
      files,
      indexer,
      hub,
      runtime: () => manager.runtime,
      lifecycle,
    });
    const actions = new PluginActions({
      operations,
      runtime: () => manager.runtime,
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      limits: opts.limits,
    });
    state.lifecycle = lifecycle;
    state.operations = operations;
    state.actions = actions;
    lifecycle.onFact((fact) => {
      manager.runtime?.post(`on-${fact.action}` as never, fact, {
        operationId: fact.operationId,
        action: fact.action,
      });
    });
    lifecycle.onSync((fact) => {
      manager.syncAll(fact).catch(() => undefined);
    });
    const rpc = servicePluginRpc({
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      actions: () => actions,
    });
    const runtime = manager.configureRuntime({
      operational: () => lifecycle.operational(),
      writable: () => lifecycle.writable(),
      commit: (effect) => lifecycle.gate.run(effect),
      sanitizeFact: (manifest, fact) =>
        lifecycle.applyReadGrants(manifest, fact as never),
      rpc: opts.beforeRead
        ? (...args) =>
          fixtureScope(async (read) => {
            // Start the real read before the timing hook, but observe its failure
            // immediately and join it even when the hook fails.
            const result = rpc(...args).then(
              (value) => ({ failed: false as const, value }),
              (error) => ({ failed: true as const, error }),
            );
            read.defer(async () => {
              const outcome = await result;
              if (outcome.failed) throw outcome.error;
            });
            await opts.beforeRead!(args[1], args[2]);
            const outcome = await result;
            return outcome.failed ? undefined : outcome.value;
          })
        : rpc,
    }, opts.limits);
    await runtime.reconcile();
    if (opts.recorder !== false) await pluginSettled(runtime, "recorder");
    return {
      fixture: opts.retain !== false
        ? await retainedPluginFixture(fixture)
        : compatibilityPluginFixture(fixture, () => owner.close()),
      lifecycle,
      operations,
      actions,
      indexer,
      hub,
      runtime,
      manager,
      facts: async () =>
        (await fixture.admit(() =>
          runtime.invokeCommand("recorder", "facts", {})
        )).value as {
          kind: string;
          fact: RecordedFact;
        }[],
      clearFacts: async () => {
        await fixture.admit(() =>
          runtime.invokeCommand("recorder", "clear", {})
        );
      },
      dispose: () => owner.close(),
    };
  });
}

export const api = () => fixtureApiOrigin(state.lifecycle!);
