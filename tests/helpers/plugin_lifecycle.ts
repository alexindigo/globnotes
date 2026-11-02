// SPDX-License-Identifier: LGPL-3.0-only

import * as path from "@std/path";
import { GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { PluginActions } from "../../server/plugins/actions.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import type { PluginManager } from "../../server/plugins/manager.ts";
import { createPluginManager } from "./plugin_manager.ts";
import type { PluginRuntime } from "../../server/plugins/runtime.ts";
import { servicePluginRpc } from "../../server/plugins/rpc.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState, state } from "../../server/state.ts";
import { fixtureApiOrigin, pluginFixture } from "./plugin_fixture.ts";
import { testEnvironment } from "./environment.ts";
import { pluginSettled } from "./plugin_ready.ts";

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
  const fixture = await pluginFixture();
  if (opts.recorder !== false) {
    await fixture.install("recorder", {
      runtime: { server: "service.js" },
      hooks: HOOKS,
      capabilities: { read: ["vault"], write: ["vault"] },
    }, { "service.js": RECORDER_SERVICE });
  }
  const env = testEnvironment({
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: "none",
    // External writes bypass the storage layer; scans must see them
    // immediately rather than through the 15s scan-cache TTL.
    GLOBNOTES_SCAN_CACHE_TTL: opts.scanCacheTtl ?? "0",
  });
  try {
    const config = new GlobalConfig(env);
    const notes = new FileSystemNotes(fixture.vault, opts.probes ?? {}, env);
    const indexer = new Fts5Indexer(fixture.statePath, env);
    const files = new FileServing(fixture.vault);
    const manager = createPluginManager(
      fixture.vault,
      undefined,
      opts.workers ?? 1,
      fixture.statePath,
      { internalRoot: path.join(fixture.root, "internal"), env },
    );
    initState(config, null, notes, indexer, files, manager);
    const lifecycle = new PluginLifecycle(config);
    const operations = new NoteOperations({
      notes,
      files,
      indexer,
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
        ? async (...args) => {
          const result = rpc(...args);
          await opts.beforeRead!(args[1], args[2]);
          return result;
        }
        : rpc,
    }, opts.limits);
    await runtime.reconcile();
    if (opts.recorder !== false) await pluginSettled(runtime, "recorder");
    return {
      fixture,
      lifecycle,
      operations,
      actions,
      indexer,
      runtime,
      manager,
      facts: async () =>
        await runtime.invokeCommand("recorder", "facts", {}) as {
          kind: string;
          fact: RecordedFact;
        }[],
      clearFacts: () =>
        runtime.invokeCommand("recorder", "clear", {}).then(() => undefined),
      dispose: async () => {
        await runtime.close();
        manager.stop();
        // Keep generated lifecycle proof vaults by default, including failures.
        if (opts.retain === false) await fixture.dispose();
      },
    };
  } catch (e) {
    if (opts.retain === false) await fixture.dispose();
    throw e;
  }
}

export const api = () => fixtureApiOrigin(state.lifecycle!);
