// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { PluginManager } from "../server/plugins/manager.ts";
import { PluginHost, type RpcAuthority } from "../server/plugins/host.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { fixturePage } from "./helpers/plugin_fixture.ts";
import { renderMarkdown } from "../server/render/pipeline.ts";
import { state } from "../server/state.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { GlobalConfig } from "../server/config.ts";

const enabledUrl = new URL(
  "../server/api/endpoints/_/api/plugin-host/%23id/enabled/put.ts",
  import.meta.url,
);
const enabledPut = (await import(enabledUrl.href)).default;
const renderCode = (label: string, language = "probe") => `
  const nonce = crypto.randomUUID();
  export function getSelectors() { return [{ node: 'fence', language: '${language}' }]; }
  export function parseNode(node) {
    if (node.identity) return { label: '${label}', nonce };
    return { parts: ['<b>${label}</b>'] };
  }
`;
const serviceCode = (label: string) => `
  const nonce = crypto.randomUUID();
  export function activate(ctx) {
    ctx.commands.register({ id: 'identity', label: 'Identity', target: 'server' }, () => ({ label: '${label}', nonce }));
  }
`;
async function fixtureBundle(
  rpc: (
    method: string,
    args: unknown[],
    authority?: RpcAuthority,
  ) => Promise<unknown> = () => Promise.resolve(null),
  retain = false,
) {
  const fixture = await pluginFixture();
  const previousState = {
    config: state.config,
    auth: state.auth,
    plugins: state.plugins,
    lifecycle: state.lifecycle,
  };
  const keys = [
    "GLOBNOTES_PATH",
    "GLOBNOTES_INDEX_PATH",
    "GLOBNOTES_AUTH_TYPE",
    "GLOBNOTES_READ_ONLY_SETTINGS",
  ];
  const previousEnv = keys.map((key) => Deno.env.get(key));
  Deno.env.set("GLOBNOTES_PATH", fixture.vault);
  Deno.env.set("GLOBNOTES_INDEX_PATH", fixture.statePath);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  Deno.env.delete("GLOBNOTES_READ_ONLY_SETTINGS");
  state.config = new GlobalConfig();
  state.auth = null;
  const manager = new PluginManager(fixture.vault, rpc, 2, fixture.statePath, {
    internalRoot: `${fixture.root}/empty-internal`,
    autoEnable: true,
    persistence: { commit: (effect) => effect() },
  });
  state.plugins = manager;
  state.lifecycle = null;
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
    rpc: (_manifest, method, args, authority) => rpc(method, args, authority),
  });
  const enable = async (id: string, enabled: boolean) => {
    const { metadata } = await manager.policy.read();
    const result = await enabledPut(
      {
        _raw: new Request(`http://fixture/_/api/plugin-host/${id}/enabled`, {
          method: "PUT",
        }),
        params: { id },
        body: { json: () => Promise.resolve({ ...metadata, enabled }) },
      } as unknown as PathfinderRequest,
    );
    if (result instanceof Response) {
      throw new Error(
        `enablement rejected: ${result.status} ${await result.text()}`,
      );
    }
    return result;
  };
  const render = (language = "probe") =>
    renderMarkdown(`\`\`\`${language}\nconsumer\n\`\`\`\n`);
  return {
    fixture,
    manager,
    runtime,
    enable,
    render,
    async close() {
      manager.stop();
      await runtime.close();
      if (retain) {
        console.log(
          JSON.stringify({ retainedRenderLifecycleFixture: fixture.root }),
        );
      } else await fixture.dispose();
      Object.assign(state, previousState);
      keys.forEach((key, index) => {
        const value = previousEnv[index];
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      });
    },
  };
}
async function ready(
  runtime: ReturnType<PluginManager["configureRuntime"]>,
  id: string,
) {
  const deadline = Date.now() + 3000;
  while (runtime.status(id)?.status !== "ready") {
    if (runtime.status(id)?.status === "failed" || Date.now() >= deadline) {
      throw new Error(
        `service ${id} did not become ready: ${
          JSON.stringify(runtime.status(id))
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function reviewRenderBarrier(
  barrier: Promise<void>,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`render fixture barrier not reached: ${label}`)),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("review repairs: R22 failed demanded render construction cannot be reported permission reload ready", async () => {
  const b = await fixtureBundle(() => Promise.resolve(null), true);
  const NativeWorker = globalThis.Worker;
  let attempts = 0;
  try {
    await b.fixture.install("probe", {
      capabilities: { network: ["127.0.0.1:8123"], imports: false },
    }, { "main.js": renderCode("READY-BEFORE-FAULT") });
    await b.fixture.install("unrelated", {}, {
      "main.js": renderCode("UNRELATED", "other"),
    });
    await b.runtime.reconcile();
    await b.render();
    const unrelated = b.manager.hosts.get("unrelated")!;
    const generations = [...unrelated.generations];
    assert(
      Deno.permissions.querySync({ name: "sys", kind: "hostname" }).state !==
        "granted",
    );
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        attempts++;
        const options = args[1] as WorkerOptions & {
          deno: { permissions: Deno.PermissionOptions };
        };
        const permissions = typeof options.deno.permissions === "object"
          ? options.deno.permissions
          : {};
        return Reflect.construct(target, [args[0], {
          ...options,
          deno: { permissions: { ...permissions, sys: ["hostname"] } },
        }], newTarget);
      },
    });
    const before = await b.manager.network.view("probe");
    await b.manager.network.controls("probe", {
      revision: before.revision,
      signature: before.signature,
      requestSourceKey: before.requestSourceKey,
      requestSourceRevision: before.requestSourceRevision,
      allowNetwork: true,
      approvedNetwork: [{ type: "host", authority: "127.0.0.1:8123" }],
      approvedImports: [],
    });
    let current = await b.manager.network.view("probe");
    const deadline = Date.now() + 3000;
    while (
      ["scheduled", "reloading"].includes(current.reload.state) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = await b.manager.network.view("probe");
    }
    const failed = (await b.manager.catalog()).plugins.find((plugin) =>
      plugin.id === "probe"
    )!;
    console.log(JSON.stringify({
      actualConstructorAttempts: attempts,
      permissionReload: current.reload,
      actualRenderStatus: failed.status,
      selectableOwnerCount: b.manager.readyRenderOwners().filter((owner) =>
        owner.pluginId === "probe"
      ).length,
    }));
    assert(attempts > 0);
    assertEquals(failed.status, "failed");
    assertEquals(current.reload.state, "failed");
    assertEquals(
      b.manager.readyRenderOwners().some((owner) => owner.pluginId === "probe"),
      false,
    );
    assertEquals(b.manager.hosts.get("unrelated"), unrelated);
    assertEquals(unrelated.generations, generations);
    assertEquals(await b.render("other"), "<b>UNRELATED</b>");
  } finally {
    globalThis.Worker = NativeWorker;
    await b.close();
  }
});

Deno.test("review repairs: R03 held same-code recovery binds fresh settings source and retains the healthy replica", async () => {
  const crashEntered = Promise.withResolvers<void>(),
    crashRelease = Promise.withResolvers<void>();
  const recoveryEntered = Promise.withResolvers<void>(),
    recoveryRelease = Promise.withResolvers<void>();
  let crashedGeneration = "";
  const b = await fixtureBundle(async (method, args, actor) => {
    if (method === "readNote" && args[0] === "crash-after-barrier") {
      crashedGeneration = actor!.generation;
      crashEntered.resolve();
      await crashRelease.promise;
    }
    return null;
  }, true);
  const policy = b.manager.network.policy.bind(b.manager.network);
  let held = false;
  let failing: Promise<unknown> | undefined;
  try {
    await b.fixture.install("probe", {
      settings: [fixturePage],
      capabilities: { network: false, imports: false },
    }, {
      "main.js":
        `const nonce=crypto.randomUUID();let initial;export function getSelectors(){return[{node:'fence',language:'probe'}]};export async function onSync(ctx){const view=await ctx.permissions.status();const settings=await ctx.settings.read();if(view.source.settingsRevision!==settings.revision)throw Error('source/settings mismatch');await ctx.permissions.declare({network:false,imports:false});initial={nonce,sourceRevision:view.source.settingsRevision,settingsRevision:settings.revision,message:settings.values.preferences.message}}export async function parseNode(node,ctx){if(node.crash){await ctx.readNote('crash-after-barrier');setTimeout(()=>{throw Error('owned same-code recovery crash')},0);return new Promise(()=>{})}return initial}`,
    });
    await b.fixture.install("unrelated", {}, {
      "main.js": renderCode("UNRELATED", "other"),
    });
    await b.manager.ensureStarted();
    const host = b.manager.hosts.get("probe")!,
      unrelated = b.manager.hosts.get("unrelated")!;
    const beforeGenerations = [...host.generations];
    const before = await Promise.all([
      host.call("parseNode", [{}]),
      host.call("parseNode", [{}]),
    ]) as { nonce: string }[];
    failing = host.call("parseNode", [{ crash: true }]).catch((error) => error);
    await reviewRenderBarrier(crashEntered.promise, "fresh-source crash");
    const data = new PluginDataStore(b.fixture.statePath, {
      commit: (effect) => effect(),
    }).forPlugin("probe");
    await data.savePage(
      {
        ...fixturePage,
        renderer: { kind: "declarative-v1", version: 1 },
        fields: fixturePage
          .fields as import("../server/plugins/contracts.ts").SettingsField[],
      },
      { message: "fresh recovered source", protect: false, limit: 5 },
      0,
    );
    b.manager.network.policy = async (id) => {
      const value = await policy(id);
      if (id === "probe" && value.source.settingsRevision === 1 && !held) {
        held = true;
        recoveryEntered.resolve();
        await recoveryRelease.promise;
      }
      return value;
    };
    crashRelease.resolve();
    assert(await failing instanceof Error);
    await reviewRenderBarrier(
      recoveryEntered.promise,
      "fresh-source recovery admission",
    );
    assertEquals(host.available, false);
    assertEquals(
      b.manager.readyRenderOwners().some((owner) => owner.pluginId === "probe"),
      false,
    );
    await assertRejects(
      () => host.call("parseNode", [{}]),
      Error,
      "recovery pending",
    );
    recoveryRelease.resolve();
    const deadline = Date.now() + 3000;
    while (!host.available && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(host.available);
    assertEquals(b.manager.hosts.get("probe"), host);
    assertEquals(
      host.generations.filter((generation) =>
        beforeGenerations.includes(generation)
      ),
      beforeGenerations.filter((generation) =>
        generation !== crashedGeneration
      ),
    );
    const after = await Promise.all([
      host.call("parseNode", [{}]),
      host.call("parseNode", [{}]),
    ]) as {
      nonce: string;
      sourceRevision: number;
      settingsRevision: number;
      message: string;
    }[];
    const recovered = after.find((value) =>
      !before.some((old) => old.nonce === value.nonce)
    )!;
    assert(recovered);
    assertEquals(recovered.sourceRevision, 1);
    assertEquals(recovered.settingsRevision, 1);
    assertEquals(recovered.message, "fresh recovered source");
    assertEquals(b.manager.hosts.get("unrelated"), unrelated);
    assertEquals(await b.render("other"), "<b>UNRELATED</b>");
    console.log(
      JSON.stringify({
        crashedGeneration,
        beforeGenerations,
        afterGenerations: host.generations,
        recovered,
        healthyReplicaRetained: true,
        pendingWorkRejected: true,
      }),
    );
  } finally {
    crashRelease.resolve();
    recoveryRelease.resolve();
    if (failing) await failing.catch(() => undefined);
    b.manager.network.policy = policy;
    await b.close();
  }
});

Deno.test("review repairs: R03 late failed-pool admission cannot construct over explicitly enabled B", async () => {
  const crashEntered = Promise.withResolvers<void>(),
    crashRelease = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const b = await fixtureBundle(async (method, args) => {
    if (method === "readNote" && args[0] === "crash-barrier") {
      crashEntered.resolve();
      await crashRelease.promise;
    }
    return null;
  }, true);
  const policy = b.manager.network.policy.bind(b.manager.network);
  const NativeWorker = globalThis.Worker;
  let held = false, constructions = 0;
  let failing: Promise<unknown> | undefined;
  try {
    const dir = await b.fixture.install("probe", {}, {
      "main.js":
        `export function getSelectors(){return[{node:'fence',language:'probe'}]};export async function parseNode(node,ctx){if(node.crash){await ctx.readNote('crash-barrier');setTimeout(()=>{throw Error('owned A recovery crash')},0);return new Promise(()=>{})}return{parts:['<b>A</b>']}}`,
    });
    await b.manager.ensureStarted();
    const old = b.manager.hosts.get("probe")!;
    b.manager.network.policy = async (id) => {
      const value = await policy(id);
      if (id === "probe" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    failing = old.call("parseNode", [{ crash: true }]).catch((error) => error);
    await reviewRenderBarrier(crashEntered.promise, "A crash");
    crashRelease.resolve();
    await reviewRenderBarrier(entered.promise, "A recovery admission");
    assertEquals(old.available, false);
    await b.enable("probe", false);
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("EXPLICIT-B"));
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        constructions++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    await b.enable("probe", true);
    assertEquals(await b.render(), "<b>EXPLICIT-B</b>");
    const replacement = b.manager.hosts.get("probe")!,
      generations = [...replacement.generations];
    const beforeRelease = constructions;
    release.resolve();
    assert(await failing instanceof Error);
    // Observe the actual current source after releasing the captured query.
    await b.manager.network.view("probe");
    assertEquals(constructions, beforeRelease);
    assertEquals(b.manager.hosts.get("probe"), replacement);
    assertEquals(replacement.generations, generations);
    assertEquals(await b.render(), "<b>EXPLICIT-B</b>");
    console.log(JSON.stringify({
      lateASettled: true,
      actualConstructedBReplicas: beforeRelease,
      staleAAdditionalConstruction: constructions - beforeRelease,
      BGenerations: generations,
      BConsumer: "EXPLICIT-B",
    }));
  } finally {
    crashRelease.resolve();
    release.resolve();
    globalThis.Worker = NativeWorker;
    if (failing) await failing.catch(() => undefined);
    b.manager.network.policy = policy;
    await b.close();
  }
});

for (const ending of ["ready", "retired"] as const) {
  Deno.test(`review repairs: R22 demanded reload waits for actual initial sync and ${ending} owner outcome`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const generations = new Set<string>();
    let held = false;
    const b = await fixtureBundle(async (method, args, actor) => {
      if (
        held && method === "readNote" && args[0] === "replacement-readiness"
      ) {
        generations.add(actor!.generation);
        if (generations.size === 2) entered.resolve();
        await release.promise;
      }
      return null;
    }, true);
    try {
      await b.fixture.install("probe", {
        capabilities: { network: ["127.0.0.1:8123"], imports: false },
      }, {
        "main.js": renderCode("ACTUAL-READY") +
          "export async function onSync(ctx){await ctx.readNote('replacement-readiness')}",
      });
      await b.manager.ensureStarted();
      held = true;
      const before = await b.manager.network.view("probe");
      await b.manager.network.controls("probe", {
        revision: before.revision,
        signature: before.signature,
        requestSourceKey: before.requestSourceKey,
        requestSourceRevision: before.requestSourceRevision,
        allowNetwork: true,
        approvedNetwork: [{ type: "host", authority: "127.0.0.1:8123" }],
        approvedImports: [],
      });
      await reviewRenderBarrier(entered.promise, "replacement initial sync");
      const pending = await b.manager.network.view("probe");
      assertEquals(pending.reload.state, "reloading");
      assertEquals(
        b.manager.readyRenderOwners().some((owner) =>
          owner.pluginId === "probe"
        ),
        false,
      );
      if (ending === "retired") await b.enable("probe", false);
      release.resolve();
      let current = await b.manager.network.view("probe");
      const deadline = Date.now() + 3000;
      while (
        ["scheduled", "reloading"].includes(current.reload.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        current = await b.manager.network.view("probe");
      }
      assertEquals(
        current.reload.state,
        ending === "ready" ? "ready" : "failed",
      );
      if (ending === "ready") {
        assert(b.manager.hosts.get("probe")!.available);
        assertEquals(await b.render(), "<b>ACTUAL-READY</b>");
      } else {assertEquals(
          b.manager.readyRenderOwners().some((owner) =>
            owner.pluginId === "probe"
          ),
          false,
        );}
      console.log(
        JSON.stringify({
          ending,
          heldInitialSyncReplicas: [...generations],
          beforeRelease: pending.reload.state,
          settledReload: current.reload,
          actualReadyConsumer: ending === "ready",
        }),
      );
    } finally {
      release.resolve();
      await b.close();
    }
  });
}

Deno.test("render owner: actual enabled endpoint retires A and re-enable consumes installed B while unrelated pools persist", async () => {
  const b = await fixtureBundle();
  try {
    const dir = await b.fixture.install("probe", {
      version: "1",
      runtime: { server: "service.js" },
      capabilities: { network: false, imports: false },
    }, {
      "main.js": renderCode("ORIGINAL-A"),
      "service.js": serviceCode("ORIGINAL-A"),
    });
    await b.fixture.install(
      "unrelated",
      { runtime: { server: "service.js" } },
      {
        "main.js": renderCode("UNRELATED", "other"),
        "service.js": serviceCode("UNRELATED"),
      },
    );
    await b.runtime.reconcile();
    await ready(b.runtime, "probe");
    await ready(b.runtime, "unrelated");
    assertEquals(await b.render(), "<b>ORIGINAL-A</b>");
    const old = b.manager.hosts.get("probe")!,
      unrelated = b.manager.hosts.get("unrelated")!;
    const oldGeneration = old.generation,
      unrelatedGeneration = unrelated.generation;
    const oldNonces = (await Promise.all([
      old.call("parseNode", [{ identity: true }]),
      old.call("parseNode", [{ identity: true }]),
    ])) as { nonce: string }[];
    assertEquals(new Set(oldNonces.map((value) => value.nonce)).size, 2);
    const oldServiceGeneration = b.runtime.status("probe")!.generation;
    const unrelatedServiceGeneration =
      b.runtime.status("unrelated")!.generation;
    await b.enable("probe", false);
    const disabled = (await b.manager.catalog()).plugins.find((plugin) =>
      plugin.id === "probe"
    )!;
    const disabledHtml = await b.render();
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("REPLACEMENT-B"));
    await Deno.writeTextFile(`${dir}/service.js`, serviceCode("REPLACEMENT-B"));
    await b.enable("probe", true);
    await ready(b.runtime, "probe");
    const replacementHtml = await b.render();
    const replacement = b.manager.hosts.get("probe")!;
    const newNonces = (await Promise.all([
      replacement.call("parseNode", [{ identity: true }]),
      replacement.call("parseNode", [{ identity: true }]),
    ])) as { label: string; nonce: string }[];
    const service = await b.runtime.invokeCommand("probe", "identity", {}) as {
      label: string;
    };
    console.log(JSON.stringify({
      before: "ORIGINAL-A",
      disabled: { enabled: disabled.enabled, html: disabledHtml },
      replacementHtml,
      oldGeneration,
      newGeneration: replacement.generation,
      oldNonces,
      newNonces,
      service,
      unrelatedGeneration,
      unrelatedNow: b.manager.hosts.get("unrelated")?.generation,
      oldServiceGeneration,
      newServiceGeneration: b.runtime.status("probe")!.generation,
      unrelatedServiceGeneration,
      unrelatedServiceNow: b.runtime.status("unrelated")!.generation,
    }));
    assertEquals(disabled.enabled, false);
    assert(
      !disabledHtml.includes("ORIGINAL-A"),
      "Disabled render owner still contributes",
    );
    assertEquals(replacementHtml, "<b>REPLACEMENT-B</b>");
    assert(replacement !== old && replacement.generation !== oldGeneration);
    assert(
      newNonces.every((value) =>
        value.label === "REPLACEMENT-B" &&
        !oldNonces.some((old) => old.nonce === value.nonce)
      ),
    );
    assertEquals(new Set(newNonces.map((value) => value.nonce)).size, 2);
    assertEquals(service.label, "REPLACEMENT-B");
    assert(b.runtime.status("probe")!.generation !== oldServiceGeneration);
    assertEquals(b.manager.hosts.get("unrelated"), unrelated);
    assertEquals(
      b.manager.hosts.get("unrelated")!.generation,
      unrelatedGeneration,
    );
    assertEquals(
      b.runtime.status("unrelated")!.generation,
      unrelatedServiceGeneration,
    );
  } finally {
    await b.close();
  }
});

Deno.test("render owner: completed startup caching preserves lazy demand and unchanged code until explicit replacement", async () => {
  const b = await fixtureBundle();
  try {
    const dir = await b.fixture.install("probe", {}, {
      "main.js": renderCode("ORIGINAL-A"),
    });
    await b.runtime.reconcile();
    await b.enable("probe", false);
    await b.enable("probe", true);
    assertEquals(
      b.manager.hosts.size,
      0,
      "rendering must stay lazy before first demand",
    );
    await Promise.all([b.render(), b.render()]);
    const old = b.manager.hosts.get("probe")!, generation = old.generation;
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("REPLACEMENT-B"));
    await b.manager.syncAll();
    assertEquals(
      await b.render(),
      "<b>ORIGINAL-A</b>",
      "ordinary sync/render must not hot reload changed bytes",
    );
    assertEquals(b.manager.hosts.get("probe")!.generation, generation);
    await b.enable("probe", false);
    await b.enable("probe", true);
    const result = await b.render();
    assertEquals(result, "<b>REPLACEMENT-B</b>");
    const replacement = b.manager.hosts.get("probe")!;
    await Promise.all([b.render(), b.render(), b.manager.ensureStarted()]);
    assertEquals(b.manager.hosts.get("probe"), replacement);
  } finally {
    await b.close();
  }
});

for (const variant of ["selectors", "parts", "descriptor"] as const) {
  Deno.test(`render owner: retired awaited ${variant} result cannot contribute`, async () => {
    const b = await fixtureBundle();
    const delivered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      await b.fixture.install("probe", {}, {
        "main.js": variant === "descriptor"
          ? `export function getSelectors(){return [{node:'fence',language:'probe'}]}; export function parseNode(){return {node:{content:'STALE-DESCRIPTOR'}}}`
          : renderCode("STALE-PARTS"),
      });
      await b.render();
      const host = b.manager.hosts.get("probe")!, actual = host.call.bind(host);
      const name = variant === "selectors" ? "getSelectors" : "parseNode";
      let parses = 0;
      host.call = async (fn, args) => {
        if (fn === "parseNode") parses++;
        const value = await actual(fn, args);
        if (fn === name) {
          delivered.resolve();
          await release.promise;
        }
        return value;
      };
      const rendering = b.render();
      await delivered.promise;
      await b.enable("probe", false);
      release.resolve();
      const html = await rendering;
      console.log(
        JSON.stringify({
          variant,
          retiredGeneration: host.generation,
          html,
          parses,
        }),
      );
      assert(
        !html.includes("STALE-PARTS") && !html.includes("STALE-DESCRIPTOR"),
        "retired reply was consumed by the pipeline",
      );
      assert(
        html.includes("consumer"),
        "retired reply should use the normal render fallback",
      );
      if (variant === "selectors") {
        assertEquals(
          parses,
          0,
          "retired selectors must not admit another call",
        );
      }
    } finally {
      release.resolve();
      await b.close();
    }
  });
}

Deno.test("render owner: late A policy resolution cannot publish over disable-re-enable B", async () => {
  const b = await fixtureBundle();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    const dir = await b.fixture.install("probe", { version: "same" }, {
      "main.js": renderCode("ORIGINAL-A"),
    });
    const actual = b.manager.network.policy.bind(b.manager.network);
    let held = false;
    b.manager.network.policy = async (id) => {
      const value = await actual(id);
      if (id === "probe" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    const pending = b.render();
    await entered.promise;
    assertEquals(b.manager.readyRenderOwners(), []);
    await b.enable("probe", false);
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("REPLACEMENT-B"));
    await b.enable("probe", true);
    assertEquals(await b.render(), "<b>REPLACEMENT-B</b>");
    const replacement = b.manager.hosts.get("probe")!,
      generation = replacement.generation;
    release.resolve();
    await pending;
    assertEquals(b.manager.hosts.get("probe"), replacement);
    assertEquals(b.manager.hosts.get("probe")!.generation, generation);
    assertEquals(await b.render(), "<b>REPLACEMENT-B</b>");
    assertEquals(
      (await b.manager.catalog()).plugins.find((plugin) =>
        plugin.id === "probe"
      )!.status,
      "ready",
    );
  } finally {
    release.resolve();
    await b.close();
  }
});

Deno.test("render owner: stop cancels a pending admission without constructing or publishing its late owner", async () => {
  const b = await fixtureBundle();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    await b.fixture.install("probe", {}, {
      "main.js": renderCode("ORIGINAL-A"),
    });
    const actual = b.manager.network.policy.bind(b.manager.network);
    b.manager.network.policy = async (id) => {
      const value = await actual(id);
      entered.resolve();
      await release.promise;
      return value;
    };
    const pending = b.manager.ensureStarted();
    await entered.promise;
    b.manager.stop();
    await pending;
    release.resolve();
    await b.manager.network.policy("probe");
    assertEquals(b.manager.hosts.size, 0);
    assertEquals(b.manager.readyRenderOwners(), []);
  } finally {
    release.resolve();
    await b.close();
  }
});

Deno.test("render owner: real initial sync and service activation A retire before B and late RPC settlement", async () => {
  const renderEntered = Promise.withResolvers<void>(),
    serviceEntered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const oldGenerations = new Set<string>();
  let oldServiceGeneration: string | undefined;
  const b = await fixtureBundle(async (method, args, authority) => {
    if (method === "readNote" && args[0] === "render-A") {
      oldGenerations.add(authority!.generation);
      if (oldGenerations.size === 2) renderEntered.resolve();
      await release.promise;
    }
    if (method === "readNote" && args[0] === "service-A") {
      oldServiceGeneration = authority!.generation;
      serviceEntered.resolve();
      await release.promise;
    }
    return null;
  });
  try {
    const dir = await b.fixture.install("probe", {
      runtime: { server: "service.js" },
    }, {
      "main.js": renderCode("ORIGINAL-A") +
        "export async function onSync(ctx){await ctx.readNote('render-A')}",
      "service.js":
        "export async function activate(ctx){await ctx.readNote('service-A');ctx.commands.register({id:'identity',label:'Identity',target:'server'},()=>({label:'ORIGINAL-A'}))}",
    });
    await b.runtime.reconcile();
    const pending = b.render();
    await Promise.all([renderEntered.promise, serviceEntered.promise]);
    assertEquals(b.manager.readyRenderOwners(), []);
    await b.enable("probe", false);
    assertEquals(b.runtime.status("probe")!.generation, null);
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("REPLACEMENT-B"));
    await Deno.writeTextFile(`${dir}/service.js`, serviceCode("REPLACEMENT-B"));
    await b.enable("probe", true);
    await ready(b.runtime, "probe");
    const replacement = b.manager.hosts.get("probe")!,
      serviceGeneration = b.runtime.status("probe")!.generation;
    assertEquals(replacement.generations.length, 2);
    assert(
      replacement.generations.every((generation) =>
        !oldGenerations.has(generation)
      ),
    );
    assert(serviceGeneration !== oldServiceGeneration);
    release.resolve();
    await pending;
    assertEquals(b.manager.hosts.get("probe"), replacement);
    assertEquals(b.runtime.status("probe")!.generation, serviceGeneration);
    assertEquals(await b.render(), "<b>REPLACEMENT-B</b>");
    assertEquals(
      (await b.runtime.invokeCommand("probe", "identity", {}) as {
        label: string;
      }).label,
      "REPLACEMENT-B",
    );
    console.log(JSON.stringify({
      initialSyncOldReplicas: [...oldGenerations],
      oldServiceGeneration,
      replacementReplicas: replacement.generations,
      replacementService: serviceGeneration,
      consumed: "REPLACEMENT-B",
    }));
  } finally {
    release.resolve();
    await b.close();
  }
});

Deno.test("render owner: late service source-policy resolution cannot overwrite replacement readiness", async () => {
  const b = await fixtureBundle();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    const dir = await b.fixture.install("probe", {
      runtime: { server: "service.js" },
    }, { "service.js": serviceCode("ORIGINAL-A") });
    const actual = b.manager.network.policy.bind(b.manager.network);
    let held = false;
    b.manager.network.policy = async (id) => {
      const value = await actual(id);
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    await b.runtime.reconcile();
    await entered.promise;
    await b.enable("probe", false);
    await Deno.writeTextFile(`${dir}/service.js`, serviceCode("REPLACEMENT-B"));
    await b.enable("probe", true);
    await ready(b.runtime, "probe");
    const generation = b.runtime.status("probe")!.generation;
    release.resolve();
    assertEquals(
      (await b.runtime.invokeCommand("probe", "identity", {}) as {
        label: string;
      }).label,
      "REPLACEMENT-B",
    );
    assertEquals(b.runtime.status("probe")!.generation, generation);
    assertEquals(b.runtime.status("probe")!.status, "ready");
  } finally {
    release.resolve();
    await b.close();
  }
});

Deno.test("render owner: real second-slot constructor escalation cleans the already constructed partial pool", async () => {
  const b = await fixtureBundle();
  const NativeWorker = globalThis.Worker;
  const constructed: Worker[] = [], terminated = new Set<Worker>();
  let attempts = 0;
  try {
    await b.fixture.install("probe", {}, {
      "main.js": renderCode("ORIGINAL-A"),
    });
    assert(
      Deno.permissions.querySync({ name: "sys", kind: "hostname" }).state !==
        "granted",
    );
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        attempts++;
        const options = args[1] as WorkerOptions & {
          deno: { permissions: Deno.PermissionOptions };
        };
        const permissions = typeof options.deno.permissions === "object"
          ? options.deno.permissions
          : {};
        const actual = attempts === 2
          ? [args[0], {
            ...options,
            deno: { permissions: { ...permissions, sys: ["hostname"] } },
          }]
          : args;
        const worker = Reflect.construct(target, actual, newTarget) as Worker;
        const stop = worker.terminate.bind(worker);
        worker.terminate = () => {
          terminated.add(worker);
          stop();
        };
        constructed.push(worker);
        return worker;
      },
    });
    const html = await b.render();
    assertEquals(attempts, 2);
    assertEquals(constructed.length, 1);
    assertEquals(terminated.size, 1);
    assertEquals(b.manager.hosts.size, 0);
    assertEquals(b.manager.readyRenderOwners(), []);
    assert(!html.includes("ORIGINAL-A"));
    assertEquals(
      (await b.manager.catalog()).plugins.find((plugin) =>
        plugin.id === "probe"
      )!.status,
      "failed",
    );
    console.log(
      JSON.stringify({
        actualConstructorAttempts: attempts,
        actualConstructed: constructed.length,
        terminated: terminated.size,
        html,
      }),
    );
  } finally {
    globalThis.Worker = NativeWorker;
    for (const worker of constructed) worker.terminate();
    await b.close();
  }
});

Deno.test("render owner: real import failure detaches its candidate and explicit repair installs B", async () => {
  const b = await fixtureBundle();
  try {
    const dir = await b.fixture.install("probe", {}, {
      "main.js":
        "throw new Error('fixture module evaluation failed'); export function getSelectors(){return []}",
    });
    const fallback = await b.render();
    assert(!fallback.includes("ORIGINAL-A"));
    assertEquals(b.manager.hosts.size, 0);
    assertEquals(
      (await b.manager.catalog()).plugins.find((plugin) =>
        plugin.id === "probe"
      )!.status,
      "failed",
    );
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("REPLACEMENT-B"));
    await b.enable("probe", true);
    assertEquals(await b.render(), "<b>REPLACEMENT-B</b>");
    assertEquals(b.manager.hosts.get("probe")!.generations.length, 2);
  } finally {
    await b.close();
  }
});

Deno.test("render owner: permission-only replacement retains source requests and data while installed B retires old sources", async () => {
  const b = await fixtureBundle();
  let traffic = 0;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      traffic++;
      return new Response("approved receiver outcome");
    },
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const declarations =
    `await ctx.permissions.declare({network:['${authority}'],imports:false}); const request=await ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Read fixture status'});`;
  const service = (label: string) =>
    `const nonce=crypto.randomUUID(); export async function activate(ctx){
    ${declarations}
    const data=await ctx.data.load(); if(!data.values.keep) await ctx.data.save({keep:'retained'},data.revision);
    ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},async args=>{
      if(args.oldSource){try{await ctx.permissions.declare({network:['${authority}'],imports:false},{source:args.oldSource});return {unexpected:true}}catch(error){return {code:error.code,status:error.status}}}
      return {label:'${label}',nonce,request,settings:await ctx.settings.read(),data:await ctx.data.load(),view:await ctx.permissions.status()};
    });
    ctx.commands.register({id:'fetch',label:'Fetch',target:'server'},async()=>await(await fetch('http://${authority}/consumer')).text());
  }`;
  let oldActor: RpcAuthority | undefined;
  const actualRpc = b.manager.network.rpc.bind(b.manager.network);
  b.manager.network.rpc = (id, method, args, actor) => {
    if (id === "probe" && !oldActor) oldActor = actor;
    return actualRpc(id, method, args, actor);
  };
  const controls = async (allowNetwork: boolean, approved = true) => {
    const view = await b.manager.network.view("probe");
    return b.manager.network.controls("probe", {
      revision: view.revision,
      signature: view.signature,
      requestSourceKey: view.requestSourceKey,
      requestSourceRevision: view.requestSourceRevision,
      allowNetwork,
      approvedNetwork: approved ? [{ type: "host", authority }] : [],
      approvedImports: [],
    });
  };
  const reloadReady = async () => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const view = await b.manager.network.view("probe");
      if (view.reload.state === "ready") return view;
      if (view.reload.state === "failed" || Date.now() >= deadline) {
        throw new Error(
          `permission replacement not ready: ${JSON.stringify(view.reload)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const dir = await b.fixture.install("probe", {
      version: "same",
      runtime: { server: "service.js" },
      settings: [fixturePage],
      capabilities: { network: [authority], imports: false },
    }, {
      "main.js": renderCode("ORIGINAL-A") +
        `export async function onSync(ctx){${declarations}}`,
      "service.js": service("ORIGINAL-A"),
    });
    await b.fixture.install(
      "unrelated",
      { runtime: { server: "service.js" } },
      {
        "main.js": renderCode("UNRELATED", "other"),
        "service.js": serviceCode("UNRELATED"),
      },
    );
    const data = new PluginDataStore(b.fixture.statePath, {
      commit: (effect) => effect(),
    }).forPlugin("probe");
    await data.savePage(
      {
        ...fixturePage,
        renderer: { kind: "declarative-v1", version: 1 },
        fields: fixturePage
          .fields as import("../server/plugins/contracts.ts").SettingsField[],
      },
      { message: "retained settings", protect: true, limit: 5 },
      0,
    );
    await b.runtime.reconcile();
    await ready(b.runtime, "probe");
    await ready(b.runtime, "unrelated");
    await b.render();
    const first = await b.manager.network.view("probe"),
      before = await b.manager.network.store.read("probe");
    assertEquals(first.pendingRequests.length, 1);
    assert(
      before.record.contributors.service && before.record.contributors.render,
    );
    assertEquals(traffic, 0);
    const renderA = b.manager.hosts.get("probe")!,
      serviceA = b.runtime.status("probe")!.generation;
    const unrelatedRender = b.manager.hosts.get("unrelated")!,
      unrelatedService = b.runtime.status("unrelated")!.generation;
    await controls(true);
    const approved = await reloadReady();
    assertEquals(approved.source, first.source);
    assertEquals(approved.effectiveImports, []);
    assertEquals(
      (await b.manager.network.store.read("probe")).record.contributors,
      before.record.contributors,
    );
    assertEquals(approved.pendingRequests, []);
    assert(
      b.manager.hosts.get("probe") !== renderA &&
        b.runtime.status("probe")!.generation !== serviceA,
    );
    assertEquals(
      await b.runtime.invokeCommand("probe", "fetch", {}),
      "approved receiver outcome",
    );
    assertEquals(traffic, 1);
    assertEquals(b.manager.hosts.get("unrelated"), unrelatedRender);
    assertEquals(b.runtime.status("unrelated")!.generation, unrelatedService);
    await controls(false);
    const off = await reloadReady();
    assertEquals(off.approvedNetwork, [{ type: "host", authority }]);
    assertEquals(off.effectiveNetwork, []);
    await assertRejects(() => b.runtime.invokeCommand("probe", "fetch", {}));
    assertEquals(traffic, 1);
    const oldSource = off.source;
    await Deno.writeTextFile(
      `${dir}/main.js`,
      renderCode("REPLACEMENT-B") +
        `export async function onSync(ctx){${declarations}}`,
    );
    await Deno.writeTextFile(`${dir}/service.js`, service("REPLACEMENT-B"));
    await b.enable("probe", true);
    await ready(b.runtime, "probe");
    assertEquals(await b.render(), "<b>REPLACEMENT-B</b>");
    const replacement = await b.manager.network.view("probe"),
      stored = await b.manager.network.store.read("probe");
    assert(
      replacement.source.key !== oldSource.key &&
        replacement.source.revision > oldSource.revision,
    );
    assertEquals(replacement.approvedNetwork, off.approvedNetwork);
    assert(
      stored.record.requests.some((request) =>
        request.source.key === oldSource.key && request.state === "obsolete"
      ),
    );
    const inspect = await b.runtime.invokeCommand("probe", "inspect", {}) as {
      label: string;
      data: { values: unknown };
      settings: { values: { preferences: { message: string } } };
    };
    assertEquals(inspect.label, "REPLACEMENT-B");
    assertEquals(inspect.data.values, { keep: "retained" });
    assertEquals(
      inspect.settings.values.preferences.message,
      "retained settings",
    );
    assertEquals(
      await b.runtime.invokeCommand("probe", "inspect", { oldSource }),
      { code: "permission_source_conflict", status: 409 },
    );
    await assertRejects(() =>
      actualRpc("probe", "permissions.declare", [{ network: [authority] }, {
        source: replacement.source,
      }], oldActor!)
    );
    await controls(false, false);
    const final = await b.manager.network.view("probe");
    assertEquals(final.approvedNetwork, []);
    assert(
      final.rows.some((row) =>
        row.kind === "network" && row.requested &&
        row.blockedReasons.includes("unapproved")
      ),
    );
    assertEquals(b.manager.hosts.get("unrelated"), unrelatedRender);
    assertEquals(b.runtime.status("unrelated")!.generation, unrelatedService);
    console.log(JSON.stringify({
      receiverTraffic: traffic,
      oldSource,
      replacementSource: replacement.source,
      sourceRetirement: true,
      privateDataRetained: true,
      settingsRetained: true,
      unrelatedGenerationsUnchanged: true,
    }));
  } finally {
    await receiver.shutdown();
    await b.close();
  }
});

Deno.test("render owner: late actual failed A disposal cannot alter ready B status or owner", async () => {
  const b = await fixtureBundle();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const dispose = PluginHost.prototype.dispose;
  let oldGeneration: string | null = null;
  const failures: unknown[] = [];
  try {
    const dir = await b.fixture.install("probe", {
      runtime: { server: "service.js" },
    }, {
      "main.js": renderCode("ORIGINAL-A"),
      "service.js": serviceCode("ORIGINAL-A") +
        "export function deactivate(){throw new Error('actual old disposer failure')}",
    });
    await b.runtime.reconcile();
    await ready(b.runtime, "probe");
    await b.render();
    oldGeneration = b.runtime.status("probe")!.generation;
    PluginHost.prototype.dispose = async function () {
      const generation = this.generation;
      const result = await dispose.call(this);
      if (this.role === "service" && generation === oldGeneration) {
        failures.push(...result.errors);
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const disabling = b.enable("probe", false);
    await entered.promise;
    await Deno.writeTextFile(`${dir}/main.js`, renderCode("REPLACEMENT-B"));
    await Deno.writeTextFile(`${dir}/service.js`, serviceCode("REPLACEMENT-B"));
    const enabling = b.enable("probe", true);
    await ready(b.runtime, "probe");
    assertEquals(await b.render(), "<b>REPLACEMENT-B</b>");
    const replacement = b.manager.hosts.get("probe")!,
      generation = b.runtime.status("probe")!.generation;
    assertEquals(failures, ["actual old disposer failure"]);
    release.resolve();
    await Promise.all([disabling, enabling]);
    assertEquals(b.manager.hosts.get("probe"), replacement);
    assertEquals(b.runtime.status("probe")!.generation, generation);
    assertEquals(b.runtime.status("probe")!.status, "ready");
    assert(
      !b.runtime.status("probe")!.diagnostics.some((diagnostic) =>
        diagnostic.code === "plugin_disposal_incomplete"
      ),
    );
  } finally {
    release.resolve();
    PluginHost.prototype.dispose = dispose;
    await b.close();
  }
});

Deno.test("render owner: on-load and initial-sync permission expansions return admission before selective replacement", async () => {
  const b = await fixtureBundle();
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response("expansion consumer"),
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const declaration =
    `const admission=await ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Load configured endpoint'});await ctx.permissions.declare({network:['${authority}'],imports:false});`;
  try {
    await b.fixture.install("probe", {
      runtime: { server: "service.js" },
      settings: [fixturePage],
      capabilities: { network: false, imports: false },
    }, {
      "main.js":
        `const nonce=crypto.randomUUID();let admitted=false;export function getSelectors(){return[{node:'fence',language:'probe'}]}export function parseNode(node){return node.identity?{nonce,admitted}:{parts:['<b>expansion</b>']}}export async function onSync(ctx){const settings=await ctx.settings.read();if(settings.values.preferences.message==='declare'){${declaration}admitted=!!admission.requestId;}}`,
      "service.js":
        `const nonce=crypto.randomUUID();export async function activate(ctx){const settings=await ctx.settings.read();if(settings.values.preferences.message==='declare'){${declaration}const data=await ctx.data.load();await ctx.data.save({admitted:!!admission.requestId},data.revision);}ctx.commands.register({id:'ask',label:'Ask',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['${authority}'],reason:'Load configured endpoint'}));ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},async()=>({nonce,data:await ctx.data.load()}));ctx.commands.register({id:'fetch',label:'Fetch',target:'server'},async()=>await(await fetch('http://${authority}')).text());}`,
    });
    await b.fixture.install(
      "unrelated",
      { runtime: { server: "service.js" } },
      {
        "main.js": renderCode("UNRELATED", "other"),
        "service.js": serviceCode("UNRELATED"),
      },
    );
    await b.runtime.reconcile();
    await ready(b.runtime, "probe");
    await ready(b.runtime, "unrelated");
    await b.render();
    const unrelated = b.manager.hosts.get("unrelated")!,
      unrelatedService = b.runtime.status("unrelated")!.generation;
    await b.runtime.invokeCommand("probe", "ask", {});
    let view = await b.manager.network.view("probe");
    await b.manager.network.controls("probe", {
      revision: view.revision,
      signature: view.signature,
      requestSourceKey: view.requestSourceKey,
      requestSourceRevision: view.requestSourceRevision,
      allowNetwork: true,
      approvedNetwork: [{ type: "host", authority }],
      approvedImports: [],
    });
    const waitReload = async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const current = await b.manager.network.view("probe");
        if (
          current.reload.state === "ready" &&
          b.runtime.status("probe")?.status === "ready" &&
          b.manager.hosts.has("probe")
        ) return current;
        if (current.reload.state === "failed" || Date.now() > deadline) {
          throw Error(
            `expansion replacement failed ${JSON.stringify(current.reload)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await waitReload();
    const data = new PluginDataStore(b.fixture.statePath, {
      commit: (effect) => effect(),
      settingsChanged: (id, page, revision) =>
        b.runtime.settingsChanged(id, page, revision),
    }).forPlugin("probe");
    await data.savePage(
      {
        ...fixturePage,
        renderer: { kind: "declarative-v1", version: 1 },
        fields: fixturePage
          .fields as import("../server/plugins/contracts.ts").SettingsField[],
      },
      { message: "declare", protect: true, limit: 5 },
      0,
    );
    view = await b.manager.network.view("probe");
    assertEquals(view.effectiveNetwork, []);
    assertEquals(view.approvedNetwork, [{ type: "host", authority }]);
    await b.manager.reconcileOwners({ replaceId: "probe" });
    await waitReload();
    const inspect = await b.runtime.invokeCommand("probe", "inspect", {}) as {
      data: { values: { admitted?: boolean } };
    };
    assertEquals(inspect.data.values.admitted, true);
    const host = b.manager.hosts.get("probe")!;
    const replicas = await Promise.all([
      host.call("parseNode", [{ identity: true }]),
      host.call("parseNode", [{ identity: true }]),
    ]) as { nonce: string; admitted: boolean }[];
    assert(replicas.every((replica) => replica.admitted));
    assertEquals(new Set(replicas.map((replica) => replica.nonce)).size, 2);
    assertEquals(
      await b.runtime.invokeCommand("probe", "fetch", {}),
      "expansion consumer",
    );
    const stable = host.generation,
      service = b.runtime.status("probe")!.generation;
    await b.manager.syncAll();
    assertEquals(b.manager.hosts.get("probe")!.generation, stable);
    assertEquals(b.runtime.status("probe")!.generation, service);
    assertEquals(b.manager.hosts.get("unrelated"), unrelated);
    assertEquals(b.runtime.status("unrelated")!.generation, unrelatedService);
  } finally {
    await receiver.shutdown();
    await b.close();
  }
});
