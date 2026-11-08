// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { MetadataProjection } from "../server/metadata/projection.ts";
import {
  METADATA_LIMITS,
  metadataBytes,
  type MetadataPage,
  metadataQuery,
} from "../server/metadata/contracts.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import {
  PluginRuntime,
  type RuntimeSource,
} from "../server/plugins/runtime.ts";
import { type InvocationOptions, PluginHost } from "../server/plugins/host.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { MetadataWatches } from "../server/metadata/service.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { ObservedClock } from "../server/observed_time.ts";
import { LivenessClock } from "./helpers/worker_liveness.ts";
import { readGrantCovers } from "../server/plugins/lifecycle.ts";

const service = `export function activate(ctx){
 const pages=[];let dispose=ctx.metadata.watch({},p=>{pages.push(p);});
 ctx.commands.register({id:'query',label:'Query',target:'server'},q=>ctx.metadata.query(q));
 ctx.commands.register({id:'get',label:'Get',target:'server'},p=>ctx.metadata.get(p));
 ctx.commands.register({id:'pages',label:'Pages',target:'server'},()=>pages);
 ctx.commands.register({id:'dispose',label:'Dispose',target:'server'},()=>{dispose();return pages.length;});
}`;
async function fixture(
  source = service,
  read = ["scope"],
  options: { changeLimit?: number; clock?: ObservedClock } = {},
) {
  const f = hubOperationsFixture({}, { changeLimit: options.changeLimit });
  Deno.mkdirSync(`${f.vault}/scope`);
  const dir = `${f.config.statePath}/plugins/meta`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}/manifest.json`,
    JSON.stringify({
      id: "meta",
      runtime: { server: "service.js" },
      capabilities: { read },
    }),
  );
  Deno.writeTextFileSync(`${dir}/service.js`, source);
  const projection = new MetadataProjection(f.hub, { clock: options.clock });
  const manifest = readManifest(dir),
    sources: RuntimeSource[] = [{
      id: "meta",
      enabled: true,
      manifest,
      hooks: [],
    }];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: f.vault,
    statePath: f.config.statePath,
    hub: f.hub,
    metadata: projection,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
    rpc: servicePluginRpc({
      vaultPath: f.vault,
      statePath: f.config.statePath,
      metadata: projection,
      actions: () => null,
    }),
  });
  await runtime.reconcile();
  return {
    ...f,
    projection,
    runtime,
    sources,
    manifest,
    async close() {
      await runtime.close();
      projection.stop();
      f.close();
    },
  };
}
Deno.test("metadata Worker: scoped get/query/watch without log declaration, current counts/pages and disposal/retirement", async () => {
  const f = await fixture();
  try {
    await pluginSettled(f.runtime, "meta", "ready");
    Deno.writeTextFileSync(`${f.vault}/private.md`, "# private marker");
    Deno.writeTextFileSync(
      `${f.vault}/scope/a.md`,
      "---\ntag: yes\n---\n# Title\n- [x] task\n[[Target]]\nkey:: value",
    );
    Deno.writeTextFileSync(`${f.vault}/scope/b.md`, "b");
    f.hub.scanNow();
    await waitUntil(async () => {
      const page = await f.runtime.invokeCommand("meta", "query", {
        limit: 1,
      }) as MetadataPage;
      return !page.catchingUp && page.rows.length === 1
        ? done(page)
        : pending(page);
    }, { label: "Worker scoped metadata" });
    const page = await f.runtime.invokeCommand("meta", "query", {
      limit: 1,
    }) as MetadataPage;
    assertEquals(page.total, 2);
    assertEquals(page.nextOffset, 1);
    assertEquals(page.rows[0].path, "scope/a.md");
    assert(!JSON.stringify(page).includes("private"));
    assertEquals(
      (await f.runtime.invokeCommand("meta", "query", {
        offset: 1,
        limit: 1,
      }) as MetadataPage).rows[0].path,
      "scope/b.md",
    );
    const note = await f.runtime.invokeCommand("meta", "get", "scope/a.md");
    assertEquals(note, page.rows[0]);
    await assertRejects(() =>
      f.runtime.invokeCommand("meta", "get", "private.md")
    );
    await assertRejects(() =>
      f.runtime.invokeCommand("meta", "get", "scope/../private.md")
    );
    await waitUntil(async () => {
      const pages = await f.runtime.invokeCommand(
        "meta",
        "pages",
        {},
      ) as MetadataPage[];
      return pages.some((p) => !p.catchingUp && p.total === 2)
        ? done()
        : pending(pages);
    }, { label: "Worker watch consumer" });
    const before = await f.runtime.invokeCommand("meta", "dispose", {});
    Deno.removeSync(`${f.vault}/scope/a.md`);
    f.hub.scanNow();
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "disposed watch projection caught up" },
    );
    assertEquals(
      (await f.runtime.invokeCommand("meta", "pages", {}) as unknown[]).length,
      before,
    );
    const changed = await f.runtime.invokeCommand(
      "meta",
      "query",
      {},
    ) as MetadataPage;
    assert(changed.revision !== page.revision);
    assertEquals(changed.rows.map((r) => r.path), ["scope/b.md"]);
    await f.runtime.retireOwner("meta", false, true);
    await assertRejects(() => f.runtime.invokeCommand("meta", "query", {}));
  } finally {
    await f.close();
  }
});
Deno.test("metadata contracts: strict structured queries and watch count enforced by host", async () => {
  for (
    const q of [
      { sql: "x" },
      { offset: -1 },
      { offset: null },
      { limit: null },
      new Date(),
      new Map(),
      { offset: 1.5 },
      { limit: 129 },
      { limit: 0 },
      { prefix: "../x" },
      { task: { checked: "yes" } },
      { task: { checked: true, extra: true } },
      { property: { key: "x", equals: 1 } },
    ]
  ) assertThrows(() => metadataQuery(q));
  const f = await fixture(
    `export function activate(ctx){for(let i=0;i<17;i++)ctx.metadata.watch({},()=>{});}`,
  );
  try {
    await pluginSettled(f.runtime, "meta", "failed");
  } finally {
    await f.close();
  }
});

Deno.test("metadata Worker: retention gap rebuild reaches get/query/watch without durable parsed storage", async () => {
  const scheduler = new LivenessClock(), clock = new ObservedClock(scheduler);
  const f = await fixture(service, ["vault"], { changeLimit: 3, clock });
  const drain = () =>
    waitUntil(() => {
      scheduler.tick(scheduler.time + 1, true);
      return !f.projection.catchingUp ? done() : pending(f.projection.cursor);
    }, { label: "Worker gap projection" });
  try {
    await pluginSettled(f.runtime, "meta", "ready");
    await drain();
    for (let i = 0; i < 6; i++) {
      Deno.writeTextFileSync(`${f.vault}/current.md`, `# current ${i}`);
      f.hub.scanNow();
    }
    assertEquals(
      (await f.runtime.invokeCommand("meta", "query", {}) as MetadataPage)
        .catchingUp,
      true,
    );
    await drain();
    const page = await f.runtime.invokeCommand(
      "meta",
      "query",
      {},
    ) as MetadataPage;
    assertEquals(page.cursor, 6);
    assertEquals(page.total, 1);
    assertEquals(page.rows[0].status, "ready");
    assertEquals(
      await f.runtime.invokeCommand("meta", "get", "current.md"),
      page.rows[0],
    );
    await waitUntil(async () => {
      const pages = await f.runtime.invokeCommand(
        "meta",
        "pages",
        {},
      ) as MetadataPage[];
      const last = pages.at(-1);
      return last && !last.catchingUp && last.cursor === 6
        ? done(last)
        : pending(pages);
    }, { label: "Worker watch after gap" });
    const rows =
      (await f.runtime.invokeCommand("meta", "pages", {}) as MetadataPage[]).at(
        -1,
      )!.rows;
    assertEquals(rows, page.rows);
    assert(rows[0].status === "ready");
    assertEquals(rows[0].headings[0].text, "current 5");
    assertEquals(f.hub.store.pluginCursorOwners(), []);
  } finally {
    await f.close();
  }
});
for (const retired of [false, true]) {
  Deno.test(`metadata transport: queued watch ${retired ? "cannot publish from a retired source" : "rebuilds after deletion and canonical grant narrowing"}`, async () => {
    const f = await fixture(service, ["read-alias"]);
    await f.runtime.close();
    // Separate real host to hold the ordinary FIFO at an exact RPC boundary.
    Deno.symlinkSync(f.vault, `${f.vault}/read-alias`);
    Deno.writeTextFileSync(`${f.vault}/secret.md`, "# secret parsed marker");
    f.hub.scanNow();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      queued = Promise.withResolvers<void>();
    const host = new PluginHost(
      f.manifest,
      f.vault,
      () => {
        entered.resolve();
        return release.promise;
      },
      1,
      { role: "service" },
    );
    let watches: MetadataWatches | undefined;
    let active = true;
    try {
      // Use an independent code entry with an explicit holding RPC.
      Deno.writeTextFileSync(
        `${f.manifest.dir}/service.js`,
        service.replace(
          "const pages=[];",
          "ctx.commands.register({id:'hold',label:'Hold',target:'server'},()=>ctx.files.read('hold'));const pages=[];",
        ),
      );
      await host.start();
      const handler = (id: string) =>
        [...host.registrations].find(([, r]) =>
          r.kind === "command" && r.id === id
        )![0];
      const held = host.invoke(handler("hold"), []);
      await entered.promise;
      const invoke = host.invoke.bind(host);
      host.invoke = (id, args, pre, timeout, options?: InvocationOptions) => {
        const result = invoke(id, args, pre, timeout, options);
        if (options?.prepareArgs) queued.resolve();
        return result;
      };
      watches = new MetadataWatches({
        projection: f.projection,
        manifest: f.manifest,
        host,
        current: () => active,
        failed: () => {},
      });
      await queued.promise;
      if (retired) {
        active = false;
        watches.stop();
      }
      Deno.removeSync(`${f.vault}/secret.md`);
      f.hub.scanNow();
      Deno.removeSync(`${f.vault}/read-alias`);
      Deno.symlinkSync(`${f.vault}/scope`, `${f.vault}/read-alias`);
      release.resolve();
      await held;
      const pages = await invoke(handler("pages"), []) as MetadataPage[];
      if (retired) {
        assertEquals(pages, []);
        return;
      }
      assert(pages.length > 0);
      assert(!JSON.stringify(pages).includes("secret"));
      assertEquals(pages[0].total, 0);
    } finally {
      release.resolve();
      watches?.stop();
      host.stop();
      await f.close();
    }
  });
}
Deno.test("metadata bounds: oversized parsed record is explicit unavailable; multi-record query remains <=1MiB", async () => {
  const f = await fixture(service, ["vault"]);
  try {
    await pluginSettled(f.runtime, "meta", "ready");
    Deno.writeTextFileSync(`${f.vault}/large.md`, "# " + "x".repeat(1100000));
    Deno.writeTextFileSync(`${f.vault}/one.md`, "# " + "a".repeat(600000));
    Deno.writeTextFileSync(`${f.vault}/two.md`, "# " + "b".repeat(600000));
    f.hub.scanNow();
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "bounded metadata ready" },
    );
    const record = await f.runtime.invokeCommand("meta", "get", "large.md") as {
      status: string;
      reason: string;
    };
    assertEquals([record.status, record.reason], [
      "unavailable",
      "record_too_large",
    ]);
    const page = await f.runtime.invokeCommand(
      "meta",
      "query",
      {},
    ) as MetadataPage;
    assert(metadataBytes(page) <= METADATA_LIMITS.bytes);
    assertEquals(page.total, 3);
    assertEquals(page.nextOffset, 2);
    const next = await f.runtime.invokeCommand("meta", "query", {
      offset: page.nextOffset,
    }) as MetadataPage;
    assertEquals(next.rows.map((r) => r.path), ["two.md"]);
  } finally {
    await f.close();
  }
});

Deno.test("metadata RPC: actual reply disclosure rechecks canonical grants after the service promise boundary", async () => {
  const f = await fixture(service, ["read-alias"]);
  await f.runtime.close();
  Deno.symlinkSync(f.vault, `${f.vault}/read-alias`);
  Deno.writeTextFileSync(`${f.vault}/private.md`, "# rpc private marker");
  f.hub.scanNow();
  const rpc = servicePluginRpc({
    vaultPath: f.vault,
    statePath: f.config.statePath,
    metadata: f.projection,
    actions: () => null,
  });
  let retarget = true;
  const host = new PluginHost(
    f.manifest,
    f.vault,
    (method, args, authority) => {
      const result = rpc(f.manifest, method, args, authority!);
      if (retarget) {
        retarget = false;
        Deno.removeSync(`${f.vault}/read-alias`);
        Deno.symlinkSync(`${f.vault}/scope`, `${f.vault}/read-alias`);
      }
      return result;
    },
    1,
    { role: "service" },
  );
  try {
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "RPC private metadata cached" },
    );
    await host.start();
    const handler = (id: string) =>
      [...host.registrations].find(([, r]) =>
        r.kind === "command" && r.id === id
      )![0];
    const page = await host.invoke(handler("query"), [{}]) as MetadataPage;
    assertEquals(page.total, 0);
    assert(!JSON.stringify(page).includes("private"));
    await assertRejects(() => host.invoke(handler("get"), ["private.md"]));
  } finally {
    host.stop();
    await f.close();
  }
});

Deno.test("metadata bounds: the complete grant-qualified revision participates in the combined page byte limit", async () => {
  const f = await fixture(service, ["vault"]);
  try {
    await pluginSettled(f.runtime, "meta", "ready");
    let length = 400000;
    Deno.writeTextFileSync(`${f.vault}/a.md`, "# " + "a".repeat(length));
    Deno.writeTextFileSync(`${f.vault}/b.md`, "# " + "b".repeat(length));
    f.hub.scanNow();
    const page = () =>
      f.runtime.invokeCommand("meta", "query", {}) as Promise<MetadataPage>;
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "byte-boundary records ready" },
    );
    length += METADATA_LIMITS.bytes - metadataBytes(await page()) + 1;
    Deno.writeTextFileSync(`${f.vault}/b.md`, "# " + "b".repeat(length));
    f.hub.scanNow();
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "byte-boundary revision ready" },
    );
    const result = await page();
    assert(metadataBytes(result) <= METADATA_LIMITS.bytes);
    assertEquals(result.nextOffset, 1);
  } finally {
    await f.close();
  }
});

Deno.test("metadata RPC: preparation and actual Worker post have no intervening microtask disclosure gap", async () => {
  const f = await fixture(service, ["read-alias"]);
  await f.runtime.close();
  Deno.symlinkSync(f.vault, `${f.vault}/read-alias`);
  Deno.writeTextFileSync(`${f.vault}/private.md`, "# private");
  f.hub.scanNow();
  const nativeWorker = globalThis.Worker;
  let observed = 0, violation = false;
  // Observe the real transport at its post boundary; never replace the Worker.
  globalThis.Worker = new Proxy(nativeWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget) as Worker;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: unknown) => {
        const packet = message as {
          type: string;
          ok?: boolean;
          value?: MetadataPage;
        };
        if (packet.type === "rpcResponse" && packet.ok && packet.value?.rows) {
          observed++;
          violation ||= packet.value.rows.some((row) =>
            !readGrantCovers(f.manifest, f.vault, f.config.statePath, row.path)
          );
        }
        post(message);
      };
      return worker;
    },
  });
  const rpc = servicePluginRpc({
    vaultPath: f.vault,
    statePath: f.config.statePath,
    metadata: f.projection,
    actions: () => null,
  });
  const host = new PluginHost(
    f.manifest,
    f.vault,
    (method, args, authority) => {
      const disclose = authority!.disclose!;
      authority!.disclose = (prepare) =>
        disclose(() => {
          const value = prepare();
          queueMicrotask(() => {
            Deno.removeSync(`${f.vault}/read-alias`);
            Deno.symlinkSync(`${f.vault}/scope`, `${f.vault}/read-alias`);
          });
          return value;
        });
      return rpc(f.manifest, method, args, authority!);
    },
    1,
    { role: "service" },
  );
  try {
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "microtask fixture metadata cached" },
    );
    await host.start();
    globalThis.Worker = nativeWorker;
    const handler = [...host.registrations].find(([, r]) =>
      r.kind === "command" && r.id === "query"
    )![0];
    const result = await host.invoke(handler, [{}]) as MetadataPage;
    assertEquals(
      result.rows.map((row) =>
        row.path
      ),
      ["private.md"],
    );
    assertEquals(observed, 1);
    assertEquals(violation, false);
  } finally {
    globalThis.Worker = nativeWorker;
    host.stop();
    await f.close();
  }
});

Deno.test("metadata watch: real Worker failures retry under observed backoff, then disposal fences later invalidations", async () => {
  const f = await fixture(
    `export function activate(ctx){let attempts=0;const pages=[];
 const release=ctx.metadata.watch({},page=>{attempts++;if(attempts===1)throw Error('failed');pages.push(page);});
 ctx.commands.register({id:'dump',label:'Dump',target:'server'},()=>({attempts,pages}));
 ctx.commands.register({id:'dispose',label:'Dispose',target:'server'},()=>release());
 }`,
    ["vault"],
  );
  await f.runtime.close();
  const host = new PluginHost(
    f.manifest,
    f.vault,
    () => Promise.reject(Error("unexpected RPC")),
    1,
    { role: "service" },
  );
  const scheduler = new LivenessClock(), clock = new ObservedClock(scheduler);
  let failures = 0;
  let watches: MetadataWatches | undefined;
  try {
    await host.start();
    await waitUntil(
      () => !f.projection.catchingUp ? done() : pending(f.projection.cursor),
      { label: "retry fixture projection" },
    );
    watches = new MetadataWatches({
      projection: f.projection,
      manifest: f.manifest,
      host,
      current: () => true,
      clock,
      failed: () => {
        failures++;
      },
    });
    const handler = (id: string) =>
      [...host.registrations].find(([, r]) =>
        r.kind === "command" && r.id === id
      )![0];
    scheduler.tick(1, true);
    await waitUntil(() => failures === 1 ? done() : pending(failures), {
      label: "watch failure observed",
    });
    const dump = () =>
      host.invoke(handler("dump"), []) as Promise<
        { attempts: number; pages: MetadataPage[] }
      >;
    assertEquals((await dump()).attempts, 1);
    scheduler.tick(5000, true);
    assertEquals((await dump()).attempts, 1);
    scheduler.tick(5001, true);
    await waitUntil(async () => {
      const value = await dump();
      return value.attempts === 2 ? done() : pending(value);
    }, { label: "retried Worker watch consumer" });
    assertEquals((await dump()).pages.length, 1);
    await host.invoke(handler("dispose"), []);
    watches.sync();
    Deno.writeTextFileSync(`${f.vault}/after.md`, "# after disposal");
    f.hub.scanNow();
    scheduler.tick(10001, true);
    assertEquals((await dump()).attempts, 2);
  } finally {
    watches?.stop();
    host.stop();
    await f.close();
  }
});
