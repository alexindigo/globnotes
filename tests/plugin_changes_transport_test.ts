// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type InvocationOptions, PluginHost } from "../server/plugins/host.ts";
import { followPluginChanges } from "../server/plugins/changes.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import {
  PluginRuntime,
  type RuntimeSource,
} from "../server/plugins/runtime.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import type { LogFollower } from "../server/hub/follower.ts";
import type { ChangePacket } from "../server/plugins/change_contract.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

for (
  const [mode, narrow] of [["snapshot", false], ["changes", false], [
    "changes",
    true,
  ]] as const
) {
  Deno.test(`changes transport: actual ordinary Worker FIFO rechecks queued ${mode} after ${narrow ? "canonical grant narrowing" : "delete"}`, async () => {
    const f = await hubOperationsFixture();
    const p = await pluginFixture();
    const dir = await p.install("queued", {
      runtime: { server: "service.js" },
      changes: { apiVersion: 1 },
      capabilities: { read: ["read-alias"] },
    }, {
      "service.js": `export function activate(ctx) {
      const packets=[];
      ctx.changes.subscribe(packet=>{packets.push(packet);return {ack:packet.token};});
      ctx.commands.register({id:'hold',label:'Hold',target:'server'},()=>ctx.files.read('hold'));
      ctx.commands.register({id:'dump',label:'Dump',target:'server'},()=>packets);
    }`,
    });
    Deno.symlinkSync(f.vault, `${f.vault}/read-alias`);
    Deno.writeTextFileSync(
      `${f.vault}/private-deleted-marker.md`,
      "private body marker",
    );
    f.hub.scanNow();
    const hold = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const host = new PluginHost(
      readManifest(dir),
      f.vault,
      (method) => {
        assertEquals(method, "files.read");
        entered.resolve();
        return hold.promise;
      },
      1,
      { role: "service" },
    );
    let follower: LogFollower | undefined;
    let held: Promise<unknown> | undefined;
    try {
      await host.start();
      const handler = (id: string) =>
        [...host.registrations].find(([, r]) => r.id === id)![0];
      const invoke = host.invoke.bind(host);
      host.invoke = (id, args, pre, timeout, options?: InvocationOptions) => {
        const packet = options?.prepareArgs?.()[0] as ChangePacket | undefined;
        const result = invoke(id, args, pre, timeout, options);
        if (packet?.type === mode) queued.resolve();
        if (mode === "snapshot" && packet?.type === "gap") {
          return result.then(async (value) => {
            held = invoke(handler("hold"), []);
            await entered.promise;
            return value;
          });
        }
        return result;
      };
      follower = followPluginChanges({
        manifest: readManifest(dir),
        hub: f.hub,
        host,
        current: () => true,
        changed: () => {},
      });
      if (mode === "changes") {
        await waitUntil(
          () =>
            f.hub.store.pluginCursor("queued")?.seq === 1
              ? done()
              : pending(follower!.status),
          { label: "initial snapshot ack" },
        );
        held = invoke(handler("hold"), []);
        await entered.promise;
        Deno.writeTextFileSync(
          `${f.vault}/private-deleted-marker.md`,
          "changed body",
        );
        f.hub.scanNow();
      }
      await queued.promise;
      if (narrow) {
        Deno.mkdirSync(`${f.vault}/narrow`);
        Deno.removeSync(`${f.vault}/read-alias`);
        Deno.symlinkSync(`${f.vault}/narrow`, `${f.vault}/read-alias`);
      } else {
        Deno.removeSync(`${f.vault}/private-deleted-marker.md`);
        f.hub.scanNow();
      }
      hold.resolve();
      await held;
      if (narrow) {
        await waitUntil(
          () => follower!.status.lastError ? done() : pending(follower!.status),
          { label: "changed read authority rejects queued disclosure" },
        );
        const packets = await invoke(handler("dump"), []) as ChangePacket[];
        assertEquals(packets.filter((packet) => packet.type === "changes"), []);
        assertEquals(f.hub.store.pluginCursor("queued")?.seq, 1);
        return;
      }
      await waitUntil(
        () =>
          f.hub.store.pluginCursor("queued")?.seq === f.hub.sequence()
            ? done()
            : pending(follower!.status),
        { label: "scrubbed queued delivery ack" },
      );
      const packets = await invoke(handler("dump"), []) as ChangePacket[];
      const packet = packets.find((packet) => packet.type === mode)!;
      assert(packet);
      assert(!JSON.stringify(packet).includes("private-deleted-marker"));
      assert(!JSON.stringify(packet).includes("body marker"));
      if (packet.type === "snapshot") assertEquals(packet.entries, []);
      else if (packet.type === "changes") {
        assertEquals(packet.entries[0].path, null);
        assert(packet.entries[0].pathKey.length > 0);
      }
    } finally {
      hold.resolve();
      follower?.stop();
      host.stop();
      await p.dispose();
      await f.close();
    }
  });
}

Deno.test("log example: persistence before lost host ack deduplicates replay; retention reset rebuilds current state", async () => {
  const f = await hubOperationsFixture({}, { changeLimit: 3 });
  const root = new URL(
    "./fixtures/plugins/globnotes-log-example/",
    import.meta.url,
  );
  const dir = `${f.config.statePath}/plugins/globnotes-log-example`;
  Deno.mkdirSync(dir, { recursive: true });
  for (const name of ["manifest.json", "service.js"]) {
    Deno.copyFileSync(new URL(name, root), `${dir}/${name}`);
  }
  const manifest = readManifest(dir);
  const sources: RuntimeSource[] = [{
    id: manifest.id,
    enabled: true,
    manifest,
    hooks: [],
  }];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: f.vault,
    statePath: f.config.statePath,
    hub: f.hub,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
    rpc: servicePluginRpc({
      vaultPath: f.vault,
      statePath: f.config.statePath,
      actions: () => null,
    }),
  });
  const store = new PluginDataStore(f.config.statePath, {
    commit: (effect) => effect(),
  }).forPlugin(manifest.id);
  const waitCursor = (seq: number) =>
    waitUntil(
      () =>
        f.hub.store.pluginCursor(manifest.id)?.seq === seq
          ? done()
          : pending(runtime.status(manifest.id)),
      { label: "example durable cursor" },
    );
  const invoke = PluginHost.prototype.invoke;
  const retired = Promise.withResolvers<void>();
  let drop = false;
  try {
    await runtime.reconcile();
    await pluginSettled(runtime, manifest.id, "ready");
    await waitCursor(0);
    const generation = runtime.status(manifest.id)?.generation;
    assert(generation);
    PluginHost.prototype.invoke = function (id, args, pre, timeout, options) {
      return invoke.call(this, id, args, pre, timeout, options).then(
        (value) => {
          if (drop && options?.prepareArgs) {
            drop = false;
            // This boundary is after real Worker JSON persistence and before
            // its reply reaches the follower. Retirement fences the late ack.
            retired.resolve(runtime.retireOwner(manifest.id, false, true));
          }
          return value;
        },
      ).catch((error) => {
        retired.reject(error);
        throw error;
      });
    };
    drop = true;
    Deno.writeTextFileSync(`${f.vault}/once.md`, "once");
    f.hub.scanNow();
    // JSON publication precedes the Worker reply. It cannot establish that
    // the lost-ack callback retired the old owner. The invocation's own
    // outcome/deadline settles this milestone, including rejection.
    await retired.promise;
    assertEquals((await store.load()).values.cursor, 1);
    assertEquals(runtime.status(manifest.id)?.status, "disabled");
    assertEquals(f.hub.store.pluginCursor(manifest.id)?.seq, 0);
    PluginHost.prototype.invoke = invoke;
    await runtime.reconcile();
    await pluginSettled(runtime, manifest.id, "ready");
    assert(runtime.status(manifest.id)?.generation !== generation);
    await waitCursor(1);
    let values = (await store.load()).values;
    assertEquals((values.facts as unknown[]).length, 1);
    await runtime.retireOwner(manifest.id, false, true);
    for (let i = 0; i < 6; i++) {
      Deno.writeTextFileSync(`${f.vault}/${i}.md`, `${i}`);
      f.hub.scanNow();
    }
    await runtime.reconcile();
    await pluginSettled(runtime, manifest.id, "ready");
    await waitCursor(7);
    values = (await store.load()).values;
    assertEquals(values.reason, "retention");
    assertEquals(Object.keys(values.rows as object).length, 7);
    assertEquals(values.staged, {});
    for (
      const row of Object.values(
        values.rows as Record<string, { path: string; body: string }>,
      )
    ) assertEquals(row.body, Deno.readTextFileSync(`${f.vault}/${row.path}`));
  } finally {
    PluginHost.prototype.invoke = invoke;
    await runtime.close();
    await f.close();
  }
});

async function multipartExample(
  forgeAcknowledgement = false,
  closed: (root: string) => void = () => {},
) {
  const f = await hubOperationsFixture();
  const root = new URL(
    "./fixtures/plugins/globnotes-log-example/",
    import.meta.url,
  );
  const dir = `${f.config.statePath}/plugins/globnotes-log-example`;
  Deno.mkdirSync(dir, { recursive: true });
  for (const file of ["manifest.json", "service.js"]) {
    Deno.copyFileSync(new URL(file, root), `${dir}/${file}`);
  }
  const manifest = readManifest(dir);
  const sources: RuntimeSource[] = [{
    id: manifest.id,
    enabled: true,
    manifest,
    hooks: [],
  }];
  const retired = Promise.withResolvers<void>();
  const failedDelivery = Promise.withResolvers<void>();
  let retirementFailure: unknown;
  retired.promise.catch((error) => {
    retirementFailure = error;
  });
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: f.vault,
    statePath: f.config.statePath,
    hub: f.hub,
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
    changed: () => {
      // Ack validation happens after invocation fulfillment. Observe the
      // follower's failure notification, not its unbounded retry loop.
      const failure = runtime.status(manifest.id)?.changes?.lastError;
      if (failure) {
        retired.reject(new Error(`multipart retirement: ${failure}`));
        failedDelivery.resolve();
      }
    },
    rpc: servicePluginRpc({
      vaultPath: f.vault,
      statePath: f.config.statePath,
      actions: () => null,
    }),
  });
  const store = new PluginDataStore(f.config.statePath, {
    commit: (effect) => effect(),
  }).forPlugin(manifest.id);
  const advance = f.hub.store.advancePluginCursor.bind(f.hub.store);
  const invoke = PluginHost.prototype.invoke;
  try {
    await runtime.reconcile();
    await pluginSettled(runtime, manifest.id, "ready");
    await waitUntil(
      () =>
        f.hub.store.pluginCursor(manifest.id)?.seq === 0
          ? done()
          : pending(runtime.status(manifest.id)),
      { label: "multipart example initial snapshot" },
    );
    const generation = runtime.status(manifest.id)?.generation;
    assert(generation);
    // Publication retires the owner on success; the same delivery's native
    // rejection/deadline must fail the milestone instead of waiting forever.
    PluginHost.prototype.invoke = function (id, args, pre, timeout, options) {
      return invoke.call(this, id, args, pre, timeout, options).then(
        (value) =>
          forgeAcknowledgement && options?.prepareArgs
            ? { ack: "forged" }
            : value,
      ).catch(
        (error) => {
          retired.reject(error);
          throw error;
        },
      );
    };
    f.hub.store.advancePluginCursor = (plugin, expected, next) => {
      try {
        assertEquals(next.seq, 128);
        const accepted = advance(plugin, expected, next);
        assert(accepted, "multipart cursor publication rejected");
        retired.resolve(runtime.retireOwner(manifest.id, false, true));
        return accepted;
      } catch (error) {
        retired.reject(error);
        throw error;
      }
    };
    for (let i = 0; i < 130; i++) {
      Deno.writeTextFileSync(`${f.vault}/${i}.md`, `member ${i}`);
    }
    f.hub.scanNow();
    if (forgeAcknowledgement) {
      await Promise.race([failedDelivery.promise, retired.promise]);
      assert(
        retirementFailure instanceof Error,
        "retirement milestone did not reject on the first follower failure",
      );
      assertEquals(
        retirementFailure.message,
        "multipart retirement: changes_delivery_failed",
      );
    }
    await retired.promise;
    assertEquals(runtime.status(manifest.id)?.status, "disabled");
    let values = (await store.load()).values;
    assertEquals(Object.keys(values.rows as object).length, 0);
    assertEquals(Object.keys(values.staged as object).length, 1);
    assertEquals(f.hub.store.pluginCursor(manifest.id)?.seq, 128);
    f.hub.store.advancePluginCursor = advance;
    PluginHost.prototype.invoke = invoke;
    await runtime.reconcile();
    await pluginSettled(runtime, manifest.id, "ready");
    assert(runtime.status(manifest.id)?.generation !== generation);
    await waitUntil(
      () =>
        f.hub.store.pluginCursor(manifest.id)?.seq === 130
          ? done()
          : pending(runtime.status(manifest.id)),
      { label: "multipart tail acknowledged" },
    );
    values = (await store.load()).values;
    assertEquals(Object.keys(values.rows as object).length, 130);
    assertEquals(values.staged, {});
    assertEquals((values.facts as unknown[]).length, 130);
    for (
      const row of Object.values(
        values.rows as Record<string, { path: string; body: string }>,
      )
    ) assertEquals(row.body, Deno.readTextFileSync(`${f.vault}/${row.path}`));
  } finally {
    f.hub.store.advancePluginCursor = advance;
    PluginHost.prototype.invoke = invoke;
    await runtime.close();
    await f.close();
    closed(f.root);
  }
}

Deno.test("log example: a multipart batch persists staging before ack and a new Worker publishes the complete group only after its tail", () =>
  multipartExample());

Deno.test("log example: forged multipart acknowledgement fails retirement on the first follower failure and cleans up", async () => {
  const invoke = PluginHost.prototype.invoke;
  let cleaned = false;
  await assertRejects(
    () =>
      multipartExample(true, (root) => {
        assertEquals(PluginHost.prototype.invoke, invoke);
        assertThrows(() => Deno.statSync(root), Deno.errors.NotFound);
        cleaned = true;
        console.log(JSON.stringify({ forgedAckCleanup: true }));
      }),
    Error,
    "multipart retirement: changes_delivery_failed",
  );
  assert(cleaned);
});
