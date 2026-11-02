// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import type { OperationFact } from "../../server/plugins/contracts.ts";
import { OperationError } from "../../server/plugins/errors.ts";
import { state } from "../../server/state.ts";
import { api, bundle } from "../helpers/plugin_lifecycle.ts";

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
      // These raw setup writes are startup inventory, before consumers activate.
      b.hub.scanNow();
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
      b.hub.scanNow();
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
    const token = b.hub.expect([filename]);
    Deno.writeTextFileSync(filename, "managed scanner observation");
    const mtime = (Deno.statSync(filename).mtime?.getTime() ?? 0) / 1000;
    b.lifecycle.recordManaged("Managed.md", mtime);
    b.hub.record(token, [{ kind: "write", path: filename }], "api");
    b.hub.scanNow();
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
    b.hub.scanNow();
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
