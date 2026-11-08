// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { readManifest } from "../server/plugins/manifest.ts";
import {
  PluginRuntime,
  type RuntimeSource,
} from "../server/plugins/runtime.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { changesAuthority } from "../server/plugins/changes.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";

async function fixture(
  source: string,
  changes: unknown = { apiVersion: 1 },
  read = ["vault"],
  policy: { writable?: boolean; operational?: boolean } = {},
) {
  const f = hubOperationsFixture();
  const dir = `${f.config.statePath}/plugins/test`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}/manifest.json`,
    JSON.stringify({
      id: "test",
      runtime: { server: "service.js" },
      ...(changes === null ? {} : { changes }),
      capabilities: { read },
    }),
  );
  Deno.writeTextFileSync(`${dir}/service.js`, source);
  const manifest = readManifest(dir);
  const sources: RuntimeSource[] = [{
    id: "test",
    enabled: true,
    manifest,
    hooks: [],
  }];
  const runtime = new PluginRuntime(() => sources, {
    vaultPath: f.vault,
    statePath: f.config.statePath,
    hub: f.hub,
    operational: () => policy.operational !== false,
    writable: () => policy.writable !== false,
    commit: (effect) => effect(),
    rpc: servicePluginRpc({
      vaultPath: f.vault,
      statePath: f.config.statePath,
      actions: () => null,
    }),
  });
  const data = new PluginDataStore(f.config.statePath, {
    commit: (effect) => effect(),
  }).forPlugin("test");
  await runtime.reconcile();
  return {
    ...f,
    runtime,
    manifest,
    sources,
    data,
    async close() {
      await runtime.close();
      f.close();
    },
  };
}
const observer = `export function activate(ctx) {
  ctx.changes.subscribe(async packet => {
    const old = await ctx.data.load();
    await ctx.data.save({packets:[...(old.values.packets??[]),packet], frozen:Object.isFrozen(packet)}, old.revision);
    return {ack:packet.token};
  });
}`;

Deno.test("changes Worker: strict declaration and exactly one pre-ready registration", async () => {
  for (
    const [source, declaration, read] of [
      [observer, null, ["vault"]],
      ["export function activate() {}", { apiVersion: 1 }, ["vault"]],
      [
        observer.replace(
          "ctx.changes.subscribe",
          "ctx.changes.subscribe(()=>{});ctx.changes.subscribe",
        ),
        { apiVersion: 1 },
        ["vault"],
      ],
      [observer, { apiVersion: 1 }, ["narrow"]],
    ] as const
  ) {
    const f = await fixture(source, declaration, [...read]);
    try {
      await pluginSettled(f.runtime, "test", "failed");
      assertEquals(f.hub.store.pluginCursor("test"), null);
      if (read[0] === "narrow") {
        assert(
          f.runtime.status("test")!.diagnostics.some((d) =>
            d.code === "changes_read_grant_required"
          ),
        );
      }
    } finally {
      await f.close();
    }
  }
  const f = await fixture(observer);
  try {
    for (
      const value of [
        { apiVersion: 2 },
        {},
        { apiVersion: 1, extra: true },
        null,
      ]
    ) {
      const file = `${f.manifest.dir}/manifest.json`;
      const original = JSON.parse(Deno.readTextFileSync(file));
      Deno.writeTextFileSync(
        file,
        JSON.stringify({ ...original, changes: value }),
      );
      assertThrows(() => readManifest(f.manifest.dir));
    }
  } finally {
    await f.close();
  }
});

Deno.test("changes Worker: persists immutable snapshot/replay, resumes cursor, retires and removes only uninstalled cursor", async () => {
  const f = await fixture(observer);
  try {
    await pluginSettled(f.runtime, "test", "ready");
    const waitCursor = (seq: number) =>
      waitUntil(
        () =>
          f.hub.store.pluginCursor("test")?.seq === seq
            ? done()
            : pending(f.runtime.status("test")),
        { label: "Worker persisted acknowledgement" },
      );
    await waitCursor(0);
    Deno.writeTextFileSync(`${f.vault}/hello.md`, "hello");
    f.hub.scanNow();
    await waitCursor(1);
    const saved = await f.data.load();
    assertEquals(saved.values.frozen, true);
    assertEquals(
      (saved.values.packets as { type: string }[]).map((p) => p.type),
      ["gap", "snapshot", "changes"],
    );
    await f.runtime.retireOwner("test", false, true);
    Deno.writeTextFileSync(`${f.vault}/later.md`, "later");
    f.hub.scanNow();
    assertEquals(f.hub.store.pluginCursor("test")?.seq, 1);
    f.sources[0].enabled = true;
    await f.runtime.reconcile();
    await pluginSettled(f.runtime, "test", "ready");
    await waitCursor(2);
    assertEquals((await f.data.load()).values.packets instanceof Array, true);
    assertEquals(
      ((await f.data.load()).values.packets as { type: string }[]).filter((p) =>
        p.type === "gap"
      ).length,
      1,
    );
    f.sources.splice(0);
    await f.runtime.reconcile();
    assertEquals(f.hub.store.pluginCursor("test"), null);
    f.hub.store.advancePluginCursor("removed-offline", null, {
      logId: f.hub.store.logId,
      seq: 2,
      authorityKey: "old-authority",
    });
    await f.runtime.reconcile();
    assertEquals(f.hub.store.pluginCursor("removed-offline"), null);
  } finally {
    await f.close();
  }
});

Deno.test("changes authority: canonical root grants, not network or narrow symlink roots", async () => {
  const f = await fixture(observer);
  try {
    const key = changesAuthority(f.manifest, f.hub);
    assert(key.length === 64);
    Deno.mkdirSync(`${f.vault}/narrow`);
    Deno.symlinkSync(`${f.vault}/narrow`, `${f.vault}/alias`);
    const narrow = {
      ...f.manifest,
      capabilities: {
        ...f.manifest.capabilities,
        read: ["alias"],
        network: true,
      },
    };
    assertThrows(() => changesAuthority(narrow, f.hub));
  } finally {
    await f.close();
  }
});

Deno.test("changes Worker: setup starts no subscriber, read-only observation advances host cursor without granting plugin mutations", async () => {
  const policy = { operational: false, writable: false };
  const f = await fixture(
    `export function activate(ctx) {
    const packets=[];
    ctx.changes.subscribe(packet=>{packets.push(packet);return {ack:packet.token};});
    ctx.commands.register({id:'dump',label:'Dump',target:'server'},()=>packets);
    ctx.commands.register({id:'write',label:'Write',target:'server'},()=>ctx.data.save({forbidden:true},0));
  }`,
    { apiVersion: 1 },
    ["vault"],
    policy,
  );
  try {
    assertEquals(f.runtime.status("test")?.generation, null);
    assertEquals(f.hub.store.pluginCursor("test"), null);
    policy.operational = true;
    await f.runtime.reconcile();
    await pluginSettled(f.runtime, "test", "ready");
    Deno.writeTextFileSync(`${f.vault}/external.md`, "readonly observation");
    f.hub.scanNow();
    await waitUntil(
      () =>
        f.hub.store.pluginCursor("test")?.seq === 1
          ? done()
          : pending(f.runtime.status("test")),
      { label: "read-only host cursor" },
    );
    const packets = await f.runtime.invokeCommand("test", "dump", {}) as {
      type: string;
    }[];
    assert(packets.some((packet) => packet.type === "snapshot"));
    await assertRejects(() => f.runtime.invokeCommand("test", "write", {}));
    assertEquals((await f.data.load()).revision, 0);
  } finally {
    await f.close();
  }
});

Deno.test("changes Worker: undefined and forged acknowledgements report failure without installing progress", async () => {
  for (
    const result of [
      "undefined",
      "{ack:'forged'}",
      "{ack:packet.token,extra:true}",
    ]
  ) {
    const f = await fixture(
      `export function activate(ctx) {ctx.changes.subscribe(packet=>${
        result.startsWith("{") ? `(${result})` : result
      });}`,
    );
    try {
      await pluginSettled(f.runtime, "test", "ready");
      await waitUntil(
        () =>
          f.runtime.status("test")?.changes?.lastError
            ? done()
            : pending(f.runtime.status("test")),
        { label: "invalid Worker ack rejected" },
      );
      assertEquals(f.hub.store.pluginCursor("test"), null);
      assert(
        f.runtime.status("test")!.diagnostics.some((d) =>
          d.code === "changes_delivery_failed"
        ),
      );
    } finally {
      await f.close();
    }
  }
});
