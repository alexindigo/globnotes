// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { AuthType } from "../server/config.ts";
import { driverControl } from "../server/hub/drivers/api.ts";
import { VaultHub } from "../server/hub/hub.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { DriverSupervisor } from "../server/hub/drivers/supervisor.ts";
import { DriverSecrets } from "../server/hub/drivers/secrets.ts";
import { ObservedClock } from "../server/observed_time.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { state } from "../server/state.ts";
import { driverDeclaration, minimalDriver } from "./helpers/driver_fixture.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { LivenessClock } from "./helpers/worker_liveness.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { fixturePage } from "./helpers/plugin_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";

const guard = () => {};
function fixture(
  source = minimalDriver,
  network: string[] | false = false,
  declaration: Record<string, unknown> = driverDeclaration,
) {
  const f = hubOperationsFixture();
  const dir = `${f.config.statePath}/plugins/test-driver`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}/manifest.json`,
    JSON.stringify({
      id: "test-driver",
      driver: declaration,
      capabilities: { network, imports: false },
    }),
  );
  Deno.writeTextFileSync(`${dir}/driver.js`, source);
  const manager = createPluginManager(
    f.vault,
    undefined,
    1,
    f.config.statePath,
    {
      internalRoot: `${f.root}/no-internal`,
      autoEnable: true,
      environment: true,
      persistence: { commit: (effect) => f.lifecycle.gate.run(effect) },
    },
  );
  const scheduler = new LivenessClock();
  const supervisor = new DriverSupervisor({
    hub: f.hub,
    operations: f.operations,
    plugins: manager,
    lifecycle: f.lifecycle,
    clock: new ObservedClock(scheduler),
  });
  manager.configureDrivers(supervisor);
  state.plugins = manager;
  state.drivers = supervisor;
  const one = async (id: string) =>
    (await supervisor.view()).instances.find((row) => row.id === id)!;
  const create = async (label = "Remote") => {
    const result = await supervisor.create(
      { plugin: "test-driver", label },
      guard,
    );
    return supervisor.peers.instance(result.id)!;
  };
  const key = async (id: string, value = "test-key") => {
    const instance = supervisor.peers.instance(id)!;
    await supervisor.secret(
      id,
      "token",
      { revision: instance.revision, value },
      false,
      guard,
    );
    return supervisor.peers.instance(id)!;
  };
  const enable = async (id: string) => {
    const instance = supervisor.peers.instance(id)!;
    return await supervisor.update(id, {
      revision: instance.revision,
      label: instance.label,
      settings: instance.settings,
      enabled: true,
    }, guard);
  };
  const approve = async (allow = true) => {
    const view = await manager.network.view("test-driver");
    await manager.network.controls("test-driver", {
      revision: view.revision,
      signature: view.signature,
      requestSourceKey: view.requestSourceKey,
      requestSourceRevision: view.requestSourceRevision,
      allowNetwork: allow,
      approvedNetwork: view.requestedNetwork,
      approvedImports: [],
    });
    await waitUntil(async () => {
      const value = await manager.network.view("test-driver");
      return ["ready", "failed"].includes(value.reload.state)
        ? done()
        : pending(value.reload);
    }, { label: "driver permission replacement settles" });
  };
  return {
    ...f,
    dir,
    manager,
    supervisor,
    scheduler,
    one,
    create,
    key,
    enable,
    approve,
    async close() {
      await supervisor.close();
      manager.stop();
      f.close();
    },
  };
}

Deno.test("driver supervisor: missing and retired slots report no scheduled retry", async () => {
  const f = fixture();
  try {
    await f.manager.catalog();
    const instance = f.supervisor.peers.create(
      "test-driver",
      "Unreconciled",
      {},
    );
    assertEquals((await f.one(instance.id)).nextRetry, null);
    await f.supervisor.reconcile();
    assertEquals((await f.one(instance.id)).nextRetry, null);
    await f.key(instance.id);
    await f.enable(instance.id);
    assertEquals((await f.one(instance.id)).status, "active");
    assertEquals((await f.one(instance.id)).nextRetry, null);
    f.supervisor.retireOwner("test-driver");
    assertEquals((await f.one(instance.id)).nextRetry, null);
  } finally {
    await f.close();
  }
});

Deno.test("driver supervisor: durable trouble survives retries and supervisor restart, clears on recovery", async () => {
  const f = fixture();
  let replacement: DriverSupervisor | undefined;
  try {
    const instance = await f.create();
    await f.enable(instance.id);
    const locked = await f.one(instance.id);
    assertEquals(locked.status, "locked");
    assert(typeof locked.failingSince === "number");
    await f.supervisor.sync(instance.id, {
      revision: f.supervisor.peers.instance(instance.id)!.revision,
    }, guard);
    assertEquals((await f.one(instance.id)).failingSince, locked.failingSince);
    await f.supervisor.close();
    replacement = new DriverSupervisor({
      hub: f.hub,
      operations: f.operations,
      plugins: f.manager,
      lifecycle: f.lifecycle,
      clock: new ObservedClock(f.scheduler),
    });
    await replacement.reconcile();
    const restarted = (await replacement.view()).instances.find((row) =>
      row.id === instance.id
    )!;
    assertEquals(restarted.failingSince, locked.failingSince);
    await replacement.secret(
      instance.id,
      "token",
      { revision: restarted.revision, value: "key" },
      false,
      guard,
    );
    const recovered = (await replacement.view()).instances.find((row) =>
      row.id === instance.id
    )!;
    assertEquals(recovered.status, "active");
    assertEquals(recovered.failingSince, null);
  } finally {
    await replacement?.close();
    await f.close();
  }
});

Deno.test("driver supervisor: off by default, missing keys construct no Worker, secrets restart only their instance", async () => {
  const f = await fixture(
    `const generation=crypto.randomUUID(); export function activate(ctx) {
    ctx.driver.serve({ open:async()=>{const key=await ctx.secrets.get('token');return key===ctx.instance.label ? {state:'ready',endpoint:{id:ctx.instance.id,epoch:generation},scope:'all'}:{state:'locked',reason:'wrong '+key}},
    discover:()=>({endpoint:{id:ctx.instance.id,epoch:generation},scope:'all',mode:'snapshot',entries:[],completion:'complete'}),read:()=>({state:'absent'}),apply:items=>items.map(x=>({id:x.id,state:'settled',...(x.op==='put'?{revision:generation}:{})})),close(){} }); }`,
  );
  const Native = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = new Proxy(Native, {
    construct(target, args, newTarget) {
      constructions++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const a = await f.create("alpha"), b = await f.create("beta");
    assertEquals((await f.one(a.id)).status, "off");
    await f.enable(a.id);
    assertEquals(constructions, 0);
    assertEquals((await f.one(a.id)).status, "locked");
    await f.key(a.id, "alpha");
    await f.key(b.id, "beta");
    await f.enable(b.id);
    assertEquals((await f.one(a.id)).status, "active");
    assertEquals((await f.one(b.id)).status, "active");
    assertEquals(constructions, 2);
    const bBinding = f.supervisor.peers.sync(b.id);
    await f.key(a.id, "wrong-key-canary");
    const view = await f.one(a.id);
    assertEquals(view.status, "locked");
    assertEquals(view.reason, "wrong [secret]");
    assertEquals(f.supervisor.peers.sync(b.id), bBinding);
    assertEquals(constructions, 3);
    const current = f.supervisor.peers.instance(a.id)!;
    await f.supervisor.secret(
      a.id,
      "token",
      { revision: current.revision },
      true,
      guard,
    );
    assertEquals(constructions, 3);
    assertEquals((await f.one(a.id)).secrets[0].set, false);
    assertEquals((await f.one(b.id)).secrets[0].set, true);
  } finally {
    globalThis.Worker = Native;
    await f.close();
  }
});

Deno.test("driver supervisor: optional keys reach SDK open, lock before IO and clear without losing files or mappings", async () => {
  const remote = memoryRemote();
  remote.put("optional.md", "imported through optional-key Worker");
  const source = Deno.readTextFileSync(
    new URL(
      "fixtures/plugins/globnotes-test-driver/driver.js",
      import.meta.url,
    ),
  ).replace(
    "ctx.instance.settings;",
    `{baseUrl:${
      JSON.stringify(remote.baseUrl)
    },prefix:'',exclude:'',forbiddenCharacters:''};`,
  ).replace(
    'identity: async () => await (await request("/identity")).json(),',
    `identity: async () => {
      if (!await ctx.secrets.get('token')) throw new StorageError('unauthorized', {effect:'none',message:'needs Access token'});
      return await (await request('/identity')).json();
    },`,
  );
  const f = fixture(source, [new URL(remote.baseUrl).host], {
    ...driverDeclaration,
    secrets: [
      { key: "token", label: "Access token", required: false },
      { key: "spare", label: "Other backend key", required: false },
    ],
  });
  const Native = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = new Proxy(Native, {
    construct(target, args, newTarget) {
      constructions++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const a = await f.create("Optional"), b = await f.create("Isolated");
    await f.approve();
    await f.enable(a.id);
    assertEquals(constructions, 1);
    assertEquals((await f.one(a.id)).status, "locked");
    assertEquals((await f.one(a.id)).reason, "needs Access token");
    assertEquals(remote.requests.length, 0);
    await f.key(a.id, "memory-token");
    assertEquals((await f.one(a.id)).status, "active");
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/optional.md`),
      "imported through optional-key Worker",
    );
    assertEquals((await f.one(b.id)).secrets[0].set, false);
    assertEquals(
      (await f.one(a.id)).secrets.map(({ set }: { set: boolean }) => set),
      [
        true,
        false,
      ],
    );
    assertEquals((await f.one(a.id)).declaration.secrets[0].required, false);
    const mappings = f.supervisor.peers.files(a.id);
    const requests = remote.requests.length;
    const beforeClear = constructions;
    await f.supervisor.secret(
      a.id,
      "token",
      {
        revision: f.supervisor.peers.instance(a.id)!.revision,
      },
      true,
      guard,
    );
    assertEquals(constructions, beforeClear + 1);
    assertEquals((await f.one(a.id)).status, "locked");
    assertEquals(remote.requests.length, requests);
    assertEquals(f.supervisor.peers.files(a.id), mappings);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/optional.md`),
      "imported through optional-key Worker",
    );
    await f.key(a.id, "memory-token");
    assertEquals((await f.one(a.id)).status, "active");
    assertEquals(remote.requests.filter(({ method }) => method !== "GET"), []);
    assertEquals(f.supervisor.peers.files(a.id), mappings);
  } finally {
    globalThis.Worker = Native;
    await f.close();
    await remote.close();
  }
});

Deno.test("driver supervisor: CRUD CAS, strict fields, declaration validation, stable reads and removal secure deletion", async () => {
  const f = await fixture();
  try {
    const instance = await f.create();
    const revisions: number[] = [];
    const off = f.supervisor.subscribe((revision) => revisions.push(revision));
    await f.key(instance.id, "removal-secret-canary");
    await assertRejects(() =>
      f.supervisor.update(instance.id, {
        revision: instance.revision,
        label: "x",
        settings: {},
        enabled: false,
      }, guard)
    );
    await assertRejects(() =>
      f.supervisor.update(instance.id, {
        revision: 2,
        label: "x",
        settings: { unknown: "x" },
        enabled: false,
      }, guard)
    );
    await assertRejects(() =>
      f.supervisor.secret(
        instance.id,
        "undeclared",
        { revision: 2, value: "x" },
        false,
        guard,
      )
    );
    await assertRejects(() =>
      f.supervisor.create(
        { plugin: "test-driver", label: "x", enabled: true },
        guard,
      )
    );
    const revision = f.supervisor.revision();
    const read = await f.supervisor.view();
    await f.supervisor.view();
    assertEquals(f.supervisor.revision(), revision);
    assert(!JSON.stringify(read).includes("removal-secret-canary"));
    assertEquals(read.notice, null);
    const bytes = new TextDecoder().decode(
      Deno.readFileSync(`${f.config.statePath}/driver-secrets.sqlite`),
    );
    assert(bytes.includes("removal-secret-canary"));
    await f.supervisor.remove(instance.id, { revision: 2 }, guard);
    assertEquals((await f.supervisor.view()).instances, []);
    assert(
      !new TextDecoder().decode(
        Deno.readFileSync(`${f.config.statePath}/driver-secrets.sqlite`),
      ).includes("removal-secret-canary"),
    );
    const next = await f.create();
    assert(next.id !== instance.id);
    assert(
      revisions.every((value, index) =>
        index === 0 || value > revisions[index - 1]
      ),
    );
    off();
    await assertRejects(() =>
      f.supervisor.remove("other-vault", { revision: 1 }, guard)
    );
  } finally {
    await f.close();
  }
});

Deno.test("driver supervisor: observed-time discovery and debounced exports are independent of wall-clock waits", async () => {
  const f = await fixture();
  try {
    const instance = await f.create();
    await f.key(instance.id);
    await f.enable(instance.id);
    assertEquals((await f.one(instance.id)).activity, null);
    const first = f.supervisor.peers.sync(instance.id);
    Deno.writeTextFileSync(`${f.vault}/new.md`, "local");
    f.hub.scanNow();
    f.scheduler.tick(999);
    await f.supervisor.settle();
    assertEquals(f.supervisor.peers.file(instance.id, "new.md"), null);
    f.scheduler.tick(1001);
    await f.supervisor.settle();
    assertEquals(
      f.supervisor.peers.file(instance.id, "new.md")?.state,
      "synced",
    );
    assert(f.supervisor.peers.sync(instance.id).exportSeq > first.exportSeq);
    assertEquals((await f.one(instance.id)).activity, "sending");
    const activityRevision = f.supervisor.revision();
    f.scheduler.tick(2002);
    await f.supervisor.settle();
    assertEquals((await f.one(instance.id)).activity, null);
    assertEquals(f.supervisor.revision(), activityRevision + 1);
    const before = f.supervisor.revision();
    f.scheduler.tick(60_002);
    await f.supervisor.settle();
    // Empty native snapshot with an existing mapping is attention, never deletion.
    assertEquals((await f.one(instance.id)).reason, "remote_empty");
    assertEquals(Deno.readTextFileSync(`${f.vault}/new.md`), "local");
    assert(f.supervisor.revision() > before);
  } finally {
    await f.close();
  }
});

for (
  const mode of ["disable", "access", "secret", "remove", "network"] as const
) {
  Deno.test(`driver supervisor: ${mode} synchronously fences a held real Worker read`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async () => {
        entered.resolve();
        await release.promise;
        return new Response("remote file");
      },
    );
    const authority = `127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    const f = await fixture(
      `export function activate(ctx){ctx.driver.serve({
      open:()=>({state:'ready',endpoint:{id:'remote',epoch:'1'},scope:'all'}),
      discover:()=>({endpoint:{id:'remote',epoch:'1'},scope:'all',mode:'snapshot',entries:[{state:'known',path:'held.md',revision:'r1'}],completion:'complete'}),
      read:async()=>({state:'known',revision:'r1',bytes:new Uint8Array(await (await fetch('http://${authority}/')).arrayBuffer())}),
      apply:()=>[],close(){} });}`,
      [authority],
    );
    let enabling: Promise<unknown> | undefined;
    try {
      await f.approve();
      const instance = await f.create();
      await f.key(instance.id);
      enabling = f.enable(instance.id);
      await entered.promise;
      if (mode === "disable") {
        const policy = await f.manager.policy.read();
        await f.manager.policy.setEnabled(
          "test-driver",
          false,
          policy.metadata,
        );
      } else if (mode === "access") {
        f.config.authType = AuthType.READ_ONLY;
        f.lifecycle.bumpEpoch();
      } else if (mode === "secret") {
        const current = f.supervisor.peers.instance(instance.id)!;
        await f.supervisor.secret(
          instance.id,
          "token",
          { revision: current.revision },
          true,
          guard,
        );
      } else if (mode === "remove") {
        const current = f.supervisor.peers.instance(instance.id)!;
        await f.supervisor.remove(
          instance.id,
          { revision: current.revision },
          guard,
        );
      } else {
        const view = await f.manager.network.view("test-driver");
        await f.manager.network.controls("test-driver", {
          revision: view.revision,
          signature: view.signature,
          requestSourceKey: view.requestSourceKey,
          requestSourceRevision: view.requestSourceRevision,
          allowNetwork: false,
          approvedNetwork: view.approvedNetwork,
          approvedImports: [],
        });
      }
      release.resolve();
      await enabling;
      await f.supervisor.settle();
      assertEquals(f.hub.fileState("held.md"), null);
      assertEquals(f.hub.sequence(), 0);
      if (mode === "access") {
        assertEquals((await f.one(instance.id)).status, "paused");
      }
      if (mode === "secret") {
        assertEquals((await f.one(instance.id)).status, "locked");
      }
      if (mode === "disable") {
        await f.manager.reconcileOwners();
        assertEquals((await f.one(instance.id)).status, "off");
      }
    } finally {
      release.resolve();
      await enabling;
      await f.close();
      await server.shutdown();
    }
  });
}

Deno.test("driver supervisor: explicit source replacement fences and loads new code, automatic retry cannot", async () => {
  const f = await fixture();
  try {
    const instance = await f.create();
    await f.key(instance.id);
    await f.enable(instance.id);
    const original = f.supervisor.ownerSources("test-driver")[0];
    Deno.writeTextFileSync(
      `${f.dir}/driver.js`,
      minimalDriver.replace("id:'memory'", "id:'replacement'").replace(
        "id:'memory'",
        "id:'replacement'",
      ),
    );
    const view = await f.manager.network.view("test-driver");
    assertEquals(view.reload.state, "failed");
    assertEquals(f.supervisor.ownerSources("test-driver")[0], original);
    await f.manager.reconcileOwners({ replaceId: "test-driver" });
    assertEquals((await f.one(instance.id)).status, "active");
    assertEquals(
      f.supervisor.peers.sync(instance.id).endpointId,
      "replacement",
    );
  } finally {
    await f.close();
  }
});

Deno.test("driver supervisor: request authority is rechecked at the queued metadata effect", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  try {
    const held = f.lifecycle.gate.run(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let current = true;
    const creating = f.supervisor.create({
      plugin: "test-driver",
      label: "blocked",
    }, () => {
      if (!current) throw new Error("request retired");
    });
    current = false;
    release.resolve();
    await held;
    await assertRejects(() => creating, Error, "request retired");
    assertEquals(f.supervisor.peers.instances(), []);
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test("driver supervisor: closing fences Workers before key storage closes", async () => {
  const f = await fixture();
  try {
    const instance = await f.create();
    await f.key(instance.id);
    await f.enable(instance.id);
    await f.supervisor.close();
    const keys = new DriverSecrets(f.config.statePath);
    assertEquals(keys.get(instance.id, "token"), "test-key");
    keys.close();
    await assertRejects(() =>
      f.supervisor.sync(instance.id, { revision: 3 }, guard)
    );
  } finally {
    await f.close();
  }
});

Deno.test("driver API: original settings authority crosses a held request body", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const request = new Request("http://globnotes.test/_/api/drivers", {
    method: "POST",
    body: stream,
  });
  const body = request.body!;
  const reader = body.getReader.bind(body);
  body.getReader = (() => {
    entered.resolve();
    return reader();
  }) as typeof body.getReader;
  let creating: Promise<Response> | undefined;
  try {
    creating = driverControl(
      { _raw: request } as PathfinderRequest,
      (owner, body, check) => owner.create(body, check),
    );
    // The body owner is acquired only after settingsWriteGuard captured authority.
    await entered.promise;
    f.lifecycle.bumpEpoch();
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ plugin: "test-driver", label: "retired request" }),
      ),
    );
    controller.close();
    await assertRejects(() => creating!, Error);
    assertEquals(f.supervisor.peers.instances(), []);
  } finally {
    await creating?.catch(() => undefined);
    await f.close();
  }
});

Deno.test("driver supervisor: state-in-vault notice names the actual canonical key directory", async () => {
  const f = fixture();
  const statePath = `${f.vault}/State`;
  Deno.mkdirSync(statePath);
  const hub = new VaultHub(f.vault, statePath, f.config.environment);
  const supervisor = new DriverSupervisor({
    hub,
    operations: f.operations,
    plugins: f.manager,
    lifecycle: f.lifecycle,
  });
  try {
    assertEquals(
      (await supervisor.view()).notice,
      `Keys are stored in ${
        Deno.realPathSync(statePath)
      }; tools that copy the whole vault folder copy them too.`,
    );
  } finally {
    await supervisor.close();
    hub.stop();
    await f.close();
  }
});

Deno.test("driver supervisor: a held instance cannot block another instance's native import", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async () => {
      entered.resolve();
      await release.promise;
      return new Response("slow");
    },
  );
  const authority = `127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const f = fixture(
    `export function activate(ctx){const name=ctx.instance.label+'.md'; ctx.driver.serve({
    open:()=>({state:'ready',endpoint:{id:ctx.instance.id,epoch:'1'},scope:'all'}),
    discover:()=>({endpoint:{id:ctx.instance.id,epoch:'1'},scope:'all',mode:'snapshot',entries:[{state:'known',path:name,revision:'r1'}],completion:'complete'}),
    read:async()=>({state:'known',revision:'r1',bytes:ctx.instance.label==='slow'?new Uint8Array(await (await fetch('http://${authority}/')).arrayBuffer()):new TextEncoder().encode('fast bytes')}),
    apply:items=>items.map(item=>({id:item.id,state:'settled',...(item.op==='put'?{revision:'r2'}:{})})),close(){} });}`,
    [authority],
  );
  let slow: Promise<unknown> | undefined;
  try {
    await f.approve();
    const a = await f.create("slow"), b = await f.create("fast");
    await f.key(a.id);
    await f.key(b.id);
    slow = f.enable(a.id);
    await entered.promise;
    await f.enable(b.id);
    assertEquals(Deno.readTextFileSync(`${f.vault}/fast.md`), "fast bytes");
    assertEquals((await f.one(b.id)).status, "active");
    assertEquals(f.hub.fileState("slow.md"), null);
    release.resolve();
    await slow;
    assertEquals(Deno.readTextFileSync(`${f.vault}/slow.md`), "slow");
  } finally {
    release.resolve();
    await slow;
    await f.close();
    await server.shutdown();
  }
});

Deno.test("driver supervisor: failed native open retries in observed time with fresh Workers and honors advice", async () => {
  const f = fixture(
    `export function activate(ctx){ctx.driver.serve({open:()=>({state:'failed',error:{code:'rate_limited',retryAfterMs:20000,message:'retry'}}),discover(){},read(){},apply(){},close(){}})}`,
  );
  const Native = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = new Proxy(Native, {
    construct(target, args, newTarget) {
      constructions++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const a = await f.create();
    await f.key(a.id);
    await f.enable(a.id);
    assertEquals((await f.one(a.id)).status, "failed");
    assertEquals((await f.one(a.id)).nextRetry, 20000);
    f.scheduler.tick(19999);
    await f.supervisor.settle();
    assertEquals(constructions, 1);
    f.scheduler.tick(20001);
    await f.supervisor.settle();
    assertEquals(constructions, 2);
    assertEquals((await f.one(a.id)).error.code, "rate_limited");
  } finally {
    globalThis.Worker = Native;
    await f.close();
  }
});

Deno.test("driver supervisor: settings source reduction retires the driver at commit and admits same-code narrowed recovery", async () => {
  const f = fixture();
  try {
    const manifest = JSON.parse(
      Deno.readTextFileSync(`${f.dir}/manifest.json`),
    );
    manifest.runtime = { server: "service.js" };
    manifest.settings = [fixturePage];
    Deno.writeTextFileSync(`${f.dir}/manifest.json`, JSON.stringify(manifest));
    Deno.writeTextFileSync(
      `${f.dir}/service.js`,
      `export async function activate(ctx){const s=await ctx.settings.read();await ctx.permissions.declare({network:s.values.preferences.protect?['127.0.0.1:8123']:false,imports:false});}`,
    );
    const runtime = f.manager.configureRuntime({
      operational: () => true,
      writable: () => true,
      commit: (effect) => f.lifecycle.gate.run(effect),
    });
    await runtime.reconcile();
    await waitUntil(
      () =>
        runtime.status("test-driver")?.status === "ready"
          ? done()
          : pending(runtime.status("test-driver")),
      { label: "driver's service contributor ready" },
    );
    await f.approve();
    const instance = await f.create();
    await f.key(instance.id);
    await f.enable(instance.id);
    const oldSource = f.supervisor.ownerSources("test-driver")[0];
    assert(oldSource);
    const data = new PluginDataStore(f.config.statePath, {
      commit: (effect) => f.lifecycle.gate.run(effect),
      settingsSchema: (id) => f.manager.network.settingsSchema(id),
      settingsContext: (id) => f.manager.network.settingsContext(id),
      prepareSettingsCommit: (change) =>
        f.manager.network.prepareSettingsCommit(change),
    });
    const owner = data.forPlugin("test-driver");
    const page = validateSettingsPages([fixturePage])[0];
    const before = await owner.settings([page]);
    await owner.savePage(
      page,
      { message: "fixture", protect: false, limit: 5 },
      before.revision,
      before.sourceKey,
    );
    await waitUntil(async () => {
      const view = await f.one(instance.id);
      const source = f.supervisor.ownerSources("test-driver")[0];
      return view.status === "active" && source?.key !== oldSource.key
        ? done()
        : pending({ view, source });
    }, { label: "same-code driver recovery under new settings source" });
    const latest = await f.manager.network.policy("test-driver");
    assertEquals(latest.effective.network, []);
    assertEquals(f.supervisor.ownerSources("test-driver")[0], latest.source);
    await runtime.close();
  } finally {
    await f.manager.runtime?.close();
    await f.close();
  }
});

Deno.test("driver supervisor: narrowed recovery cannot borrow an unsettled service SDK expansion", async () => {
  let traffic = 0;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      traffic++;
      return new Response("native endpoint");
    },
  );
  const authority = `127.0.0.1:${(receiver.addr as Deno.NetAddr).port}`;
  const f = fixture(`export function activate(ctx){ctx.driver.serve({
    open:async()=>{try{await(await fetch('http://${authority}/')).text();return{state:'ready',endpoint:{id:'remote',epoch:'1'},scope:'all'}}catch(e){return{state:'locked',reason:e.name}}},
    discover:()=>({endpoint:{id:'remote',epoch:'1'},scope:'all',mode:'snapshot',entries:[],completion:'complete'}),read:()=>({state:'absent'}),apply:()=>[],close(){} });}`);
  const release = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const actual = f.manager.network.rpc.bind(f.manager.network);
  try {
    const manifest = JSON.parse(
      Deno.readTextFileSync(`${f.dir}/manifest.json`),
    );
    manifest.runtime = { server: "service.js" };
    manifest.settings = [fixturePage];
    Deno.writeTextFileSync(`${f.dir}/manifest.json`, JSON.stringify(manifest));
    Deno.writeTextFileSync(
      `${f.dir}/service.js`,
      `export async function activate(ctx){const s=await ctx.settings.read();await ctx.permissions.declare({network:s.values.preferences.protect?['${authority}']:false,imports:false});}`,
    );
    const runtime = f.manager.configureRuntime({
      operational: () => true,
      writable: () => true,
      commit: (effect) => f.lifecycle.gate.run(effect),
    });
    await runtime.reconcile();
    await waitUntil(
      () =>
        runtime.status("test-driver")?.status === "ready"
          ? done()
          : pending(runtime.status("test-driver")),
      { label: "source-ceiling service ready" },
    );
    await f.approve();
    const instance = await f.create();
    await f.key(instance.id);
    await f.enable(instance.id);
    assertEquals(traffic, 1);
    let held = false;
    f.manager.network.rpc = async (id, method, args, actor) => {
      const result = await actual(id, method, args, actor);
      if (
        !held && method === "permissions.declare" &&
        actor.source?.settingsRevision === 1
      ) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const capture = f.supervisor.captureSettingsRecovery.bind(f.supervisor);
    f.supervisor.captureSettingsRecovery = (id, desired) => {
      const recovery = capture(id, desired);
      return recovery
        ? {
          ...recovery,
          admit: async () => {
            // Force the service publication before driver admission, while its
            // transport receipt is still held. Both legal orderings need the ceiling.
            await entered.promise;
            await recovery.admit();
          },
        }
        : undefined;
    };
    const data = new PluginDataStore(f.config.statePath, {
      commit: (effect) => f.lifecycle.gate.run(effect),
      settingsSchema: (id) => f.manager.network.settingsSchema(id),
      settingsContext: (id) => f.manager.network.settingsContext(id),
      prepareSettingsCommit: (change) =>
        f.manager.network.prepareSettingsCommit(change),
    });
    const page = validateSettingsPages([fixturePage])[0];
    const owner = data.forPlugin("test-driver"),
      before = await owner.settings([page]);
    await owner.savePage(
      page,
      {
        message: "new source still requests remembered host",
        protect: true,
        limit: 5,
      },
      before.revision,
      before.sourceKey,
    );
    await entered.promise;
    await waitUntil(async () => {
      const row = await f.one(instance.id);
      return ["active", "locked"].includes(row.status) ? done() : pending(row);
    }, { label: "driver recovery settles while service SDK receipt is held" });
    assertEquals((await f.one(instance.id)).status, "locked");
    assertEquals((await f.one(instance.id)).reason, "NotCapable");
    assertEquals(traffic, 1);
    release.resolve();
    await waitUntil(async () => {
      const row = await f.one(instance.id);
      return row.status === "active" && traffic === 2
        ? done()
        : pending({ row, traffic });
    }, {
      label: "settled service expansion explicitly replaces narrowed driver",
    });
  } finally {
    release.resolve();
    f.manager.network.rpc = actual;
    await f.manager.runtime?.close();
    await f.close();
    await receiver.shutdown();
  }
});
