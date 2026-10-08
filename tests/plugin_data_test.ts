// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as path from "@std/path";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { PluginContractError } from "../server/plugins/contracts.ts";
import {
  PluginDataStore,
  PluginPolicyStore,
  policyEnables,
} from "../server/plugins/data.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { AsyncLock, PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { GlobalConfig } from "../server/config.ts";
import { state } from "../server/state.ts";

const settingsPut = (await import(
  new URL(
    "../server/api/endpoints/_/api/plugin-host/%23id/settings/%23page/put.ts",
    import.meta.url,
  ).href
)).default;

const writable = { commit: <T>(effect: () => Promise<T>) => effect() };

/** Real service/render owners and both namespace writers share the host gate. */
async function settingsTransitionFixture(
  {
    authority = "127.0.0.1:8123",
    serviceProbe = "",
    renderProbe = "",
    rpc = (_method: string, _args: unknown[]) => Promise.resolve(null),
  } = {},
) {
  const fixture = await pluginFixture();
  const gate = new AsyncLock();
  const commit = <T>(effect: () => Promise<T>) => gate.run(effect);
  const manager = new PluginManager(fixture.vault, rpc, 1, fixture.statePath, {
    internalRoot: `${fixture.root}/empty-internal`,
    persistence: { commit },
  });
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit,
    rpc: (_manifest, method, args) => rpc(method, args),
  });
  const declaration = (probe: string) =>
    `const settings=await ctx.settings.read();${probe}await ctx.permissions.declare({network:settings.values.preferences.protect?['${authority}']:false,imports:false});`;
  const dir = await fixture.install("transition", {
    runtime: { server: "service.js" },
    hooks: ["pre-save"],
    settings: [fixturePage],
    capabilities: { network: false, imports: false },
  }, {
    "service.js":
      `const instance=crypto.randomUUID();export async function activate(ctx){${
        declaration(serviceProbe)
      }ctx.hooks.on('pre-save',()=>{});ctx.commands.register({id:'state',label:'State',target:'server'},async()=>({instance,settings:await ctx.settings.read(),network:Deno.permissions.querySync({name:'net',host:'${authority}'}).state}));}`,
    "main.js":
      `const instance=crypto.randomUUID();let cached;export function getSelectors(){return[{node:'fence',language:'transition'}]};export async function onSync(ctx){${
        declaration(renderProbe)
      }cached=settings};export function parseNode(){return{instance,settings:cached,network:Deno.permissions.querySync({name:'net',host:'${authority}'}).state}}`,
  });
  await fixture.install("unrelated-transition", {
    runtime: { server: "service.js" },
  }, {
    "service.js":
      "export function activate(ctx){ctx.commands.register({id:'state',label:'State',target:'server'},()=>({instance:'unrelated'}))}",
    "main.js":
      "export function getSelectors(){return[]};export function parseNode(){return'unchanged'}",
  });
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!await predicate()) {
      if (Date.now() > deadline) {
        throw Error(
          `settings transition readiness failed ${
            JSON.stringify(runtime.status("transition"))
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await runtime.reconcile();
  await until(() =>
    runtime.status("transition")?.status === "ready" &&
    runtime.status("unrelated-transition")?.status === "ready"
  );
  await manager.ensureStarted();
  let view = await manager.network.view("transition");
  await manager.network.controls("transition", {
    revision: view.revision,
    signature: view.signature,
    requestSourceKey: view.requestSourceKey,
    requestSourceRevision: view.requestSourceRevision,
    allowNetwork: true,
    approvedNetwork: [{ type: "host", authority }],
    approvedImports: [],
  });
  await until(async () => {
    view = await manager.network.view("transition");
    return view.reload.state === "ready" &&
      runtime.status("transition")?.status === "ready" &&
      !!manager.hosts.get("transition");
  });
  assert(
    manager.hosts.get("transition")!.available,
    "render fixture must complete actual initial synchronization",
  );
  const store = new PluginDataStore(fixture.statePath, {
    commit,
    prepareSettingsCommit: (change) =>
      manager.network.prepareSettingsCommit(change),
    settingsChanged: (id, page, revision) =>
      runtime.settingsChanged(id, page, revision),
  });
  const page = validateSettingsPages([fixturePage])[0];
  return {
    fixture,
    manager,
    runtime,
    store,
    gate,
    dir,
    page,
    until,
    async close() {
      manager.stop();
      await runtime.close();
      console.log(
        JSON.stringify({ retainedSettingsTransitionFixture: fixture.root }),
      );
    },
  };
}

Deno.test("review repairs: R02 R08 committed settings recover only reduced roles without waiting under the gate", async () => {
  const b = await settingsTransitionFixture();
  try {
    const before = b.runtime.status("transition")!.generation;
    const oldRender = b.manager.hosts.get("transition")!;
    const unrelatedService =
      b.runtime.status("unrelated-transition")!.generation;
    const unrelatedRender = b.manager.hosts.get("unrelated-transition")!;
    const saved = await b.store.forPlugin("transition").savePage(b.page, {
      message: "narrowed",
      protect: false,
      limit: 5,
    }, 0);
    assertEquals(saved.revision, 1);
    await b.until(() =>
      b.runtime.status("transition")?.status === "ready" &&
      !!b.manager.hosts.get("transition")?.available
    );
    assert(b.runtime.status("transition")!.generation !== before);
    assert(b.manager.hosts.get("transition") !== oldRender);
    const consumer = await b.runtime.invokeCommand(
      "transition",
      "state",
      {},
    ) as { settings: { revision: number }; network: string };
    const rendered = await b.manager.hosts.get("transition")!.call(
      "parseNode",
      [{}],
    ) as { settings: { revision: number }; network: string };
    assertEquals(consumer.settings.revision, 1);
    assertEquals(rendered.settings.revision, 1);
    assert(consumer.network !== "granted" && rendered.network !== "granted");
    const guards = await b.runtime.guard("pre-save", {
      operationId: "recovered-consumer",
    });
    b.runtime.assertGuardAuthority("pre-save", guards);
    assertEquals(
      b.runtime.status("unrelated-transition")!.generation,
      unrelatedService,
    );
    assertEquals(b.manager.hosts.get("unrelated-transition"), unrelatedRender);
    const ledger = await b.manager.network.store.read("transition");
    assertEquals(ledger.record.source!.settingsRevision, 1);
    assertEquals(ledger.record.approvedNetwork, [{
      type: "host",
      authority: "127.0.0.1:8123",
    }]);
    console.log(
      JSON.stringify({
        narrowedCommand: consumer,
        narrowedRender: rendered,
        requiredGuardCurrent: true,
        unrelatedOwnersRetained: true,
      }),
    );
  } finally {
    await b.close();
  }
});

Deno.test("review repairs: R02 publication failure reports persisted revision, fences old rights and restart synchronizes real settings", async () => {
  const b = await settingsTransitionFixture();
  const originalRename = Deno.renameSync;
  const previousState = {
    config: state.config,
    auth: state.auth,
    lifecycle: state.lifecycle,
    plugins: state.plugins,
    pluginData: state.pluginData,
  };
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_READ_ONLY_SETTINGS",
  ];
  const previousEnv = keys.map((key) => Deno.env.get(key));
  try {
    Deno.env.set("GLOBNOTES_PATH", b.fixture.vault);
    Deno.env.set("GLOBNOTES_INDEX_PATH", b.fixture.statePath);
    Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
    Deno.env.delete("GLOBNOTES_READ_ONLY_SETTINGS");
    state.config = new GlobalConfig();
    state.auth = null;
    state.lifecycle = new PluginLifecycle(state.config);
    state.plugins = b.manager;
    state.pluginData = b.store;
    const oldService = b.runtime.status("transition")!.generation;
    const ledgerFile = `${b.fixture.statePath}/plugin-network/transition.json`;
    const oldLedger = Deno.readTextFileSync(ledgerFile);
    // Fail only the actual ledger effect after the settings rename, once.
    let failedLedger = false;
    Deno.renameSync = (from, to) => {
      if (String(to) === ledgerFile && !failedLedger) {
        failedLedger = true;
        throw Error("owned ledger publication failure");
      }
      originalRename(from, to);
    };
    const raw = new Request(
      "http://fixture/_/api/plugin-host/transition/settings/preferences",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: 0,
          values: {
            message: "persisted despite publication failure",
            protect: false,
            limit: 5,
          },
        }),
      },
    );
    const response = await settingsPut({
      _raw: raw,
      params: { id: "transition", page: "preferences" },
      body: { json: () => raw.json() },
    } as unknown as PathfinderRequest);
    assert(response instanceof Response);
    const body = await response.json();
    const error = { status: response.status, code: body.code };
    assert(body.detail.includes("revision 1 persisted"));
    assertEquals(error.status, 503);
    assertEquals(error.code, "plugin_settings_source_commit_failed");
    assertEquals(
      (await b.store.forPlugin("transition").page(b.page)).revision,
      1,
    );
    assertEquals(Deno.readTextFileSync(ledgerFile), oldLedger);
    assertEquals(b.runtime.status("transition")!.generation, null);
    assertEquals(b.manager.hosts.has("transition"), false);
    assert(oldService);
    assertEquals(failedLedger, true);
    Deno.renameSync = originalRename;
    // A new host at the between-files boundary must retire old intent before spawn.
    const restarted = new PluginManager(
      b.fixture.vault,
      () => Promise.resolve(null),
      1,
      b.fixture.statePath,
      {
        internalRoot: `${b.fixture.root}/empty-internal`,
        persistence: { commit: (effect) => b.gate.run(effect) },
      },
    );
    const runtime = restarted.configureRuntime({
      operational: () => true,
      writable: () => true,
      commit: (effect) => b.gate.run(effect),
    });
    try {
      await runtime.reconcile();
      await b.until(() => runtime.status("transition")?.status === "ready");
      const consumer = await runtime.invokeCommand(
        "transition",
        "state",
        {},
      ) as { settings: { revision: number }; network: string };
      assertEquals(consumer.settings.revision, 1);
      assert(consumer.network !== "granted");
      const fresh = await restarted.network.view("transition");
      assertEquals(fresh.source.settingsRevision, 1);
      assertEquals(fresh.effectiveNetwork, []);
      assertEquals(fresh.approvedNetwork, [{
        type: "host",
        authority: "127.0.0.1:8123",
      }]);
      console.log(
        JSON.stringify({
          persistedFailureCode: error.code,
          oldOwnerDead: true,
          restartConsumer: consumer,
        }),
      );
    } finally {
      restarted.stop();
      await runtime.close();
    }
    assertEquals(
      [...Deno.readDirSync(`${b.fixture.statePath}/plugin-network`)].filter((
        entry,
      ) => entry.name.startsWith(".permission-")).length,
      0,
    );
  } finally {
    Deno.renameSync = originalRename;
    await b.close();
    Object.assign(state, previousState);
    keys.forEach((key, index) => {
      const value = previousEnv[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  }
});

Deno.test("review repairs: R02 settings and permission writers settle without lock inversion and stale settings preserve files", async () => {
  const b = await settingsTransitionFixture();
  try {
    const initial = await b.manager.network.view("transition");
    const owner = b.store.forPlugin("transition");
    const outcomes = await Promise.allSettled([
      owner.savePage(b.page, {
        message: "concurrent",
        protect: false,
        limit: 5,
      }, 0),
      b.manager.network.controls("transition", {
        revision: initial.revision,
        signature: initial.signature,
        requestSourceKey: initial.requestSourceKey,
        requestSourceRevision: initial.requestSourceRevision,
        allowNetwork: false,
        approvedNetwork: initial.approvedNetwork,
        approvedImports: [],
      }),
    ]);
    assert(outcomes.some((outcome) => outcome.status === "fulfilled"));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        assert(outcome.reason instanceof PluginContractError);
      }
    }
    const settled = await owner.page(b.page);
    const file = `${b.fixture.statePath}/plugin-data/transition/settings.json`;
    const before = settled.revision ? await Deno.readTextFile(file) : null;
    await assertRejects(
      () =>
        owner.savePage(b.page, {
          message: "invalid CAS",
          protect: false,
          limit: 5,
        }, settled.revision + 1),
      PluginContractError,
    );
    assertEquals(
      settled.revision ? await Deno.readTextFile(file) : null,
      before,
    );
    console.log(
      JSON.stringify({
        writersSettled: outcomes.map((outcome) => outcome.status),
        actualRevision: settled.revision,
        staleWriterNoEffect: true,
      }),
    );
  } finally {
    await b.close();
  }
});

Deno.test("review repairs: R08 code B appearing during same-code settings recovery is never implicitly activated", async () => {
  const b = await settingsTransitionFixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const policy = b.manager.network.policy.bind(b.manager.network);
  let held = false;
  let saving: Promise<unknown> | undefined;
  try {
    b.manager.network.policy = async (id) => {
      const value = await policy(id);
      if (id === "transition" && value.source.settingsRevision === 1 && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    saving = b.store.forPlugin("transition").savePage(b.page, {
      message: "same-code only",
      protect: false,
      limit: 5,
    }, 0);
    const rejected = assertRejects(
      () => saving!,
      PluginContractError,
      "persisted",
    );
    await entered.promise;
    await Deno.writeTextFile(
      `${b.dir}/service.js`,
      "export function activate(ctx){ctx.commands.register({id:'state',label:'B',target:'server'},()=>({installedCode:'B must require explicit enable'}))}",
    );
    release.resolve();
    const error = await rejected;
    assertEquals(error.status, 503);
    assertEquals(error.code, "plugin_settings_source_commit_failed");
    await b.until(() =>
      b.runtime.status("transition")?.status !== "starting" &&
      b.runtime.status("transition")?.generation === null
    );
    await assertRejects(() =>
      b.runtime.invokeCommand("transition", "state", {})
    );
    assertEquals(b.runtime.status("transition")!.generation, null);
    assertEquals(
      (await b.store.forPlugin("transition").page(b.page)).revision,
      1,
    );
    const view = await b.manager.network.view("transition");
    assertEquals(view.reload.state, "failed");
    assert(
      view.reload.detail?.includes("source-reload-required"),
      error.message,
    );
    console.log(
      JSON.stringify({
        codeBImplicitActivation: false,
        persistedSettingsRevision: 1,
        persistedFailureCode: error.code,
        recoveryFailure: view.reload,
      }),
    );
  } finally {
    release.resolve();
    if (saving) await saving.catch(() => undefined);
    b.manager.network.policy = policy;
    await b.close();
  }
});

Deno.test("review repairs: R02 rejected pre-effect settings preparation cannot poison the next explicit same-source retry", async () => {
  const b = await settingsTransitionFixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const prepare = b.manager.network.prepareSettingsCommit.bind(
    b.manager.network,
  );
  let held = false;
  let saving: Promise<unknown> | undefined;
  try {
    b.manager.network.prepareSettingsCommit = async (change) => {
      const value = await prepare(change);
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    const owner = b.store.forPlugin("transition");
    saving = owner.savePage(b.page, {
      message: "rejected preparation",
      protect: false,
      limit: 5,
    }, 0);
    const rejected = assertRejects(() => saving!, PluginContractError);
    await entered.promise;
    const current = await b.manager.network.view("transition");
    await b.manager.network.controls("transition", {
      revision: current.revision,
      signature: current.signature,
      requestSourceKey: current.requestSourceKey,
      requestSourceRevision: current.requestSourceRevision,
      allowNetwork: false,
      approvedNetwork: current.approvedNetwork,
      approvedImports: [],
    });
    await b.until(async () =>
      (await b.manager.network.view("transition")).reload.state === "ready"
    );
    release.resolve();
    await rejected;
    assertEquals((await owner.page(b.page)).revision, 0);
    // Fresh operator intent uses the same next source but the new actual owners.
    const retry = await owner.savePage(b.page, {
      message: "explicit retry owns fresh preparation",
      protect: false,
      limit: 5,
    }, 0);
    assertEquals(retry.revision, 1);
    assertEquals(
      (await owner.page(b.page)).values.message,
      "explicit retry owns fresh preparation",
    );
    console.log(
      JSON.stringify({
        rejectedSettingsUnwritten: true,
        explicitFreshRetryRevision: retry.revision,
      }),
    );
  } finally {
    release.resolve();
    if (saving) await saving.catch(() => undefined);
    b.manager.network.prepareSettingsCommit = prepare;
    await b.close();
  }
});

Deno.test("review repairs: R08 narrowed service and render recovery cannot borrow an unsettled SDK expansion", async () => {
  let traffic = 0;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      traffic++;
      return new Response("actual expanded receiver");
    },
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const rawProbe =
    `let observed;try{observed=await(await fetch('http://${authority}/recovery')).text()}catch(error){observed=error.name}`;
  const renderResults: string[] = [];
  const b = await settingsTransitionFixture({
    authority,
    serviceProbe:
      `if(settings.revision===1){${rawProbe};const data=await ctx.data.load();await ctx.data.save({observed},data.revision);}`,
    renderProbe:
      `if(settings.revision===1){${rawProbe};await ctx.readNote('recovery-ceiling:'+observed);}`,
    rpc: (method, args) => {
      if (
        method === "readNote" && String(args[0]).startsWith("recovery-ceiling:")
      ) renderResults.push(String(args[0]));
      return Promise.resolve(null);
    },
  });
  const release = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const actual = b.manager.network.rpc.bind(b.manager.network);
  const pendingRoles = new Set<string>();
  const receiptStates: boolean[] = [];
  try {
    b.manager.network.rpc = async (id, method, args, actor) => {
      const result = await actual(id, method, args, actor);
      if (
        id === "transition" && method === "permissions.declare" &&
        actor.source?.settingsRevision === 1 && !pendingRoles.has(actor.role)
      ) {
        pendingRoles.add(actor.role);
        const index = receiptStates.length;
        receiptStates.push(false);
        actor.receipt!.then(() => {
          receiptStates[index] = true;
        });
        if (pendingRoles.size === 2) entered.resolve();
        await release.promise;
      }
      return result;
    };
    // New settings still request the remembered host, but retirement first
    // removes obsolete intent. The committed ACK must not await Worker startup.
    const saved = await b.store.forPlugin("transition").savePage(b.page, {
      message: "fresh expansion must settle",
      protect: true,
      limit: 5,
    }, 0);
    assertEquals(saved.revision, 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error("fresh recovery SDK calls did not reach both roles"),
              ),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const before = await b.store.forPlugin("transition").load();
    assertEquals(before.values.observed, "NotCapable");
    assertEquals(renderResults, ["recovery-ceiling:NotCapable"]);
    assertEquals(traffic, 0);
    assertEquals(receiptStates, [false, false]);
    assertEquals(b.runtime.status("transition")!.delegated!.network, []);
    release.resolve();
    await b.until(async () =>
      (await b.manager.network.view("transition")).reload.state === "ready" &&
      b.runtime.status("transition")?.status === "ready" &&
      !!b.manager.hosts.get("transition")?.available
    );
    const after = await b.store.forPlugin("transition").load();
    assertEquals(after.values.observed, "actual expanded receiver");
    assert(renderResults.includes("recovery-ceiling:actual expanded receiver"));
    assertEquals(traffic, 2);
    const consumer = await b.runtime.invokeCommand(
      "transition",
      "state",
      {},
    ) as { network: string };
    assertEquals(consumer.network, "granted");
    console.log(
      JSON.stringify({
        deniedBeforeSdkReceipt: before.values,
        renderBeforeReceipt: renderResults[0],
        receiptBarrierObserved: true,
        actualExpandedTraffic: traffic,
        consumer,
      }),
    );
  } finally {
    release.resolve();
    b.manager.network.rpc = actual;
    await b.close();
    await receiver.shutdown();
  }
});

Deno.test("review repairs: R08 late recovery A cannot replace explicitly enabled code B or its render and guard", async () => {
  const b = await settingsTransitionFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const policy = b.manager.network.policy.bind(b.manager.network);
  let held = false;
  let saving: Promise<unknown> | undefined;
  try {
    b.manager.network.policy = async (id) => {
      const value = await policy(id);
      if (id === "transition" && value.source.settingsRevision === 1 && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    saving = b.store.forPlugin("transition").savePage(b.page, {
      message: "A persisted, B explicitly enabled",
      protect: false,
      limit: 5,
    }, 0);
    await entered.promise;
    await Deno.writeTextFile(
      `${b.dir}/service.js`,
      "const instance=crypto.randomUUID();export function activate(ctx){ctx.hooks.on('pre-save',()=>{});ctx.commands.register({id:'state',label:'B',target:'server'},async()=>({instance,installedCode:'B',settings:await ctx.settings.read()}))}",
    );
    // The actual explicit policy/source-replacement path admits installed B.
    const { metadata } = await b.manager.policy.read();
    await b.manager.policy.setEnabled("transition", true, metadata);
    await b.manager.reconcileOwners({ replaceId: "transition" });
    await b.until(() => b.runtime.status("transition")?.status === "ready");
    const generation = b.runtime.status("transition")!.generation;
    const render = b.manager.hosts.get("transition")!;
    const before = await b.runtime.invokeCommand("transition", "state", {});
    assertEquals((before as { installedCode: string }).installedCode, "B");
    release.resolve();
    await saving;
    assertEquals(b.runtime.status("transition")!.generation, generation);
    assertEquals(b.manager.hosts.get("transition"), render);
    assertEquals(
      await b.runtime.invokeCommand("transition", "state", {}),
      before,
    );
    const result = await render.call("parseNode", [{}]) as {
      settings: { revision: number };
    };
    assertEquals(result.settings.revision, 1);
    const guards = await b.runtime.guard("pre-save", {
      operationId: "B guard",
    });
    b.runtime.assertGuardAuthority("pre-save", guards);
    console.log(
      JSON.stringify({
        lateASettled: true,
        BConsumer: before,
        BGenerationRetained: generation,
        BRenderRetained: true,
        BGuardCurrent: true,
      }),
    );
  } finally {
    release.resolve();
    if (saving) await saving.catch(() => undefined);
    b.manager.network.policy = policy;
    await b.close();
  }
});

Deno.test("plugin persistence: relocated owner, defaults, CAS and restart read-back", async (t) => {
  const fixture = await pluginFixture();
  try {
    const changes: string[] = [];
    const store = new PluginDataStore(fixture.statePath, {
      ...writable,
      settingsChanged: (id, page, revision) =>
        changes.push(`${id}:${page}:${revision}`),
    });
    const owner = store.forPlugin("alpha");
    const page = validateSettingsPages([fixturePage])[0];
    await t.step("defaults are effective without writing a file", async () => {
      assertEquals((await owner.page(page)).values.message, "fixture");
      assertThrows(() =>
        Deno.statSync(
          path.join(fixture.statePath, "plugin-data", "alpha", "settings.json"),
        )
      );
    });
    await t.step("persisted settings drive the change consumer", async () => {
      const result = await owner.savePage(page, {
        message: "operator",
        protect: false,
        limit: 7,
      }, 0);
      assertEquals(result.revision, 1);
      assertEquals(changes, ["alpha:preferences:1"]);
      assertEquals(
        (await new PluginDataStore(fixture.statePath, writable).forPlugin(
          "alpha",
        ).page(page)).values.message,
        "operator",
      );
      assertEquals([...Deno.readDirSync(fixture.vault)].length, 0);
    });
    await t.step(
      "private data is a distinct revisioned namespace",
      async () => {
        await owner.save({ secret: "private-fixture" }, 0);
        assertEquals((await owner.load()).values, {
          secret: "private-fixture",
        });
        assertEquals((await owner.page(page)).revision, 1);
        assertEquals((await store.forPlugin("beta").load()).values, {});
        assertThrows(() => store.forPlugin("../alpha"));
        assert(
          !JSON.stringify(await owner.settings([page])).includes(
            "private-fixture",
          ),
        );
      },
    );
    await t.step(
      "concurrent writers cannot silently replace an accepted revision",
      async () => {
        const results = await Promise.allSettled([
          owner.save({ n: 1 }, 1),
          owner.save({ n: 2 }, 1),
        ]);
        assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
        assertEquals((await owner.load()).revision, 2);
        await assertRejects(
          () => owner.save({ n: 3 }, 1),
          PluginContractError,
          "changed",
        );
      },
    );
    await t.step("separate process sees persisted values", async () => {
      const script = path.join(fixture.root, "restart.ts");
      const module = new URL("../server/plugins/data.ts", import.meta.url).href;
      await Deno.writeTextFile(
        script,
        `import { PluginDataStore } from ${
          JSON.stringify(module)
        }; const store = new PluginDataStore(${
          JSON.stringify(fixture.statePath)
        }, {commit: (effect) => effect()}); console.log(JSON.stringify(await store.forPlugin("alpha").load()));`,
      );
      const child = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          `--config=${new URL("../deno.json", import.meta.url).pathname}`,
          "--allow-read",
          "--allow-write",
          script,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(child.code, 0, new TextDecoder().decode(child.stderr));
      assertEquals(JSON.parse(new TextDecoder().decode(child.stdout)).values, {
        n: 1,
      });
    });
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin persistence: corruption, schema mismatch, symlinks and denied commit preserve values", async (t) => {
  const fixture = await pluginFixture();
  try {
    const store = new PluginDataStore(fixture.statePath, writable);
    const owner = store.forPlugin("alpha");
    const dir = path.join(fixture.statePath, "plugin-data", "alpha");
    await owner.save({ n: 1 }, 0);
    const dataFile = path.join(dir, "data.json");
    await t.step(
      "corrupt state never falls back to empty and overwrites",
      async () => {
        await Deno.writeTextFile(dataFile, "{broken");
        await assertRejects(
          () => owner.load(),
          PluginContractError,
          "malformed",
        );
        await assertRejects(
          () => owner.save({}, 0),
          PluginContractError,
          "malformed",
        );
        assertEquals(await Deno.readTextFile(dataFile), "{broken");
      },
    );
    await t.step("unsupported schema remains untouched", async () => {
      const raw = JSON.stringify({
        schemaVersion: 999,
        revision: 1,
        values: { n: 1 },
      });
      await Deno.writeTextFile(dataFile, raw);
      await assertRejects(
        () => owner.save({}, 1),
        PluginContractError,
        "unsupported",
      );
      assertEquals(await Deno.readTextFile(dataFile), raw);
    });
    await t.step(
      "settings schema mismatch is visible rather than coerced",
      async () => {
        const page = validateSettingsPages([fixturePage])[0];
        await Deno.writeTextFile(
          path.join(dir, "settings.json"),
          JSON.stringify({
            schemaVersion: 1,
            revision: 2,
            values: { preferences: { limit: "seven" } },
          }),
        );
        await assertRejects(
          () => owner.page(page),
          PluginContractError,
          "finite number",
        );
      },
    );
    await t.step(
      "another owner cannot be selected through a symlink",
      async () => {
        await Deno.symlink(
          dir,
          path.join(fixture.statePath, "plugin-data", "beta"),
        );
        await assertRejects(
          () => store.forPlugin("beta").load(),
          PluginContractError,
          "symlinks",
        );
      },
    );
    await t.step("policy gate can reject final replacement", async () => {
      const raw = JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        values: { n: 4 },
      });
      await Deno.writeTextFile(dataFile, raw);
      const denied = new PluginDataStore(fixture.statePath, {
        commit: () => Promise.reject(new Error("epoch revoked")),
      });
      await assertRejects(
        () => denied.forPlugin("alpha").save({ n: 5 }, 4),
        Error,
        "epoch revoked",
      );
      assertEquals(await Deno.readTextFile(dataFile), raw);
      assertEquals(
        [...Deno.readDirSync(dir)].filter((entry) =>
          entry.name.startsWith(".plugin-")
        ).length,
        0,
      );
    });
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin policy: opt-ins, auto-enable materialization, CAS, operator edits and pinned source", async (t) => {
  const fixture = await pluginFixture();
  try {
    const store = new PluginPolicyStore(fixture.statePath, writable, {
      autoEnable: true,
    });
    const file = path.join(fixture.statePath, "plugins.json");
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        order: ["beta", "alpha"],
        disabled: ["beta"],
        operator: { preserve: true },
      }),
    );
    await t.step(
      "changing discovery default preserves current choices and unrelated fields",
      async () => {
        const before = await store.read();
        const result = await store.setAutoEnable(
          false,
          ["alpha", "beta"],
          before.metadata,
        );
        assertEquals(result.policy.operator, { preserve: true });
        assertEquals(result.policy.order, ["beta", "alpha"]);
        assertEquals(
          policyEnables(
            result.policy,
            "alpha",
            result.metadata.effectiveAutoEnable,
          ),
          true,
        );
        assertEquals(
          policyEnables(
            result.policy,
            "beta",
            result.metadata.effectiveAutoEnable,
          ),
          false,
        );
        assertEquals(
          policyEnables(
            result.policy,
            "new",
            result.metadata.effectiveAutoEnable,
          ),
          false,
        );
        await assertRejects(
          () => store.setEnabled("beta", true, before.metadata),
          PluginContractError,
          "changed",
        );
      },
    );
    await t.step(
      "explicit enable works when automatic enable is off",
      async () => {
        const result = await store.setEnabled(
          "new",
          true,
          (await store.read()).metadata,
        );
        assertEquals(policyEnables(result.policy, "new", false), true);
        assert(!result.policy.disabled?.includes("new"));
      },
    );
    await t.step(
      "manual edit with the same stored revision rejects stale browser signature",
      async () => {
        const before = await store.read();
        await Deno.writeTextFile(
          file,
          JSON.stringify({
            ...before.policy,
            operator: { preserve: "changed outside" },
          }),
        );
        const edited = await Deno.readTextFile(file);
        await assertRejects(
          () => store.setEnabled("alpha", false, before.metadata),
          PluginContractError,
          "changed",
        );
        assertEquals(await Deno.readTextFile(file), edited);
      },
    );
    await t.step(
      "explicit environment pin wins and cannot be saved over",
      async () => {
        const pinned = new PluginPolicyStore(fixture.statePath, writable, {
          autoEnable: false,
          environment: true,
        });
        const before = await pinned.read();
        assertEquals(before.metadata.autoEnableSource, "environment");
        assertEquals(before.metadata.effectiveAutoEnable, true);
        await assertRejects(
          () => pinned.setAutoEnable(false, [], before.metadata),
          PluginContractError,
          "pinned",
        );
        assertEquals(
          (await pinned.read()).metadata.signature,
          before.metadata.signature,
        );
      },
    );
    await t.step(
      "corrupt policy is preserved and not replaced by discovery defaults",
      async () => {
        await Deno.writeTextFile(file, "{bad policy");
        await assertRejects(
          () => store.read(),
          PluginContractError,
          "malformed",
        );
        assertThrows(() => store.selection(), PluginContractError, "malformed");
        assertEquals(await Deno.readTextFile(file), "{bad policy");
      },
    );
  } finally {
    await fixture.dispose();
  }
});
