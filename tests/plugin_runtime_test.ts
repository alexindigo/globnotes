// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { PluginHost } from "../server/plugins/host.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import {
  PluginGuardError,
  PluginRuntime,
  type RuntimeSource,
} from "../server/plugins/runtime.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

/** DIAG_R09_FINAL_CAS is test-only; restore the exact Deno.stat function in
 * finally. Observe original authority check → async CAS → actual worker
 * deadline/crash → final bytes, rather than a not-yet-existing helper. */
Deno.test("review repairs: R09 private data cannot commit after real worker retirement at final persistence", async () => {
  const fixture = await pluginFixture();
  const target = `${fixture.statePath}/plugin-data/final-authority/data.json`;
  const originalStat = Deno.stat;
  const hold = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const effectSettled = Promise.withResolvers<void>();
  const sources: RuntimeSource[] = [];
  let finalPass = false;
  let effect: Promise<unknown> | undefined;
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: (callback) => {
      finalPass = true;
      const pending = callback();
      effect = pending;
      pending.then(() => {
        finalPass = false;
        effectSettled.resolve();
      }, () => {
        finalPass = false;
        effectSettled.resolve();
      });
      return pending;
    },
  }, { serviceCallMs: 100, disposalMs: 20 });
  let writing: Promise<unknown> | undefined;
  try {
    const store = new PluginDataStore(fixture.statePath, {
      commit: (callback) => callback(),
    }).forPlugin("final-authority");
    await store.save({ preserved: "private original" }, 0);
    const before = await Deno.readTextFile(target);
    const dir = await fixture.install("final-authority", {
      runtime: { server: "service.js" },
    }, {
      "service.js": `export function activate(ctx) {
        ctx.commands.register({id:'write',label:'Write',target:'server'},()=>ctx.data.save({preserved:'must not persist after retirement'},1));
        ctx.commands.register({id:'crash',label:'Crash',target:'server'},()=>{setTimeout(()=>{throw Error('owned R09 retirement');},0);return new Promise(()=>{});});
      }`,
    });
    const manifest = readManifest(dir);
    sources.push({ id: manifest.id, enabled: true, manifest, hooks: [] });
    await runtime.reconcile();
    const readyUntil = Date.now() + 3000;
    while (
      runtime.status(manifest.id)?.status === "starting" &&
      Date.now() < readyUntil
    ) await new Promise((resolve) => setTimeout(resolve, 2));
    assertEquals(runtime.status(manifest.id)?.status, "ready");
    Deno.stat = ((input: string | URL) => {
      const current = originalStat(input);
      if (finalPass && String(input) === target) {
        reached.resolve();
        return hold.promise.then(() => current);
      }
      return current;
    }) as typeof Deno.stat;
    writing = runtime.invokeCommand(manifest.id, "write", {}).catch((error) =>
      error
    );
    const boundary = await Promise.race([
      reached.promise.then(() => "async-final-cas" as const),
      writing.then(() => "settled-before-retirement" as const),
    ]);
    if (boundary === "async-final-cas") {
      const expired = await writing;
      assert(expired instanceof Error);
      assertEquals(runtime.status(manifest.id)?.status, "failed");
      assertEquals(Deno.readTextFileSync(target), before);
      hold.resolve();
      await effectSettled.promise;
      if (effect) await effect.catch(() => undefined);
      console.log(
        JSON.stringify({
          boundary,
          retiredByActualDeadline: true,
          beforeRevision: 1,
          finalRecord: JSON.parse(Deno.readTextFileSync(target)),
          fixture: fixture.root,
        }),
      );
      assertEquals(Deno.readTextFileSync(target), before);
    } else {
      // A synchronous final primitive may legitimately finish before there
      // is any retirement window; do not relabel that committed effect.
      const result = await writing;
      assert(!(result instanceof Error));
      assertEquals((await store.load()).revision, 2);
      assertEquals(
        (await store.load()).values.preserved,
        "must not persist after retirement",
      );
      await runtime.invokeCommand(manifest.id, "crash", {}).catch(() =>
        undefined
      );
      assertEquals(runtime.status(manifest.id)?.status, "failed");
      assertEquals((await store.load()).revision, 2);
      console.log(
        JSON.stringify({
          boundary,
          committedBeforeActualCrash: true,
          finalRevision: 2,
          fixture: fixture.root,
        }),
      );
    }
    assertEquals(
      [...Deno.readDirSync(`${fixture.statePath}/plugin-data/final-authority`)]
        .map((entry) => entry.name),
      ["data.json"],
    );
  } finally {
    hold.resolve();
    Deno.stat = originalStat;
    if (writing) await writing;
    if (effect) await effect.catch(() => undefined);
    await runtime.close();
    console.log(JSON.stringify({ retainedR09Fixture: fixture.root }));
  }
});

Deno.test("review repairs: R09 final preparation followed by real deadline or crash retains private bytes revision and cleanup", async (t) => {
  for (const ending of ["deadline", "crash"] as const) {
    await t.step(ending, async () => {
      const fixture = await pluginFixture();
      const prepared = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const sources: RuntimeSource[] = [];
      const runtime = new PluginRuntime(() => sources, {
        vaultPath: fixture.vault,
        statePath: fixture.statePath,
        operational: () => true,
        writable: () => true,
        commit: async (callback) => {
          prepared.resolve();
          await release.promise;
          try {
            return await callback();
          } finally {
            completed.resolve();
          }
        },
      }, { serviceCallMs: 100, disposalMs: 20 });
      let writing: Promise<unknown> | undefined;
      try {
        const owner = new PluginDataStore(fixture.statePath, {
          commit: (callback) => callback(),
        }).forPlugin("prepared-authority");
        await owner.save({ private: "unchanged" }, 0);
        const file =
          `${fixture.statePath}/plugin-data/prepared-authority/data.json`;
        const before = Deno.readTextFileSync(file);
        const dir = await fixture.install("prepared-authority", {
          runtime: { server: "service.js" },
          hooks: ["pre-save"],
        }, {
          "service.js": `export function activate(ctx) {
            ctx.commands.register({id:'write',label:'Write',target:'server'},()=>ctx.data.save({private:'revoked preparation'},1));
            ctx.hooks.on('pre-save',()=>{setTimeout(()=>{throw Error('actual prepared R09 crash');},0);});
          }`,
        });
        const manifest = readManifest(dir);
        sources.push({
          id: manifest.id,
          enabled: true,
          manifest,
          hooks: manifest.hooks,
        });
        await runtime.reconcile();
        const readyUntil = Date.now() + 3000;
        while (
          runtime.status(manifest.id)?.status === "starting" &&
          Date.now() < readyUntil
        ) await new Promise((resolve) => setTimeout(resolve, 2));
        assertEquals(runtime.status(manifest.id)?.status, "ready");
        writing = runtime.invokeCommand(manifest.id, "write", {}).catch((
          error,
        ) => error);
        await prepared.promise;
        if (ending === "crash") {
          await runtime.guard("pre-save", {}).catch(() => undefined);
        }
        assert(await writing instanceof Error);
        assertEquals(runtime.status(manifest.id)?.status, "failed");
        release.resolve();
        await completed.promise;
        // Cleanup follows the rejected commit adapter; observe its eventual
        // real residue removal separately from the private-value read-back.
        const reloaded = await owner.load();
        assertEquals(reloaded.revision, 1);
        assertEquals(reloaded.values, { private: "unchanged" });
        assertEquals(Deno.readTextFileSync(file), before);
        let residue = [
          ...Deno.readDirSync(
            `${fixture.statePath}/plugin-data/prepared-authority`,
          ),
        ].filter((entry) => entry.name.startsWith(".plugin-"));
        const cleanupUntil = Date.now() + 1000;
        while (residue.length && Date.now() < cleanupUntil) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          residue = [
            ...Deno.readDirSync(
              `${fixture.statePath}/plugin-data/prepared-authority`,
            ),
          ].filter((entry) => entry.name.startsWith(".plugin-"));
        }
        assertEquals(residue, []);
        console.log(
          JSON.stringify({
            ending,
            actualRetirementBeforeEffect: true,
            finalRevision: 1,
            exactPrivateBytesRetained: true,
            fixture: fixture.root,
          }),
        );
      } finally {
        release.resolve();
        if (writing) await writing;
        await runtime.close();
        console.log(
          JSON.stringify({ retainedPreparedR09Fixture: fixture.root }),
        );
      }
    });
  }
});

Deno.test("plugin runtime: service activation without rendering, settings consumer, stable generation and unload", async () => {
  const fixture = await pluginFixture();
  const sources: RuntimeSource[] = [];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  });
  try {
    const dir = await fixture.install("service", {
      runtime: { server: "service.js" },
      hooks: ["on-save", "pre-delete"],
      settings: [fixturePage],
    }, {
      "service.js": `export async function activate(ctx) {
        const data = await ctx.data.load();
        await ctx.data.save({ ...data.values, activations: (data.values.activations || 0) + 1, saves: data.values.saves || 0, settingsChanges: data.values.settingsChanges || 0 }, data.revision);
        ctx.settings.subscribe(async () => { const data = await ctx.data.load(); await ctx.data.save({ ...data.values, settingsChanges: data.values.settingsChanges + 1 }, data.revision); });
        ctx.hooks.on('pre-delete', () => ({ cancel: true, reason: 'fixture protection' }));
        ctx.hooks.on('on-save', async () => { const data = await ctx.data.load(); await ctx.data.save({ ...data.values, saves: data.values.saves + 1 }, data.revision); });
        ctx.commands.register({ id: 'inspect', label: 'Inspect', target: 'server' }, async () => ({ data: (await ctx.data.load()).values, settings: (await ctx.settings.read()).values }));
      }`,
    });
    const manifest = readManifest(dir);
    sources.push({
      id: manifest.id,
      enabled: true,
      manifest,
      hooks: manifest.hooks,
    });
    await runtime.reconcile();
    const deadline = Date.now() + 3000;
    while (
      runtime.status("service")?.status === "starting" && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(runtime.status("service")?.status, "ready");
    const generation = runtime.status("service")?.generation;
    assertEquals(runtime.commands().map((command) => command.fullId), [
      "plugin:service:inspect",
    ]);
    const before = await runtime.invokeCommand("service", "inspect", {}) as {
      data: { activations: number; saves: number; settingsChanges: number };
      settings: { preferences: { message: string } };
    };
    assertEquals(before.data.activations, 1);
    assertEquals(before.settings.preferences.message, "fixture");
    runtime.post("on-save", { operationId: "save-1" });
    const after = await runtime.invokeCommand(
      "service",
      "inspect",
      {},
    ) as typeof before;
    assertEquals(
      after.data.saves,
      1,
      "ordered observer result reaches the command consumer",
    );
    const settingsStore = new PluginDataStore(fixture.statePath, {
      commit: (effect) => effect(),
      settingsChanged: (id, page, revision) =>
        runtime.settingsChanged(id, page, revision),
    }).forPlugin("service");
    await settingsStore.savePage(validateSettingsPages([fixturePage])[0], {
      message: "saved through host",
      protect: true,
      limit: 6,
    }, 0);
    const settingsConsumer = await runtime.invokeCommand(
      "service",
      "inspect",
      {},
    ) as typeof before;
    assertEquals(
      settingsConsumer.settings.preferences.message,
      "saved through host",
    );
    assertEquals(settingsConsumer.data.settingsChanges, 1);
    await runtime.reconcile();
    assertEquals(runtime.status("service")?.generation, generation);
    await assertRejects(
      () => runtime.guard("pre-delete", {}),
      PluginGuardError,
      "fixture protection",
    );
    sources[0].enabled = false;
    await runtime.reconcile();
    assertEquals(runtime.commands(), []);
    assertEquals(runtime.status("service")?.status, "disabled");
    await assertRejects(() => runtime.invokeCommand("service", "inspect", {}));
    sources[0].enabled = true;
    await runtime.reconcile();
    while (
      runtime.status("service")?.status === "starting" &&
      Date.now() < deadline + 3000
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    const reopened = await runtime.invokeCommand(
      "service",
      "inspect",
      {},
    ) as typeof before;
    assertEquals(reopened.data.activations, 2);
    assertEquals(reopened.data.saves, 1);
    assertEquals(reopened.settings.preferences.message, "saved through host");
    assert(runtime.status("service")?.generation !== generation);
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: unknown post-side-effect timeout is not replayed during recovery", async () => {
  const fixture = await pluginFixture();
  const sources: RuntimeSource[] = [];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  }, { serviceCallMs: 80 });
  try {
    const dir = await fixture.install("uncertain", {
      runtime: { server: "service.js" },
    }, {
      "service.js": `export function activate(ctx) {
      ctx.commands.register({ id: 'partial', label: 'Partial', target: 'server' }, async () => { const data = await ctx.data.load(); await ctx.data.save({ n: (data.values.n || 0) + 1 }, data.revision); await new Promise(() => {}); });
      ctx.commands.register({ id: 'inspect', label: 'Inspect', target: 'server' }, async () => (await ctx.data.load()).values);
    }`,
    });
    const manifest = readManifest(dir);
    sources.push({ id: manifest.id, enabled: true, manifest, hooks: [] });
    await runtime.reconcile();
    const deadline = Date.now() + 3000;
    while (
      runtime.status("uncertain")?.status === "starting" &&
      Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    const generation = runtime.status("uncertain")?.generation;
    await assertRejects(
      () => runtime.invokeCommand("uncertain", "partial", {}),
      Error,
      "unknown",
    );
    assertEquals(runtime.status("uncertain")?.status, "failed");
    await runtime.reconcile();
    while (
      runtime.status("uncertain")?.status === "starting" &&
      Date.now() < deadline + 3000
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(await runtime.invokeCommand("uncertain", "inspect", {}), {
      n: 1,
    });
    assert(runtime.status("uncertain")?.generation !== generation);
    assertEquals(runtime.commands().length, 2);
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: legacy initial and later sync reach every retained replica", async () => {
  const fixture = await pluginFixture();
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    2,
    fixture.statePath,
    { internalRoot: `${fixture.root}/internal` },
  );
  try {
    await fixture.install("replicas", {}, {
      "main.js":
        `let syncs = 0; const id = crypto.randomUUID(); export function getSelectors() { return [{ node: 'fence' }]; } export function parseNode() { return { id, syncs }; } export function onSync() { syncs++; }`,
    });
    await manager.start();
    const host = manager.hosts.get("replicas")!;
    const generation = host.generation;
    const before = await Promise.all([
      host.call("parseNode", [{}]),
      host.call("parseNode", [{}]),
    ]) as { id: string; syncs: number }[];
    assertEquals(before.map((value) => value.syncs), [1, 1]);
    assertEquals(new Set(before.map((value) => value.id)).size, 2);
    await manager.syncAll();
    const after = await Promise.all([
      host.call("parseNode", [{}]),
      host.call("parseNode", [{}]),
    ]) as typeof before;
    assertEquals(
      new Set(after.map((value) => value.id)),
      new Set(before.map((value) => value.id)),
    );
    assertEquals(after.map((value) => value.syncs), [2, 2]);
    assertEquals(host.generation, generation);
    await host.respawnAll();
    const replacement = await host.call("parseNode", [
      {},
    ]) as typeof before[number];
    assertEquals(replacement.syncs, 1);
    assert(!before.some((value) => value.id === replacement.id));
  } finally {
    manager.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: service sync is delivered once without a rendering pool", async () => {
  const fixture = await pluginFixture();
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    2,
    fixture.statePath,
    { internalRoot: `${fixture.root}/internal` },
  );
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  });
  try {
    await fixture.install("service-sync", {
      runtime: { server: "service.js" },
      hooks: ["on-sync"],
    }, {
      "service.js": `export function activate(ctx) {
        let syncs = 0;
        ctx.hooks.on('on-sync', () => { syncs++; });
        ctx.commands.register({ id: 'inspect', label: 'Inspect', target: 'server' }, () => syncs);
      }`,
    });
    await runtime.reconcile();
    const deadline = Date.now() + 3000;
    while (
      runtime.status("service-sync")?.status === "starting" &&
      Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(manager.hosts.size, 0);
    await manager.syncAll({
      operationId: "sync-test",
      action: "sync",
      origin: "external",
      timestamp: new Date().toISOString(),
      initial: true,
    });
    assertEquals(await runtime.invokeCommand("service-sync", "inspect", {}), 1);
  } finally {
    await runtime.close();
    manager.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: bounded FIFO queue and guard lane that never waits behind it", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("queue", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
    }, {
      "service.js": `let guards = 0; export function activate(ctx) {
      ctx.commands.register({ id: 'hold', label: 'Hold', target: 'server' }, async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return guards; });
      ctx.hooks.on('pre-save', () => { guards++; });
    }`,
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      () => Promise.resolve(null),
      1,
      { role: "service", limits: { queuedJobs: 1, preHookMs: 10 } },
    );
    try {
      await host.start();
      const command = [...host.registrations].find(([, r]) =>
        r.kind === "command"
      )![0];
      const guard = [...host.registrations].find(([, r]) =>
        r.kind === "hook"
      )![0];
      const active = host.invoke(command, []);
      // Guard lane (phase 3): pre-hook invocations dispatch immediately
      // even while a command occupies the FIFO lane — observers/commands
      // can never make protection wait behind them.
      const guarded = host.invoke(guard, [{}], true);
      // One queued non-pre job fills the bounded queue (queuedJobs: 1);
      // the next admission is rejected — not silently accepted.
      const queued = host.invoke(command, []);
      await assertRejects(
        () => host.invoke(command, []),
        Error,
        "queue is full",
      );
      assertEquals(await guarded, undefined, "guard ran without queueing");
      await active; // may observe the increment — the lanes are concurrent
      assertEquals(await queued, 1);
      // The guard incremented exactly once — no duplicate fired later.
      assertEquals(await host.invoke(command, []), 1);
      assertEquals(host.available, true);
    } finally {
      host.stop();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: late private-data commit is rejected after owner revocation", async () => {
  const fixture = await pluginFixture();
  let release!: () => void;
  let admitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const sources: RuntimeSource[] = [];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: async (effect) => {
      admitted();
      await gate;
      return await effect();
    },
  }, { disposalMs: 30 });
  try {
    const store = new PluginDataStore(fixture.statePath, {
      commit: (effect) => effect(),
    }).forPlugin("revoked");
    await store.save({ n: 0 }, 0);
    const dir = await fixture.install("revoked", {
      runtime: { server: "service.js" },
    }, {
      "service.js":
        `export function activate(ctx) { ctx.commands.register({ id: 'write', label: 'Write', target: 'server' }, () => ctx.data.save({ n: 1 }, 1)); }`,
    });
    const manifest = readManifest(dir);
    sources.push({ id: manifest.id, enabled: true, manifest, hooks: [] });
    await runtime.reconcile();
    const deadline = Date.now() + 3000;
    while (
      runtime.status("revoked")?.status === "starting" && Date.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    const writing = runtime.invokeCommand("revoked", "write", {}).catch((
      error,
    ) => error);
    await entered;
    sources[0].enabled = false;
    const disabling = runtime.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await disabling;
    assert(await writing instanceof Error);
    assertEquals((await store.load()).values, { n: 0 });
    assertEquals(runtime.status("revoked")?.status, "disabled");
  } finally {
    release();
    await runtime.close();
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: slow on-only activation never acquires guard authority", async () => {
  const fixture = await pluginFixture();
  const sources: RuntimeSource[] = [];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  }, { disposalMs: 30 });
  try {
    const dir = await fixture.install("observer", {
      runtime: { server: "service.js" },
      hooks: ["on-save"],
    }, {
      "service.js":
        `export async function activate(ctx) { await new Promise((resolve) => setTimeout(resolve, 200)); ctx.hooks.on('on-save', () => {}); }`,
    });
    const manifest = readManifest(dir);
    sources.push({
      id: manifest.id,
      enabled: true,
      manifest,
      hooks: manifest.hooks,
    });
    await runtime.reconcile();
    assertEquals(runtime.status("observer")?.status, "starting");
    assertEquals(await runtime.guard("pre-save", {}), []);
    runtime.post("on-save", {}, {
      operationId: "committed-note",
      action: "save",
    });
    assertEquals(runtime.status("observer")?.deliveryFailures, 1);
    assertEquals(
      runtime.status("observer")?.diagnostics.at(-1)?.operationId,
      "committed-note",
    );
    assertEquals(runtime.status("observer")?.status, "starting");
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: endpoint-only worker imports root and dynamic-directory modules", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("endpoints", {}, {
      "endpoints/get.js": "export default () => ({ value: 'root consumer' });",
      "endpoints/#name/get.js":
        "export default (request) => ({ value: request.params.name });",
      "endpoints/tree/#...route/post.js":
        "export default (request) => ({ value: request.params.route });",
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      () => Promise.resolve(null),
      1,
      { role: "service" },
    );
    try {
      await host.start();
      const registrations = [...host.registrations];
      assertEquals(registrations.length, 3);
      const root = registrations.find(([, r]) => r.id === "GET /")![0];
      const nested = registrations.find(([, r]) => r.id === "GET /#name")![0];
      const rest = registrations.find(([, r]) =>
        r.id === "POST /tree/#...route"
      )![0];
      assertEquals(await host.invoke(root, [{}]), { value: "root consumer" });
      assertEquals(
        await host.invoke(nested, [{
          params: { name: "actual decoded parameter" },
        }]),
        { value: "actual decoded parameter" },
      );
      assertEquals(
        await host.invoke(rest, [{ params: { route: "one/two" } }]),
        { value: "one/two" },
      );
    } finally {
      host.stop();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: missing required guard fails activation and remains an expected blocker", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("missing-guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-delete"],
    }, { "service.js": "export function activate() {}" });
    const manifest = readManifest(dir);
    const source: RuntimeSource = {
      id: manifest.id,
      enabled: true,
      manifest,
      hooks: manifest.hooks,
    };
    const runtime = new PluginRuntime(() => [source], {
      vaultPath: fixture.vault,
      statePath: fixture.statePath,
      operational: () => true,
      writable: () => true,
      commit: (effect) => effect(),
    });
    try {
      await runtime.reconcile();
      await assertRejects(
        () => runtime.guard("pre-delete", {}),
        PluginGuardError,
        "unavailable",
      );
      assertEquals(runtime.status(source.id)?.status, "failed");
      await assertRejects(
        () => runtime.guard("pre-delete", {}),
        PluginGuardError,
        "unavailable",
      );
      source.enabled = false;
      await runtime.reconcile();
      assertEquals(await runtime.guard("pre-delete", {}), []);
    } finally {
      await runtime.close();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: async hang has a deadline even while heartbeat remains alive", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("async-hang", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
    }, {
      "service.js":
        "export function activate(ctx) { ctx.hooks.on('pre-save', () => new Promise(() => {})); }",
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      () => Promise.resolve(null),
      1,
      { role: "service", limits: { preHookMs: 25 } },
    );
    try {
      await host.start();
      const handler = [...host.registrations.keys()][0];
      await assertRejects(
        () => host.invoke(handler, [{}], true),
        Error,
        "deadline",
      );
      assertEquals(host.available, false);
    } finally {
      host.stop();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin runtime: disposing any required guard fails the enabled lifetime", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("disposed-guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
    }, {
      "service.js": `export function activate(ctx) {
        const remove = ctx.hooks.on('pre-save', () => {});
        ctx.hooks.on('pre-save', () => {});
        ctx.commands.register({ id: 'remove', label: 'Remove', target: 'server' }, () => remove());
      }`,
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      () => Promise.resolve(null),
      1,
      { role: "service" },
    );
    try {
      await host.start();
      const command = [...host.registrations].find(([, registration]) =>
        registration.kind === "command"
      )![0];
      await assertRejects(
        () =>
          host.invoke(command, []),
        Error,
        "required pre-hook registration disposed",
      );
      assertEquals(host.available, false);
    } finally {
      host.stop();
    }
  } finally {
    await fixture.dispose();
  }
});

async function reviewGuardLaneFixture(queuedJobs = 2) {
  const fixture = await pluginFixture();
  const barriers = new Map<string, {
    reached: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }>();
  const hold = (label: string) => {
    const barrier = {
      reached: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    barriers.set(label, barrier);
    return barrier;
  };
  const dir = await fixture.install("review-guard-lanes", {
    runtime: { server: "service.js" },
    hooks: ["pre-save"],
  }, {
    "service.js": `export function activate(ctx) {
    const normal = [], guards = [];
    ctx.commands.register({ id: 'observe', label: 'Observe', target: 'server' }, async ({label, hold}) => {
      if (hold) await ctx.readFile(label);
      normal.push(label); return {label, normal: [...normal], guards: [...guards]};
    });
    ctx.hooks.on('pre-save', async ({label, hold}) => {
      if (hold) await ctx.readFile(label);
      guards.push(label); return {label, normal: [...normal], guards: [...guards]};
    });
  }`,
  });
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    async (method, args) => {
      assertEquals(method, "readFile");
      const barrier = barriers.get(args[0] as string);
      assert(barrier);
      barrier.reached.resolve();
      await barrier.release.promise;
      return null;
    },
    1,
    {
      role: "service",
      limits: {
        queuedJobs,
        preHookMs: 100,
        serviceCallMs: 2000,
        disposalMs: 20,
      },
    },
  );
  await host.start();
  const ordinary =
    [...host.registrations].find(([, entry]) => entry.kind === "command")![0];
  const guard =
    [...host.registrations].find(([, entry]) => entry.kind === "hook")![0];
  const pending: Promise<unknown>[] = [];
  const invoke = (
    label: string,
    pre = false,
    held = false,
    timeout = pre ? 100 : 2000,
  ) => {
    const result = host.invoke(
      pre ? guard : ordinary,
      [{ label, hold: held }],
      pre,
      timeout,
    ).then(
      (value) => ({
        ok: true as const,
        value: value as { label: string; normal: string[]; guards: string[] },
      }),
      (error) => ({ ok: false as const, detail: String(error) }),
    );
    pending.push(result);
    return result;
  };
  return {
    fixture,
    host,
    hold,
    invoke,
    async close() {
      for (const barrier of barriers.values()) barrier.release.resolve();
      host.stop();
      await Promise.all(pending);
      console.log(
        JSON.stringify({ retainedReviewGuardLaneFixture: fixture.root }),
      );
    },
  };
}

for (const full of [false, true]) {
  Deno.test(`review repairs: R10 later guard runs ahead of ${full ? "full" : "occupied"} ordinary FIFO without reordering it`, async () => {
    const f = await reviewGuardLaneFixture(full ? 2 : 3);
    try {
      const held = f.hold("active-observer"),
        active = f.invoke("active-observer", false, true);
      await held.reached.promise;
      const first = f.invoke("queued-one"), second = f.invoke("queued-two");
      if (full) assertEquals((await f.invoke("ordinary-overflow")).ok, false);
      const guarded = await f.invoke("later-guard", true);
      console.log(
        JSON.stringify({
          full,
          laterGuard: guarded,
          activeObserverStillHeld: true,
        }),
      );
      assert(
        guarded.ok,
        "later guard must not inherit the ordinary queue head or admission fullness",
      );
      assertEquals(guarded.value.normal, []);
      assertEquals(guarded.value.guards, ["later-guard"]);
      held.release.resolve();
      assert((await active).ok);
      const a = await first, b = await second;
      assert(a.ok && b.ok);
      assertEquals(a.value.normal, ["active-observer", "queued-one"]);
      assertEquals(b.value.normal, [
        "active-observer",
        "queued-one",
        "queued-two",
      ]);
      assertEquals(f.host.available, true);
    } finally {
      await f.close();
    }
  });
}

Deno.test("review repairs: R10 one active and one pending guard do not supersede admitted protection", async () => {
  const f = await reviewGuardLaneFixture();
  try {
    const held = f.hold("guard-one"),
      first = f.invoke("guard-one", true, true, 1000);
    await held.reached.promise;
    let firstSettled = false;
    first.then(() => {
      firstSettled = true;
    });
    const second = f.invoke("guard-two", true, false, 1000);
    const overflow = await f.invoke("guard-overflow", true);
    console.log(JSON.stringify({ overflow, firstSettled }));
    assertEquals(overflow.ok, false);
    assertEquals(firstSettled, false);
    held.release.resolve();
    const a = await first, b = await second;
    assert(a.ok && b.ok);
    assertEquals(a.value.guards, ["guard-one"]);
    assertEquals(b.value.guards, ["guard-one", "guard-two"]);
    assertEquals(f.host.available, true);
  } finally {
    await f.close();
  }
});

Deno.test("review repairs: R10 pending guard deadline frees its admission without aborting the active guard", async () => {
  const f = await reviewGuardLaneFixture();
  try {
    const held = f.hold("guard-one"),
      first = f.invoke("guard-one", true, true, 1000);
    await held.reached.promise;
    const expired = await f.invoke("queued-expiry", true, false, 20);
    assertEquals(expired.ok, false);
    if (!expired.ok) assert(expired.detail.includes("queued"));
    const fresh = f.invoke("fresh-after-expiry", true, false, 1000);
    held.release.resolve();
    const a = await first, b = await fresh;
    assert(a.ok && b.ok);
    assertEquals(b.value.guards, ["guard-one", "fresh-after-expiry"]);
    assertEquals(f.host.available, true);
  } finally {
    await f.close();
  }
});

for (const ending of ["stop", "dispose", "deadline"]) {
  Deno.test(`review repairs: R10 ${ending} settles both lanes and every queued job exactly once`, async () => {
    const f = await reviewGuardLaneFixture();
    try {
      const observer = f.hold("observer"), guard = f.hold("guard");
      const ordinaryActive = f.invoke("observer", false, true),
        ordinaryQueued = f.invoke("ordinary-pending");
      await observer.reached.promise;
      const guardActive = f.invoke(
        "guard",
        true,
        true,
        ending === "deadline" ? 100 : 2000,
      );
      assert(
        await Promise.race([
          guard.reached.promise.then(() => true),
          guardActive.then(() => false),
        ]),
        "guard must reach its own lane while the ordinary head is blocked",
      );
      const guardQueued = f.invoke("guard-pending", true, false, 2000);
      let unfinished: number | undefined;
      if (ending === "stop") f.host.stop();
      if (ending === "dispose") {
        unfinished = (await f.host.dispose()).unfinished;
      }
      const results = await Promise.all([
        ordinaryActive,
        ordinaryQueued,
        guardActive,
        guardQueued,
      ]);
      assertEquals(results.map((result) => result.ok), [
        false,
        false,
        false,
        false,
      ]);
      if (ending === "dispose") assertEquals(unfinished, 4);
      assertEquals(f.host.available, false);
      console.log(
        JSON.stringify({
          ending,
          settledJobs: results.length,
          unfinished,
          ready: f.host.available,
        }),
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test("plugin runtime: raw writes denied and all managed disposers run despite deactivate failure", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("cleanup", {
      runtime: { server: "service.js" },
      capabilities: { write: ["vault"], read: ["vault"] },
    }, {
      "service.js": `export function activate(ctx) {
        ctx.register(() => { throw new Error('cleanup-one'); });
        ctx.register(() => { throw new Error('cleanup-two'); });
        ctx.commands.register({ id: 'write', label: 'Write', target: 'server' }, () => { try { Deno.writeTextFileSync(${
        JSON.stringify(`${fixture.vault}/denied.txt`)
      }, 'leak'); return 'leaked'; } catch { return 'denied'; } });
      }
      export function deactivate() { throw new Error('deactivate-failed'); }`,
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      () => Promise.resolve(null),
      1,
      { role: "service" },
    );
    try {
      await host.start();
      const handler = [...host.registrations.keys()][0];
      assertEquals(await host.invoke(handler, []), "denied");
      const result = await host.dispose();
      assertEquals(result.errors, [
        "deactivate-failed",
        "cleanup-two",
        "cleanup-one",
      ]);
      assertEquals(host.registrations.size, 0);
    } finally {
      host.stop();
    }
  } finally {
    await fixture.dispose();
  }
});
