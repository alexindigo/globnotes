// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DriverWorker, PluginRuntime } from "../server/plugins/runtime.ts";
import { DriverContractError } from "../server/plugins/driver_contract.ts";
import { driverFixture, minimalDriver } from "./helpers/driver_fixture.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

Deno.test("drivers: hook dispatch never sees a partial roster while a driver-only inventory reconciles", async () => {
  const fixture = await driverFixture();
  const runtime = new PluginRuntime(() => [
    { id: "disabled-first", enabled: false, hooks: [] },
    {
      id: fixture.manifest.id,
      enabled: true,
      hooks: [],
      manifest: fixture.manifest,
    },
  ], {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
  });
  try {
    const reconciling = runtime.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    runtime.post("on-sync", { initial: false });
    await reconciling;
    runtime.post("on-sync", { initial: false });
    assertEquals(runtime.status(fixture.manifest.id)?.status, "ready");
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});

Deno.test("drivers: real instance Workers get only their own immutable settings and keys", async () => {
  const source = `export function activate(ctx) {
    const expected = ['createUuid','driver','instance','register','secrets','timers'].sort();
    if (JSON.stringify(Object.keys(ctx).sort()) !== JSON.stringify(expected)) throw Error('excess facade');
    if (!Object.isFrozen(ctx.instance) || !Object.isFrozen(ctx.instance.settings)) throw Error('mutable instance');
    let denied = 0;
    const check = async fn => {try {await fn();} catch {denied++;}};
    ctx.driver.serve({
      async open() {
        await check(()=>Deno.readTextFile(ctx.instance.settings.vaultFile));
        await check(()=>Deno.writeTextFile(ctx.instance.settings.vaultFile,'must not write'));
        await check(()=>Deno.env.get('HOME'));
        await check(()=>ctx.secrets.get('other'));
        if (denied !== 4) throw Error('sandbox failed');
        const key = await ctx.secrets.get('token');
        if (key !== ctx.instance.settings.expectedKey) throw Error('wrong key');
        await ctx.driver.hint();
        return {state:'ready',endpoint:{id:ctx.instance.id,epoch:'1'},scope:'all'};
      },
      discover: () => ({endpoint:{id:ctx.instance.id,epoch:'1'},scope:'all',mode:'snapshot',entries:[],completion:'complete'}),
      read: () => ({state:'absent'}),
      apply: items => items.map(item=>({id:item.id,state:'settled',revision:'opaque'})),
      close() {},
    });
  }`;
  const fixture = await driverFixture(source);
  const vaultFile = `${fixture.vault}/A.md`;
  await Deno.writeTextFile(vaultFile, "original");
  let hints = 0;
  const lookups: string[] = [];
  const instances = ["one", "two"].map((id) =>
    new DriverWorker(
      fixture.manifest,
      {
        id,
        label: id,
        settings: { vaultFile, expectedKey: `${id}-key` },
      },
      fixture.vault,
      {
        current: () => true,
        secret: (key) => {
          lookups.push(`${id}:${key}`);
          return `${id}-key`;
        },
        hint: () => {
          hints++;
        },
      },
    )
  );
  try {
    await Promise.all(instances.map((worker) => worker.start()));
    assert(instances[0].host.generation !== instances[1].host.generation);
    const results = await Promise.all(
      instances.map((worker) =>
        Promise.all([worker.open(), worker.open()]).then(([result]) => result)
      ),
    );
    assertEquals(
      results.map((result) => result.state === "ready" && result.endpoint.id),
      ["one", "two"],
    );
    assertEquals(lookups.sort(), ["one:token", "two:token"]);
    assertEquals(hints, 2);
    assertEquals(await Deno.readTextFile(vaultFile), "original");
    for (const worker of instances) {
      assertEquals((await worker.discover({ mode: "snapshot" })).entries, []);
      assertEquals(await worker.read({ path: "A.md", revision: "r" }), {
        state: "absent",
      });
    }
  } finally {
    await Promise.all(instances.map((worker) => worker.close()));
    await fixture.dispose();
  }
});

Deno.test("drivers: real Worker malformed pages fail closed and retire only that instance", async () => {
  const fixture = await driverFixture(
    minimalDriver.replace(
      "entries:[]",
      "entries:[{state:'known',path:'../escape',revision:'r'}]",
    ),
  );
  const failures: string[] = [];
  const worker = new DriverWorker(
    fixture.manifest,
    { id: "one", label: "One", settings: {} },
    fixture.vault,
    {
      current: () => true,
      secret: () => "key",
      hint() {},
      failed: (detail) => failures.push(detail),
    },
  );
  try {
    await worker.start();
    await worker.open();
    await assertRejects(
      () => worker.discover({ mode: "snapshot" }),
      DriverContractError,
    );
    assertEquals(worker.host.available, false);
    assertEquals(failures, ["driver_contract_violation"]);
    assertEquals([...Deno.readDirSync(fixture.vault)], []);
  } finally {
    worker.stop();
    await fixture.dispose();
  }
});

Deno.test("drivers: late secret replies cannot cross configuration retirement", async () => {
  const fixture = await driverFixture(
    minimalDriver.replace(
      "open: () =>",
      "open: async () => (await ctx.secrets.get('token'),",
    ).replace("scope:'all' }),", "scope:'all' })),"),
  );
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<string>();
  let current = true;
  const worker = new DriverWorker(
    fixture.manifest,
    { id: "one", label: "One", settings: {} },
    fixture.vault,
    {
      current: () => current,
      secret: () => {
        reached.resolve();
        return release.promise;
      },
      hint() {},
    },
  );
  try {
    await worker.start();
    const opening = worker.open().catch((error) => error);
    await reached.promise;
    current = false;
    worker.stop();
    release.resolve("never-delivered");
    assert(await opening instanceof Error);
    assertEquals(worker.host.available, false);
  } finally {
    release.resolve("never-delivered");
    worker.stop();
    await fixture.dispose();
  }
});

Deno.test("drivers: apply lost reply is uncertain and read deadline is unknown, not absence", async () => {
  const fixture = await driverFixture(
    minimalDriver.replace(
      "read: () => ({state:'absent'})",
      "read: () => new Promise(()=>{})",
    ).replace(
      "apply: (items) => items.map(item => ({id:item.id,state:'settled',...(item.op==='put'?{revision:'receipt'}:{})}))",
      "apply: () => new Promise(()=>{})",
    ),
  );
  const make = (id: string) =>
    new DriverWorker(
      fixture.manifest,
      { id, label: id, settings: {} },
      fixture.vault,
      {
        current: () => true,
        secret: () => "key",
        hint() {},
        deadlines: { apply: 30, read: 30 },
      },
    );
  const writer = make("writer"), reader = make("reader");
  try {
    await Promise.all([writer.start(), reader.start()]);
    await Promise.all([writer.open(), reader.open()]);
    assertEquals(
      await writer.apply([{
        id: "put",
        op: "put",
        path: "A.md",
        batch: 1,
        bytes: new Uint8Array([1]),
        base: { absent: true },
      }]),
      [{ id: "put", state: "uncertain" }],
    );
    assertEquals(writer.host.available, false);
    assertEquals(reader.host.available, true);
    assertEquals(await reader.read({ path: "A.md", revision: "r" }), {
      state: "unknown",
      reason: "driver_read_unavailable",
    });
  } finally {
    writer.stop();
    reader.stop();
    await fixture.dispose();
  }
});

Deno.test("drivers: heartbeat-stuck instance fails alone while another instance stays callable", async () => {
  const source = minimalDriver.replace(
    "open: () => ({",
    "open: () => {if(ctx.instance.settings.hang) {while(true) {}} return ({",
  ).replace("scope:'all' }),", "scope:'all' });},");
  const fixture = await driverFixture(source);
  const failures: string[] = [];
  const make = (id: string, hang: boolean) =>
    new DriverWorker(
      fixture.manifest,
      { id, label: id, settings: { hang } },
      fixture.vault,
      {
        current: () => true,
        secret: () => "key",
        hint() {},
        failed: () => failures.push(id),
      },
    );
  const stuck = make("stuck", true), healthy = make("healthy", false);
  try {
    await Promise.all([stuck.start(), healthy.start()]);
    const opening = stuck.open().catch((error) => error);
    assertEquals((await healthy.open()).state, "ready");
    await waitUntil(
      () => stuck.host.available ? pending("heartbeat running") : done(),
      { label: "hung driver Worker retired" },
    );
    assert(await opening instanceof Error);
    assertEquals(
      (await healthy.discover({ mode: "snapshot" })).completion,
      "complete",
    );
    assertEquals(failures, ["stuck"]);
  } finally {
    stuck.stop();
    healthy.stop();
    await fixture.dispose();
  }
});

Deno.test("drivers: activation cannot register application handlers or omit lifecycle methods", async () => {
  for (
    const source of [
      "export function activate(ctx) {ctx.hooks.on('on-save',()=>{});}",
      "export function activate(ctx) {}",
      minimalDriver.replace("close() {},", ""),
      minimalDriver.replace(
        "ctx.driver.serve({",
        "ctx.driver.serve({peer:'other',",
      ),
    ]
  ) {
    const fixture = await driverFixture(source);
    const worker = new DriverWorker(
      fixture.manifest,
      { id: "one", label: "One", settings: {} },
      fixture.vault,
      {
        current: () => true,
        secret: () => "key",
        hint() {},
      },
    );
    try {
      await assertRejects(() => worker.start());
      assertEquals(worker.host.available, false);
    } finally {
      worker.stop();
      await fixture.dispose();
    }
  }
});

Deno.test("drivers: asynchronous exceptions and console text do not expose a key in Worker logs", async () => {
  const marker = "m5-runtime-secret-canary-42";
  const source = minimalDriver.replace(
    "open: () => ({ state: 'ready', endpoint: {id:'memory',epoch:'1'}, scope:'all' })",
    `open: async () => {
    const key = await ctx.secrets.get('token');
    console.log(key); console.error(key);
    setTimeout(() => {throw Error(key)}, 0);
    return new Promise(()=>{});
  }`,
  );
  const fixture = await driverFixture(source);
  const failures: string[] = [];
  const worker = new DriverWorker(
    fixture.manifest,
    { id: "one", label: "One", settings: {} },
    fixture.vault,
    {
      current: () => true,
      secret: () => marker,
      hint() {},
      failed: (detail) => failures.push(detail),
    },
  );
  try {
    await worker.start();
    await assertRejects(() => worker.open(), Error, "driver activation failed");
    assertEquals(failures, ["driver Worker failed; in-flight outcome unknown"]);
  } finally {
    worker.stop();
    await fixture.dispose();
  }
  // The proving run also checks the captured workload log for marker absence.
});

Deno.test("drivers: locked open cannot admit reads or endpoint writes", async () => {
  const fixture = await driverFixture(
    minimalDriver.replace(
      "({ state: 'ready', endpoint: {id:'memory',epoch:'1'}, scope:'all' })",
      "({state:'locked',reason:'needs key'})",
    ),
  );
  const worker = new DriverWorker(
    fixture.manifest,
    { id: "one", label: "One", settings: {} },
    fixture.vault,
    {
      current: () => true,
      secret: () => null,
      hint() {},
    },
  );
  try {
    await worker.start();
    assertEquals((await worker.open()).state, "locked");
    await assertRejects(
      () => worker.read({ path: "A.md", revision: "r" }),
      Error,
      "endpoint is not ready",
    );
    await assertRejects(
      () =>
        worker.apply([{
          id: "1",
          op: "put",
          path: "A.md",
          batch: 1,
          bytes: new Uint8Array([1]),
          base: { absent: true },
        }]),
      Error,
      "endpoint is not ready",
    );
  } finally {
    await worker.close();
    await fixture.dispose();
  }
});

Deno.test("drivers: a storage provider cannot silently emulate a condition the manifest promises is native", async () => {
  const fixture = await driverFixture(`export function activate(ctx) {
    ctx.driver.serve(ctx.driver.storage({
      conditions:{create:false,update:false,delete:false},
      identity:async()=>({id:'store',epoch:'1'}), list:async()=>({entries:[]}),
      get:async()=>({bytes:new Uint8Array(),etag:'r'}),
      put:async()=>({etag:'r'}), delete:async()=>{},
    }));
  }`);
  const worker = new DriverWorker(
    fixture.manifest,
    { id: "one", label: "One", settings: {} },
    fixture.vault,
    {
      current: () => true,
      secret: () => null,
      hint() {},
    },
  );
  try {
    await assertRejects(() => worker.start());
    assertEquals(worker.host.available, false);
  } finally {
    worker.stop();
    await fixture.dispose();
  }
});
