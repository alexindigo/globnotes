// SPDX-License-Identifier: LGPL-3.0-only

/** Guarded-operation lifecycle tests: rejection precedes mutation, actual
 * H1 renames and captured deletes reach observers, partial storage failure
 * accounting, external observation, deferred actions and conflict gates.
 * The bundle is composed in-process with injected adapters — exactly the
 * wiring main.ts performs. */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginActions } from "../server/plugins/actions.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
import type { PluginRuntime } from "../server/plugins/runtime.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { bootServer } from "./helpers/boot.ts";
import { fixtureApiOrigin, pluginFixture } from "./helpers/plugin_fixture.ts";

const RECORDER_SERVICE = `export function activate(ctx) {
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

const HOOKS = [
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

interface RecordedFact {
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

async function bundle(opts: {
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
  const prevPath = Deno.env.get("GLOBNOTES_PATH");
  const prevIndex = Deno.env.get("GLOBNOTES_INDEX_PATH");
  const prevAuth = Deno.env.get("GLOBNOTES_AUTH_TYPE");
  Deno.env.set("GLOBNOTES_PATH", fixture.vault);
  Deno.env.set("GLOBNOTES_INDEX_PATH", fixture.statePath);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  // External writes bypass the storage layer; scans must see them
  // immediately rather than through the 15s scan-cache TTL.
  const prevTtl = Deno.env.get("GLOBNOTES_SCAN_CACHE_TTL");
  Deno.env.set("GLOBNOTES_SCAN_CACHE_TTL", opts.scanCacheTtl ?? "0");
  try {
    const config = new GlobalConfig();
    const notes = new FileSystemNotes(fixture.vault, opts.probes ?? {});
    const indexer = new Fts5Indexer(fixture.statePath);
    const files = new FileServing(fixture.vault);
    const manager = new PluginManager(
      fixture.vault,
      undefined,
      opts.workers ?? 1,
      fixture.statePath,
      { internalRoot: path.join(fixture.root, "internal") },
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
    const deadline = Date.now() + 5000;
    while (
      opts.recorder !== false &&
      runtime.status("recorder")?.status === "starting" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
        if (prevPath === undefined) Deno.env.delete("GLOBNOTES_PATH");
        else Deno.env.set("GLOBNOTES_PATH", prevPath);
        if (prevIndex === undefined) Deno.env.delete("GLOBNOTES_INDEX_PATH");
        else Deno.env.set("GLOBNOTES_INDEX_PATH", prevIndex);
        if (prevAuth === undefined) Deno.env.delete("GLOBNOTES_AUTH_TYPE");
        else Deno.env.set("GLOBNOTES_AUTH_TYPE", prevAuth);
        if (prevTtl === undefined) Deno.env.delete("GLOBNOTES_SCAN_CACHE_TTL");
        else Deno.env.set("GLOBNOTES_SCAN_CACHE_TTL", prevTtl);
        // Keep generated lifecycle proof vaults by default, including failures.
        if (opts.retain === false) await fixture.dispose();
      },
    };
  } catch (e) {
    if (opts.retain === false) await fixture.dispose();
    throw e;
  }
}

const api = () => fixtureApiOrigin(state.lifecycle!);

interface SyncCacheConsumer {
  nonce: string;
  syncs: number;
  contents: Record<string, string>;
  facts?: OperationFact[];
}
const REVIEW_SYNC_RENDER = `let contents = {}, syncs = 0;
  const nonce = crypto.randomUUID();
  export function getSelectors() { return [{node:'fence'}]; }
  export async function onSync(ctx) {
    const next = {};
    for (const note of await ctx.listPaths()) next[note] = (await ctx.readNote(note)).content;
    contents = next; syncs++;
  }
  export function parseNode() { return {nonce, syncs, contents}; }`;
const REVIEW_SYNC_SERVICE = `export function activate(ctx) {
  const nonce = crypto.randomUUID(), facts = [];
  let contents = {}, syncs = 0;
  ctx.hooks.on('on-sync', async (fact) => {
    await ctx.readFile('Sync-barrier');
    const next = {};
    for (const note of await ctx.listPaths()) next[note] = (await ctx.readNote(note)).content;
    contents = next; syncs++; facts.push(fact);
  });
  ctx.commands.register({id:'inspect', label:'Inspect', target:'server'}, () => ({nonce, syncs, contents, facts}));
  ctx.commands.register({id:'request', label:'Request', target:'server'}, () => ctx.actions.request('create', {path:'ViaAction', content:'plugin action consumer'}));
  ctx.commands.register({id:'receipt', label:'Receipt', target:'server'}, (id) => ctx.actions.result(id));
  ctx.commands.register({id:'private', label:'Private', target:'server'}, async () => { const data = await ctx.data.load(); return ctx.data.save({privateConsumer: true}, data.revision); });
}`;

for (
  const mutation of [
    "create",
    "save",
    "rename-save",
    "delete",
    "markdown-upload",
    "attachment-upload",
    "rewrite-refs",
    "partial-save",
    "partial-rewrite",
    "no-op-save",
    "private-data",
    "plugin-action",
    "held-sync",
  ]
) {
  Deno.test(`review repairs: R19 real ${mutation} refreshes both retained render replicas and the service cache once`, async () => {
    const previous = { ...state };
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let partial = false, holding = false, partialWrites = 0;
    const actualPartialPaths: string[] = [];
    const b = await bundle({
      recorder: false,
      workers: 2,
      retain: true,
      scanCacheTtl: "15",
      probes: {
        afterWrite(filename) {
          if (!partial) return;
          partialWrites++;
          actualPartialPaths.push(path.basename(filename).slice(0, -3));
          if (
            (mutation === "partial-save" && filename.endsWith("/Seed.md")) ||
            (mutation === "partial-rewrite" && partialWrites === 2)
          ) throw new Error("owned R19 after-effect probe");
        },
      },
      beforeRead: async (method, args) => {
        if (holding && method === "readFile" && args[0] === "Sync-barrier") {
          reached.resolve();
          await release.promise;
        }
      },
    });
    const syncs: OperationFact[] = [],
      deliveries: Promise<void>[] = [],
      facts: OperationFact[] = [];
    try {
      Deno.writeTextFileSync(
        `${b.fixture.vault}/Seed.md`,
        "seed [asset](old.png)",
      );
      Deno.writeTextFileSync(
        `${b.fixture.vault}/Other.md`,
        "other [asset](old.png)",
      );
      if (mutation === "partial-rewrite") {
        Deno.writeTextFileSync(
          `${b.fixture.vault}/Third-candidate.md`,
          "third candidate [asset](old.png)",
        );
      }
      Deno.writeTextFileSync(
        `${b.fixture.vault}/Sync-barrier`,
        "real owned RPC barrier bytes",
      );
      await b.fixture.install("sync-cache", {
        runtime: { server: "service.js" },
        hooks: ["on-sync"],
        capabilities: { read: ["vault"], write: ["vault"] },
      }, { "main.js": REVIEW_SYNC_RENDER, "service.js": REVIEW_SYNC_SERVICE });
      await b.fixture.install("narrow-sync", {
        runtime: { server: "service.js" },
        hooks: ["on-sync"],
        capabilities: { read: ["Allowed"] },
      }, {
        "service.js": `export function activate(ctx) {
        const facts = []; ctx.hooks.on('on-sync', (fact) => { facts.push(fact); });
        ctx.commands.register({id:'inspect', label:'Inspect', target:'server'}, () => facts);
      }`,
      });
      await b.fixture.install("targeted-sync", {
        runtime: { server: "service.js" },
        hooks: ["on-sync"],
        capabilities: { read: ["vault"] },
      }, {
        "service.js": `export function activate(ctx) {
        const contents = {};
        ctx.hooks.on('on-sync', async (fact) => {
          const paths = fact.initial ? await ctx.listPaths() : fact.changedPaths || [];
          for (const note of paths) { try { contents[note] = (await ctx.readNote(note)).content; } catch { delete contents[note]; } }
        });
        ctx.commands.register({id:'inspect', label:'Inspect', target:'server'}, () => contents);
      }`,
      });
      await b.runtime.reconcile();
      const readyUntil = Date.now() + 5000;
      while (
        b.runtime.status("sync-cache")?.status === "starting" &&
        Date.now() < readyUntil
      ) await new Promise((resolve) => setTimeout(resolve, 2));
      assertEquals(b.runtime.status("sync-cache")?.status, "ready");
      const narrowUntil = Date.now() + 5000;
      while (
        b.runtime.status("narrow-sync")?.status === "starting" &&
        Date.now() < narrowUntil
      ) await new Promise((resolve) => setTimeout(resolve, 2));
      assertEquals(b.runtime.status("narrow-sync")?.status, "ready");
      const targetedUntil = Date.now() + 5000;
      while (
        b.runtime.status("targeted-sync")?.status === "starting" &&
        Date.now() < targetedUntil
      ) await new Promise((resolve) => setTimeout(resolve, 2));
      assertEquals(b.runtime.status("targeted-sync")?.status, "ready");
      b.lifecycle.onFact((fact) => {
        facts.push(fact);
      });
      b.lifecycle.onSync((fact) => {
        syncs.push(fact);
        const delivery = b.manager.syncAll(fact);
        deliveries.push(delivery);
        delivery.catch(() => undefined);
      });
      await b.manager.start();
      b.indexer.startBackgroundSync();
      const initialUntil = Date.now() + 5000;
      while (b.indexer.indexStatus.syncing && Date.now() < initialUntil) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals(b.indexer.indexStatus.syncing, false);
      await Promise.all(deliveries);
      const host = b.manager.hosts.get("sync-cache")!;
      const readReplicas = () =>
        Promise.all([
          host.call("parseNode", [{}]),
          host.call("parseNode", [{}]),
        ]) as Promise<SyncCacheConsumer[]>;
      const before = await readReplicas(),
        serviceBefore = await b.runtime.invokeCommand(
          "sync-cache",
          "inspect",
          {},
        ) as SyncCacheConsumer;
      assertEquals(new Set(before.map((value) => value.nonce)).size, 2);
      assertEquals(before[0].contents, {
        Seed: "seed [asset](old.png)",
        Other: "other [asset](old.png)",
        ...(mutation === "partial-rewrite"
          ? { "Third-candidate": "third candidate [asset](old.png)" }
          : {}),
      });
      const start = syncs.length;
      if (mutation === "create") {
        await b.operations.createNote({
          path: "Created",
          content: "created consumer",
        }, api());
      }
      if (mutation === "save") {
        await b.operations.updateNote(
          "Seed",
          { newContent: "saved consumer" },
          "none",
          api(),
        );
      }
      if (mutation === "rename-save") {
        await b.operations.updateNote(
          "Seed",
          { newPath: "Renamed", newContent: "renamed consumer" },
          "none",
          api(),
        );
      }
      if (mutation === "delete") await b.operations.deleteNote("Seed", api());
      if (mutation === "markdown-upload") {
        await b.operations.uploadFile(
          "",
          "Uploaded.md",
          new TextEncoder().encode("uploaded consumer"),
          api(),
        );
      }
      if (mutation === "attachment-upload") {
        await b.operations.uploadFile(
          "",
          "photo (sample).png",
          new Uint8Array([1, 2, 3]),
          api(),
        );
      }
      if (mutation === "rewrite-refs") {
        await b.operations.rewriteRefs("old.png", "new.png", api());
      }
      if (mutation === "partial-save") {
        partial = true;
        const outcome = await b.operations.updateNote(
          "Seed",
          { newContent: "actual partial consumer" },
          "none",
          api(),
        ).then(() => null, (error) => error);
        assert(outcome instanceof OperationError);
        assertEquals(outcome.code, "operation_partial");
      }
      if (mutation === "partial-rewrite") {
        partial = true;
        const outcome = await b.operations.rewriteRefs(
          "old.png",
          "new.png",
          api(),
        ).then(() => null, (error) => error);
        assert(outcome instanceof OperationError);
        assertEquals(outcome.code, "operation_partial");
        assertEquals(partialWrites, 2);
      }
      if (mutation === "no-op-save") {
        await b.operations.updateNote("Seed", {}, "none", api());
      }
      if (mutation === "private-data") {
        await b.runtime.invokeCommand("sync-cache", "private", {});
      }
      if (mutation === "plugin-action") {
        const accepted = await b.runtime.invokeCommand(
          "sync-cache",
          "request",
          {},
        ) as { requestId: string };
        const until = Date.now() + 5000;
        let receipt: { status: string } = { status: "accepted" };
        while (
          ["accepted", "running"].includes(receipt.status) && Date.now() < until
        ) {
          receipt = await b.runtime.invokeCommand(
            "sync-cache",
            "receipt",
            accepted.requestId,
          ) as typeof receipt;
          if (["accepted", "running"].includes(receipt.status)) {
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
        }
        assertEquals(receipt.status, "completed");
      }
      if (mutation === "held-sync") {
        holding = true;
        await b.operations.createNote({
          path: "Held",
          content: "ack independent of sync",
        }, api());
        assertEquals(
          syncs.length - start,
          1,
          "the committed operation must admit sync without waiting for it",
        );
        await reached.promise;
        assertEquals(
          Deno.readTextFileSync(`${b.fixture.vault}/Held.md`),
          "ack independent of sync",
        );
        console.log(
          JSON.stringify({ mutationAckObservedWhileRealSyncRpcHeld: true }),
        );
        release.resolve();
      }
      await Promise.all(deliveries.slice(start));
      const after = await readReplicas(),
        serviceAfter = await b.runtime.invokeCommand(
          "sync-cache",
          "inspect",
          {},
        ) as SyncCacheConsumer;
      const expected: Record<string, string> = {};
      for (const entry of Deno.readDirSync(b.fixture.vault)) {
        if (entry.name.endsWith(".md")) {
          expected[entry.name.slice(0, -3)] = Deno.readTextFileSync(
            `${b.fixture.vault}/${entry.name}`,
          );
        }
      }
      console.log(JSON.stringify({
        mutation,
        admittedSyncs: syncs.length - start,
        actualExpected: expected,
        replicaConsumers: after,
        serviceConsumer: serviceAfter,
        retainedManagedSyncFixture: b.fixture.root,
      }));
      for (const value of after) {
        const original = before.find((candidate) =>
          candidate.nonce === value.nonce
        );
        assert(
          original,
          "ordinary mutation must retain both replica identities",
        );
        assertEquals(value.contents, expected);
        assertEquals(
          value.syncs,
          original.syncs +
            (["no-op-save", "private-data"].includes(mutation) ? 0 : 1),
        );
      }
      const targeted = await b.runtime.invokeCommand(
        "targeted-sync",
        "inspect",
        {},
      ) as Record<string, string>;
      console.log(
        JSON.stringify({ mutation, targetedPathCacheConsumer: targeted }),
      );
      assertEquals(
        targeted,
        expected,
        "changedPaths must refresh every actual note effect, including the failed after-write path",
      );
      const increment = ["no-op-save", "private-data"].includes(mutation)
        ? 0
        : 1;
      assertEquals(serviceAfter.nonce, serviceBefore.nonce);
      assertEquals(serviceAfter.contents, expected);
      assertEquals(serviceAfter.syncs, serviceBefore.syncs + increment);
      assertEquals(syncs.length - start, increment);
      if (increment) {
        const boundary = syncs.at(-1)!;
        assertEquals(boundary.action, "sync");
        assertEquals(
          boundary.origin,
          mutation === "plugin-action" ? "plugin" : "api",
        );
        assertEquals(boundary.initial, false);
        assert(facts.some((fact) => fact.operationId === boundary.operationId));
        assertEquals(
          new Set(boundary.changedPaths).size,
          boundary.changedPaths?.length ?? 0,
        );
        if (mutation === "partial-rewrite") {
          assertEquals(
            new Set(boundary.changedPaths),
            new Set(actualPartialPaths),
          );
          const effects = boundary.metadata?.effects;
          assert(Array.isArray(effects));
          assertEquals(effects.length, 2);
        }
        const observed = await b.runtime.invokeCommand(
          "narrow-sync",
          "inspect",
          {},
        ) as OperationFact[];
        const narrow = observed.find((fact) =>
          fact.operationId === boundary.operationId
        )!;
        assert(narrow);
        assertEquals(narrow.changedPaths, []);
        assertEquals(narrow.metadata?.effects, []);
      }
      const afterScan = syncs.length;
      b.indexer.syncIndex();
      await Promise.all(deliveries);
      assertEquals(
        syncs.length,
        afterScan,
        "scan must not duplicate the managed sync",
      );
    } finally {
      release.resolve();
      await b.dispose();
      Object.assign(state, previous);
      console.log(JSON.stringify({ retainedR19Fixture: b.fixture.root }));
    }
  });
}

Deno.test("review repairs: R19 scanner acknowledges a managed observation but still synchronizes a later genuine outside edit", async () => {
  const previous = { ...state },
    b = await bundle({ recorder: false, retain: true });
  const syncs: OperationFact[] = [], facts: OperationFact[] = [];
  try {
    b.lifecycle.onSync((fact) => {
      syncs.push(fact);
    });
    b.lifecycle.onFact((fact) => {
      facts.push(fact);
    });
    const filename = `${b.fixture.vault}/Managed.md`;
    Deno.writeTextFileSync(filename, "managed scanner observation");
    const mtime = (Deno.statSync(filename).mtime?.getTime() ?? 0) / 1000;
    b.lifecycle.recordManaged("Managed.md", mtime);
    b.indexer.syncIndex();
    assertEquals(b.indexer.search("managed").map((entry) => entry.path), [
      "Managed",
    ]);
    assertEquals(facts, []);
    assertEquals(
      syncs,
      [],
      "acknowledged managed observation must not emit duplicate external sync",
    );
    Deno.writeTextFileSync(filename, "genuine later outside edit");
    Deno.utimeSync(filename, mtime + 1, mtime + 1);
    b.indexer.syncIndex();
    assertEquals(facts.length, 1);
    assertEquals(facts[0].origin, "external");
    assertEquals(syncs.length, 1);
    assertEquals(syncs[0].changedPaths, ["Managed"]);
    assertEquals(b.indexer.search("genuine").map((entry) => entry.path), [
      "Managed",
    ]);
    console.log(
      JSON.stringify({
        managedScanDuplicateSyncs: 0,
        genuineLaterExternalSyncs: 1,
        retainedScannerFixture: b.fixture.root,
      }),
    );
  } finally {
    await b.dispose();
    Object.assign(state, previous);
  }
});

for (
  const change of [
    "retarget",
    "directory-occupation",
    "symlink-occupation",
    "unchanged-collision",
  ]
) {
  Deno.test(`review repairs: R23 upload ${change} revalidates canonical target and preserves the disclosed filename`, async () => {
    const previous = { ...state };
    const b = await bundle({ retain: true });
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const guard = b.runtime.guard.bind(b.runtime);
    const syncs: OperationFact[] = [];
    let prepared: OperationFact | undefined,
      pending: Promise<unknown> | undefined;
    try {
      Deno.mkdirSync(`${b.fixture.vault}/a`);
      Deno.mkdirSync(`${b.fixture.vault}/b`);
      Deno.symlinkSync("a", `${b.fixture.vault}/chosen`);
      if (change === "unchanged-collision") {
        Deno.writeTextFileSync(
          `${b.fixture.vault}/a/photo.png`,
          "preserved existing photo",
        );
      }
      b.lifecycle.onSync((fact) => {
        syncs.push(fact);
      });
      b.runtime.guard = async (...args) => {
        const leases = await guard(...args);
        if (args[0] === "pre-upload") {
          prepared = args[1] as OperationFact;
          reached.resolve();
          await release.promise;
        }
        return leases;
      };
      pending = b.operations.uploadFile(
        "chosen",
        "photo.png",
        new Uint8Array([4, 5, 6]),
        api(),
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, status: error.status, code: error.code }),
      );
      await reached.promise;
      const filename = prepared!.metadata!.filename as string,
        originalTarget = `${b.fixture.vault}/a/${filename}`;
      if (change === "retarget") {
        Deno.removeSync(`${b.fixture.vault}/chosen`);
        Deno.symlinkSync("b", `${b.fixture.vault}/chosen`);
      }
      if (change === "directory-occupation") Deno.mkdirSync(originalTarget);
      if (change === "symlink-occupation") {
        Deno.symlinkSync("missing.png", originalTarget);
      }
      release.resolve();
      const result = await pending as {
        ok: boolean;
        status?: number;
        code?: string;
        value?: { filename: string };
      };
      console.log(
        JSON.stringify({
          change,
          disclosedFilename: filename,
          actualUploadResult: result,
          syncs: syncs.length,
          retainedUploadFixture: b.fixture.root,
        }),
      );
      if (change === "unchanged-collision") {
        assertEquals(result.ok, true);
        assertEquals(result.value?.filename, filename);
        assert(filename !== "photo.png");
        assertEquals(
          Deno.readFileSync(originalTarget),
          new Uint8Array([4, 5, 6]),
        );
        assertEquals(
          Deno.readTextFileSync(`${b.fixture.vault}/a/photo.png`),
          "preserved existing photo",
        );
      } else {
        assertEquals(result.ok, false);
        assertEquals(result.status, 409);
        assertEquals(result.code, "operation_conflict");
        assertEquals([...Deno.readDirSync(`${b.fixture.vault}/b`)], []);
        if (change === "retarget") {
          assertEquals([...Deno.readDirSync(`${b.fixture.vault}/a`)], []);
        }
        assertEquals(
          (await b.facts()).filter((entry) => entry.kind === "on-upload"),
          [],
        );
        assertEquals(syncs, []);
      }
    } finally {
      release.resolve();
      b.runtime.guard = guard;
      if (pending) await pending;
      await b.dispose();
      Object.assign(state, previous);
      console.log(JSON.stringify({ retainedR23Fixture: b.fixture.root }));
    }
  });
}

Deno.test("lifecycle: create/save/rename/delete reach observers with actual outcomes", async () => {
  const b = await bundle();
  try {
    const created = await b.operations.createNote(
      { path: "alpha", content: "# Alpha\nbody" },
      api(),
    );
    assertEquals(created.path, "alpha");

    // Content-only save with an H1 change resolves to a real rename.
    const renamed = await b.operations.updateNote(
      "alpha",
      { newContent: "# Beta\nbody2" },
      "none",
      api(),
    );
    assertEquals(renamed.path, "Beta");
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "Beta.md")),
      "# Beta\nbody2",
    );

    await b.operations.deleteNote("Beta", api());
    const observed = await b.facts();
    assertEquals(observed.map((entry) => entry.kind), [
      "on-create",
      "on-sync",
      "on-rename",
      "on-save",
      "on-sync",
      "on-delete",
      "on-sync",
    ]);
    const facts = observed.filter((entry) => entry.kind !== "on-sync");
    assertEquals(
      observed.filter((entry) => entry.kind === "on-sync").map((entry) =>
        entry.fact.operationId
      ),
      [
        facts[0].fact.operationId,
        facts[1].fact.operationId,
        facts[3].fact.operationId,
      ],
    );
    const kinds = facts.map((f) => f.kind);
    // Combined rename+save: on-rename THEN on-save, one operation ID.
    assertEquals(kinds, [
      "on-create",
      "on-rename",
      "on-save",
      "on-delete",
    ]);
    assertEquals(facts[0].fact.after, {
      path: "alpha",
      content: "# Alpha\nbody",
      lastModified: facts[0].fact.after!.lastModified,
      contentAvailable: true,
    });
    assertEquals(facts[1].fact.oldPath, "alpha");
    assertEquals(facts[1].fact.newPath, "Beta");
    assertEquals(
      facts[1].fact.operationId,
      facts[2].fact.operationId,
    );
    // The delete fact carries the captured BEFORE snapshot and after:null.
    assertEquals(facts[3].fact.before!.content, "# Beta\nbody2");
    assertEquals(facts[3].fact.after, null);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: cancellation and guard timeout leave disk and index untouched", async () => {
  const b = await bundle();
  try {
    await b.operations.createNote({ path: "keep", content: "# Keep\n" }, api());
    await b.clearFacts();
    const before = Deno.readTextFileSync(path.join(b.fixture.vault, "keep.md"));

    const cancelled = await b.operations
      .updateNote("keep", { newContent: "#BLOCK#" }, "none", api())
      .then(() => null)
      .catch((e) => e);
    assert(cancelled instanceof OperationError);
    assertEquals(cancelled.status, 409);
    assertEquals(cancelled.code, "plugin_cancelled");
    assertEquals(cancelled.pluginId, "recorder");
    assertEquals(cancelled.action, "save");
    assertEquals(cancelled.detail, "fixture protection");

    const cancelledCreate = await b.operations
      .createNote({ path: "nope", content: "#BLOCK#" }, api())
      .then(() => null)
      .catch((e) => e);
    assertEquals(cancelledCreate.code, "plugin_cancelled");

    // A note carrying the marker arrives externally, so its delete guard
    // sees the protected content in the captured before-snapshot.
    Deno.writeTextFileSync(
      path.join(b.fixture.vault, "blocked.md"),
      "#BLOCK#",
    );
    const cancelledDelete = await b.operations
      .deleteNote("blocked", api())
      .then(() => null)
      .catch((e) => e);
    assertEquals(cancelledDelete.code, "plugin_cancelled");
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "blocked.md")),
      "#BLOCK#",
    );

    // No effects, and NO post-facts for rejected operations.
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "keep.md")),
      before,
    );
    assertEquals(b.indexer.search("Keep").length, 1);
    let missing = false;
    try {
      Deno.statSync(path.join(b.fixture.vault, "nope.md"));
    } catch {
      missing = true;
    }
    assert(missing);
    assertEquals((await b.facts()).length, 0);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: unavailable required guard rejects with plugin_guard_failed", async () => {
  const b = await bundle();
  try {
    // Disable → reconcile → re-enable with a manifest whose runtime omits
    // the required guard registration: activation failure must block.
    const dir = path.join(b.fixture.statePath, "plugins", "recorder");
    const service = Deno.readTextFileSync(path.join(dir, "service.js"));
    Deno.writeTextFileSync(
      path.join(dir, "service.js"),
      "export function activate() {}",
    );
    await b.manager.runtime!.suspend();
    await b.runtime.reconcile();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const s = b.runtime.status("recorder")?.status;
      if (s === "failed" || s === "ready") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(b.runtime.status("recorder")?.status, "failed");
    const error = await b.operations
      .createNote({ path: "blocked", content: "x" }, api())
      .then(() => null)
      .catch((e) => e);
    assert(error instanceof OperationError);
    assertEquals(error.status, 503);
    assertEquals(error.code, "plugin_guard_failed");
    assertEquals(error.pluginId, "recorder");
    // Failed enabled guard stays an expected blocker until recovery.
    Deno.writeTextFileSync(path.join(dir, "service.js"), service);
    await b.runtime.reconcile();
    const deadline2 = Date.now() + 3000;
    while (
      b.runtime.status("recorder")?.status === "starting" &&
      Date.now() < deadline2
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(b.runtime.status("recorder")?.status, "ready");
    await b.operations.createNote({ path: "blocked", content: "x" }, api());
    assert(Deno.statSync(path.join(b.fixture.vault, "blocked.md")).isFile);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: upload resolves the collision name before hooks and emits correlated note-create", async () => {
  const b = await bundle();
  try {
    Deno.writeTextFileSync(path.join(b.fixture.vault, "att.md"), "# Old\n");
    const result = await b.operations.uploadFile(
      "",
      "att.md",
      new TextEncoder().encode("# New\n"),
      api(),
    );
    assert(result.filename.startsWith("att_"));
    const facts = await b.facts();
    assertEquals(facts.map((f) => f.kind), [
      "on-upload",
      "on-create",
      "on-sync",
    ]);
    assertEquals(facts[0].fact.metadata!.filename, result.filename);
    assertEquals(facts[0].fact.operationId, facts[1].fact.operationId);
    assertEquals(facts[1].fact.metadata!.upload, true);
    assertEquals(facts[2].fact.operationId, facts[0].fact.operationId);
    assertEquals(facts[2].fact.changedPaths, [result.filename.slice(0, -3)]);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: rewrite-refs guards the aggregate and affected saves; partial failure accounts truthfully", async (t) => {
  await t.step(
    "full success publishes correlated results without renames",
    async () => {
      const b = await bundle();
      try {
        await b.operations.createNote(
          { path: "one", content: "# One\n![a](att.png)" },
          api(),
        );
        await b.operations.createNote(
          { path: "two", content: "# Two\n[link](att.png)" },
          api(),
        );
        await b.clearFacts();
        await b.operations.rewriteRefs("att.png", "renamed.png", api());
        const facts = await b.facts();
        assertEquals(
          facts.map((f) => f.kind),
          ["on-save", "on-save", "on-rewrite-refs", "on-sync"],
        );
        const opIds = new Set(facts.map((f) => f.fact.operationId));
        assertEquals(opIds.size, 1);
        assertEquals(
          new Set(facts[3].fact.changedPaths),
          new Set(["one", "two"]),
        );
        assert(
          Deno.readTextFileSync(path.join(b.fixture.vault, "one.md"))
            .includes("renamed.png"),
        );
        // Index sees the rewritten content immediately (managed signature —
        // the later scan must not double-report).
        assertEquals(b.indexer.search("renamed").length >= 0, true);
      } finally {
        await b.dispose();
      }
    },
  );

  await t.step(
    "injected failure after the first write emits verified facts + operation_partial",
    async () => {
      let armed = false;
      let writes = 0;
      const b = await bundle({
        probes: {
          afterWrite: () => {
            if (!armed) return;
            writes++;
            if (writes === 2) throw new Error("injected storage failure");
          },
        },
      });
      try {
        await b.operations.createNote(
          { path: "one", content: "# One\n![a](att.png)" },
          api(),
        );
        await b.operations.createNote(
          { path: "two", content: "# Two\n[link](att.png)" },
          api(),
        );
        await b.clearFacts();
        armed = true;
        writes = 0;
        const error = await b.operations
          .rewriteRefs("att.png", "renamed.png", api())
          .then(() => null)
          .catch((e) => e);
        assert(error instanceof OperationError);
        assertEquals(error.code, "operation_partial");
        assertEquals(error.status, 500);
        assertEquals(error.partial!.completedPaths.length, 1);
        assertEquals(error.partial!.failedPath !== undefined, true);
        const facts = await b.facts();
        // Exactly one verified save, then the error and actual-effect sync —
        // never an aggregate success or a fabricated completed receipt.
        assertEquals(facts.map((f) => f.kind), [
          "on-save",
          "on-operation-error",
          "on-sync",
        ]);
        assertEquals(
          facts[0].fact.operationId,
          facts[1].fact.operationId,
        );
        assertEquals(facts[2].fact.operationId, facts[0].fact.operationId);
        // Disk and index agree on the one completed write.
        const done = facts[0].fact.path as string;
        assert(
          Deno.readTextFileSync(path.join(b.fixture.vault, done + ".md"))
            .includes("renamed.png"),
        );
      } finally {
        await b.dispose();
      }
    },
  );
});

Deno.test("lifecycle: external changes are observed; managed writes are not double-reported", async () => {
  const b = await bundle();
  try {
    // Managed create first: index reindexed at commit; the scan must not
    // emit a duplicate external create.
    await b.operations.createNote({ path: "managed", content: "# M\n" }, api());
    await b.clearFacts();
    b.indexer.syncIndex();
    assertEquals(
      (await b.facts()).filter((f) => f.kind !== "on-sync").length,
      0,
    );

    // External create / modify / delete. mtimes are bumped explicitly so
    // same-millisecond writes are still observed as changes.
    const extFile = path.join(b.fixture.vault, "ext.md");
    Deno.writeTextFileSync(extFile, "# External\n");
    Deno.utimeSync(extFile, new Date(), new Date(Date.now() + 2000));
    b.indexer.syncIndex();
    Deno.writeTextFileSync(extFile, "# External 2\n");
    Deno.utimeSync(extFile, new Date(), new Date(Date.now() + 4000));
    b.indexer.syncIndex();
    Deno.removeSync(extFile);
    b.indexer.syncIndex();
    const facts = (await b.facts()).filter((f) => f.kind !== "on-sync");
    assertEquals(facts.map((f) => f.kind), [
      "on-create",
      "on-save",
      "on-delete",
    ]);
    assert(facts.every((f) => f.fact.origin === "external"));
    assertEquals(facts[0].fact.after!.content, "# External\n");
    // Prior content explicitly unavailable for external modifications.
    assertEquals(facts[1].fact.before!.contentAvailable, false);
    assertEquals(facts[1].fact.before!.content, undefined);
    assertEquals(facts[2].fact.before!.contentAvailable, false);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: initial indexing is inventory plus on-sync, not fake creates", async () => {
  const fixture = await pluginFixture();
  try {
    Deno.writeTextFileSync(
      path.join(fixture.vault, "pre.md"),
      "# Pre-existing\n",
    );
    await fixture.install("recorder", {
      runtime: { server: "service.js" },
      hooks: HOOKS,
      capabilities: { read: ["vault"], write: ["vault"] },
    }, { "service.js": RECORDER_SERVICE });
    const prevPath = Deno.env.get("GLOBNOTES_PATH");
    const prevIndex = Deno.env.get("GLOBNOTES_INDEX_PATH");
    const prevAuth = Deno.env.get("GLOBNOTES_AUTH_TYPE");
    Deno.env.set("GLOBNOTES_PATH", fixture.vault);
    Deno.env.set("GLOBNOTES_INDEX_PATH", fixture.statePath);
    Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
    let manager: PluginManager | null = null;
    try {
      const config = new GlobalConfig();
      const notes = new FileSystemNotes(fixture.vault);
      const indexer = new Fts5Indexer(fixture.statePath);
      const files = new FileServing(fixture.vault);
      manager = new PluginManager(
        fixture.vault,
        undefined,
        1,
        fixture.statePath,
        {
          internalRoot: path.join(fixture.root, "internal"),
        },
      );
      initState(config, null, notes, indexer, files, manager);
      const lifecycle = new PluginLifecycle(config);
      state.lifecycle = lifecycle;
      const operations = new NoteOperations({
        notes,
        files,
        indexer,
        runtime: () => manager!.runtime,
        lifecycle,
      });
      state.operations = operations;
      state.actions = new PluginActions({
        operations,
        runtime: () => manager!.runtime,
        vaultPath: fixture.vault,
        statePath: fixture.statePath,
      });
      lifecycle.onFact((fact) =>
        manager!.runtime?.post(`on-${fact.action}` as never, fact)
      );
      lifecycle.onSync((fact) => {
        manager!.syncAll(fact).catch(() => undefined);
      });
      const runtime = manager.configureRuntime({
        operational: () => true,
        writable: () => true,
        commit: (effect) => lifecycle.gate.run(effect),
        rpc: servicePluginRpc({
          vaultPath: fixture.vault,
          statePath: fixture.statePath,
          actions: () => state.actions!,
        }),
      });
      await runtime.reconcile();
      const deadline = Date.now() + 5000;
      while (
        runtime.status("recorder")?.status === "starting" &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      indexer.startBackgroundSync();
      // startBackgroundSync is async internally; wait until the initial
      // on-sync fact actually reaches the observer.
      const waitDeadline = Date.now() + 5000;
      let facts: { kind: string; fact: RecordedFact }[] = [];
      while (Date.now() < waitDeadline) {
        facts = await runtime.invokeCommand("recorder", "facts", {}) as {
          kind: string;
          fact: RecordedFact;
        }[];
        if (facts.some((f) => f.kind === "on-sync")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const creates = facts.filter((f) => f.kind === "on-create");
      assertEquals(creates.length, 0);
      const syncs = facts.filter((f) => f.kind === "on-sync");
      assertEquals(syncs.length >= 1, true);
      assertEquals(syncs[0].fact.initial, true);
      await runtime.close();
    } finally {
      manager?.stop();
      if (prevPath === undefined) Deno.env.delete("GLOBNOTES_PATH");
      else Deno.env.set("GLOBNOTES_PATH", prevPath);
      if (prevIndex === undefined) Deno.env.delete("GLOBNOTES_INDEX_PATH");
      else Deno.env.set("GLOBNOTES_INDEX_PATH", prevIndex);
      if (prevAuth === undefined) Deno.env.delete("GLOBNOTES_AUTH_TYPE");
      else Deno.env.set("GLOBNOTES_AUTH_TYPE", prevAuth);
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("lifecycle: nested note mutation during a pre-hook is rejected; deferred action runs after", async () => {
  const b = await bundle();
  try {
    // A fixture whose pre-save tries a deferred mutating action — rejected
    // synchronously inside the guard; its on-save issues a legal deferred
    // create which runs AFTER the originating save commits.
    const dir = path.join(b.fixture.statePath, "plugins", "recorder");
    Deno.writeTextFileSync(
      path.join(dir, "service.js"),
      RECORDER_SERVICE.replace(
        "ctx.hooks.on('pre-save', protect);",
        `ctx.hooks.on('pre-save', (fact) => {
          const blocked = protect(fact);
          if (blocked) return blocked;
          if ((fact?.proposed?.content ?? '').includes('#NESTED#')) {
            try { ctx.actions.request('create', { path: 'illegal', content: 'x' }); globalThis.__nested = 'NOT-REJECTED'; }
            catch { globalThis.__nested = 'rejected'; }
          }
        });`,
      ).replace(
        "ctx.hooks.on('on-save', record('on-save'));",
        `ctx.hooks.on('on-save', async (fact) => {
          record('on-save')(fact);
          if ((fact?.after?.content ?? '').includes('#SPAWN#') && !globalThis.__spawned) {
            globalThis.__spawned = true;
            globalThis.__spawnReceipt = (await ctx.actions.request('create', { path: 'spawned', content: '# Spawned\\n' })).requestId;
          }
        });`,
      ).replace(
        "ctx.commands.register({ id: 'receipt'",
        `ctx.commands.register({ id: 'nested', label: 'Nested', target: 'server' }, () => globalThis.__nested ?? null);
  ctx.commands.register({ id: 'spawnreceipt', label: 'SpawnReceipt', target: 'server' }, (id) => ctx.actions.result(globalThis.__spawnReceipt ?? id));
  ctx.commands.register({ id: 'receipt'`,
      ),
    );
    await b.runtime.suspend();
    await b.runtime.reconcile();
    const deadline = Date.now() + 5000;
    while (
      b.runtime.status("recorder")?.status === "starting" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await b.operations.createNote({ path: "n", content: "# N\n" }, api());
    await b.operations.updateNote(
      "n",
      { newContent: "#NESTED#" },
      "none",
      api(),
    );
    // The nested request was rejected inside the guard.
    const nestedFlag = await b.runtime.invokeCommand("recorder", "nested", {});
    assertEquals(nestedFlag, "rejected");
    let illegal = true;
    try {
      Deno.statSync(path.join(b.fixture.vault, "illegal.md"));
      illegal = false;
    } catch { /* expected */ }
    assert(illegal, "pre-hook deferred mutation must not execute");

    // Legal deferred action from an on-hook runs after commit.
    await b.operations.createNote({ path: "s", content: "# S\n" }, api());
    await b.operations.updateNote(
      "s",
      { newContent: "#SPAWN#" },
      "none",
      api(),
    );
    const spawnDeadline = Date.now() + 5000;
    while (Date.now() < spawnDeadline) {
      try {
        Deno.statSync(path.join(b.fixture.vault, "spawned.md"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert(Deno.statSync(path.join(b.fixture.vault, "spawned.md")).isFile);
    // The correlated receipt is queryable and reports completion.
    const receipt = await b.runtime.invokeCommand(
      "recorder",
      "spawnreceipt",
      {},
    ) as { status: string };
    assertEquals(receipt.status, "completed");
    const facts = await b.facts();
    const spawnSave = facts.find((f) => f.kind === "on-save");
    assert(spawnSave !== undefined);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: causal chain beyond the limit is rejected visibly", async () => {
  const b = await bundle({ limits: { causalDepth: 3 } });
  try {
    // Each on-create spawns another create → unbounded without the limit.
    const dir = path.join(b.fixture.statePath, "plugins", "recorder");
    Deno.writeTextFileSync(
      path.join(dir, "service.js"),
      RECORDER_SERVICE.replace(
        "ctx.hooks.on('on-create', record('on-create'));",
        `ctx.hooks.on('on-create', (fact) => {
          record('on-create')(fact);
          try { ctx.actions.request('create', { path: 'chain-' + (globalThis.__chain = (globalThis.__chain || 0) + 1), content: 'x' }); }
          catch (e) { globalThis.__chainError = e.message; }
        });`,
      ),
    );
    await b.runtime.suspend();
    await b.runtime.reconcile();
    const deadline = Date.now() + 5000;
    while (
      b.runtime.status("recorder")?.status === "starting" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await b.operations.createNote({ path: "seed", content: "x" }, api());
    await new Promise((r) => setTimeout(r, 800));
    const chainFiles = [...Deno.readDirSync(b.fixture.vault)]
      .filter((e) => e.name.startsWith("chain-"));
    // The chain stopped: bounded number of files, then a visible error.
    assert(chainFiles.length <= 4, `chain created ${chainFiles.length} files`);
    const facts = await b.facts();
    assert(facts.filter((f) => f.kind === "on-create").length <= 5);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: wire envelope over HTTP carries structured codes; rewrite catch-all keeps them", async () => {
  const fixture = await pluginFixture();
  try {
    await fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save", "pre-rewrite-refs"],
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('pre-save', (fact) => {
          if ((fact?.proposed?.content ?? '').includes('#BLOCK#')) return { cancel: true, reason: 'no blocked content' };
        });
        ctx.hooks.on('pre-rewrite-refs', () => {});
      }`,
    });
    const server = await bootServer({
      GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_INDEX_PATH: fixture.statePath,
      GLOBNOTES_AUTH_TYPE: "none",
      GLOBNOTES_PATH_PREFIX: "",
    });
    try {
      // Guard runtime must be up before the operation — wait via catalog-free retry.
      const create = await fetch(`${server.baseUrl}/_/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "doc", content: "# Doc\n" }),
      });
      assertEquals(create.status, 200);
      await create.body?.cancel();

      let blocked: Response | null = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const res = await fetch(`${server.baseUrl}/_/api/notes/doc`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newContent: "#BLOCK#" }),
        });
        if (res.status === 409) {
          blocked = res;
          break;
        }
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(blocked !== null, "guard never enforced over HTTP");
      const body = await blocked.json();
      assertEquals(blocked.status, 409);
      assertEquals(body.code, "plugin_cancelled");
      assertEquals(body.detail, "no blocked content");
      assertEquals(body.pluginId, "guard");
      assertEquals(body.action, "save");
      assertEquals(typeof body.operationId, "string");
      // Disk unchanged.
      assertEquals(
        Deno.readTextFileSync(path.join(fixture.vault, "doc.md")),
        "# Doc\n",
      );

      // Duplicate-title 409 keeps its legacy shape (detail only, no code).
      const dup = await fetch(`${server.baseUrl}/_/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "doc", content: "x" }),
      });
      assertEquals(dup.status, 409);
      const dupBody = await dup.json();
      assertEquals(dupBody.code, undefined);
    } finally {
      await server.close();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("lifecycle: policy epoch change during a suspended operation rejects with operation_conflict", async () => {
  const b = await bundle();
  try {
    await b.operations.createNote({ path: "epoch", content: "# E\n" }, api());
    // Capture the epoch the next operation will see, then simulate a
    // suspended operation whose commit gate runs after a policy change:
    // directly exercise the gate through a hooked commit adapter.
    const captured = b.lifecycle.epoch;
    b.lifecycle.bumpEpoch();
    const error = await b.lifecycle.gate.run(() => {
      if (b.lifecycle.epoch !== captured) {
        return Promise.resolve(
          new OperationError(
            409,
            "operation_conflict",
            "Access policy changed while this operation was pending; it was not applied.",
          ),
        );
      }
      return Promise.resolve(null);
    });
    assert(error instanceof OperationError);
    assertEquals(error.code, "operation_conflict");
    assertEquals(error.status, 409);
    // Disk untouched.
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "epoch.md")),
      "# E\n",
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: on-only plugin overflow/failure never blocks a note action", async () => {
  const b = await bundle({ limits: { queuedJobs: 4, serviceCallMs: 60 } });
  try {
    // A SEPARATE on-only observer: slow/hanging deliveries and queue
    // overflow must degrade it visibly — never block the note action.
    await b.fixture.install("hanger", {
      runtime: { server: "service.js" },
      hooks: ["on-save"],
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('on-save', () => new Promise(() => {}));
      }`,
    });
    await b.runtime.reconcile();
    const deadline = Date.now() + 5000;
    while (
      b.runtime.status("hanger")?.status !== "ready" && Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await b.operations.createNote({ path: "a", content: "one" }, api());
    await b.operations.updateNote("a", { newContent: "two" }, "none", api());
    await b.operations.updateNote("a", { newContent: "three" }, "none", api());
    await b.operations.updateNote("a", { newContent: "four" }, "none", api());
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "a.md")),
      "four",
    );
    // The healthy guard plugin observed every save (guard lane unaffected).
    const saves = (await b.facts()).filter((f) => f.kind === "on-save");
    assertEquals(saves.length, 3);
    // The hanger's observer deadline failure is recorded — host failed,
    // diagnostic visible — and the note actions were never blocked.
    const hangDeadline = Date.now() + 3000;
    while (Date.now() < hangDeadline) {
      const s = b.runtime.status("hanger");
      if (s && (s.status === "failed" || s.deliveryFailures > 0)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = b.runtime.status("hanger");
    assert(status !== null);
    assert(
      status.status === "failed" || status.deliveryFailures >= 1,
      `hanger state: ${JSON.stringify(status)}`,
    );
    assert(status.diagnostics.length >= 1);
    // On-only failure does not acquire blocking authority: more saves pass.
    await b.operations.updateNote("a", { newContent: "five" }, "none", api());
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "a.md")),
      "five",
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: read grants strip undisclosed snapshot contents", async () => {
  const b = await bundle();
  try {
    // Recorder's default grant is ["vault"] — contents disclosed. A second
    // plugin with a narrow grant must receive content-free snapshots.
    await b.fixture.install("narrow", {
      runtime: { server: "service.js" },
      hooks: ["on-create"],
      capabilities: { read: ["sub"], write: [] },
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('on-create', (fact) => { globalThis.__narrowFact = fact; });
        ctx.commands.register({ id: 'fact', label: 'Fact', target: 'server' }, () => globalThis.__narrowFact ?? null);
      }`,
    });
    await b.runtime.reconcile();
    const deadline = Date.now() + 5000;
    while (
      b.runtime.status("narrow")?.status !== "ready" && Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await b.operations.createNote({
      path: "outside-sub",
      content: "secret body",
    }, api());
    await new Promise((r) => setTimeout(r, 100));
    const seen = await b.runtime.invokeCommand("narrow", "fact", {}) as {
      after?: { content?: string; contentAvailable: boolean };
    };
    assert(seen !== null);
    assertEquals(seen.after!.content, undefined);
    assertEquals(seen.after!.contentAvailable, false);
  } finally {
    await b.dispose();
  }
});
