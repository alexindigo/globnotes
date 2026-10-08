// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginActions } from "../server/plugins/actions.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { PluginNetworkRequests } from "../server/plugins/network_requests.ts";
import {
  PluginRuntime,
  type RuntimeSource,
} from "../server/plugins/runtime.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { fixtureApiOrigin, pluginFixture } from "./helpers/plugin_fixture.ts";
import { requesterAuthority } from "../server/plugins/lifecycle.ts";
import type {
  ActionReceipt,
  OperationFact,
} from "../server/plugins/contracts.ts";

const api = () => fixtureApiOrigin(state.lifecycle!);
async function wait(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("authority consumer deadline");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
/** Operator-side consent under generated fixture state; never an SDK grant. */
async function approveFixtureNetwork(
  network: PluginNetworkRequests,
  id: string,
) {
  const view = await network.view(id);
  await network.controls(id, {
    revision: view.revision,
    signature: view.signature,
    requestSourceKey: view.requestSourceKey,
    requestSourceRevision: view.requestSourceRevision,
    allowNetwork: true,
    approvedNetwork: view.requestedNetwork,
    approvedImports: [],
  });
  const deadline = Date.now() + 2000;
  for (;;) {
    const current = await network.view(id);
    if (current.reload.state === "ready") return;
    if (current.reload.state === "failed" || Date.now() >= deadline) {
      throw new Error(
        `fixture consent admission failed: ${JSON.stringify(current.reload)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
async function bundle(
  write: string[] = ["vault"],
  read: string[] = ["vault"],
  probes: ConstructorParameters<typeof FileSystemNotes>[1] = {},
  service?: string,
  hooks: RuntimeSource["hooks"] = [],
  limits: { causalDepth?: number; receipts?: number } = {},
  fixtureOptions: {
    network?: string[];
    files?: Record<string, string>;
    runtimeLimits?: ConstructorParameters<typeof PluginRuntime>[2];
    retain?: boolean;
  } = {},
) {
  const fixture = await pluginFixture();
  const retirement = Promise.withResolvers<void>();
  const previous = new Map(
    ["GLOBNOTES_PATH", "GLOBNOTES_INDEX_PATH", "GLOBNOTES_AUTH_TYPE"].map(
      (key) => [key, Deno.env.get(key)],
    ),
  );
  Deno.env.set("GLOBNOTES_PATH", fixture.vault);
  Deno.env.set("GLOBNOTES_INDEX_PATH", fixture.statePath);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  const config = new GlobalConfig(),
    notes = new FileSystemNotes(fixture.vault, probes),
    files = new FileServing(fixture.vault),
    indexer = new Fts5Indexer(fixture.statePath),
    lifecycle = new PluginLifecycle(config);
  const sources: RuntimeSource[] = [], facts: OperationFact[] = [];
  const rpc = servicePluginRpc({
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    actions: () => actions,
  });
  const network: PluginNetworkRequests = new PluginNetworkRequests(
    fixture.statePath,
    {
      plugins: () =>
        sources.flatMap((source) =>
          source.manifest
            ? [{
              id: source.id,
              dir: source.manifest.dir,
              manifest: source.manifest,
              browserComponents: [],
            }]
            : []
        ),
      commit: (effect) => lifecycle.gate.run(effect),
      changed: () => lifecycle.notifyInvalidation(),
      revokeReduced: (id, effective) =>
        runtime.revokeNetworkReduced(id, effective),
      reload: (id, policy) => runtime.reloadNetwork(id, policy.effective),
    },
  );
  const runtime: PluginRuntime = new PluginRuntime(() => sources, {
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    operational: () => lifecycle.operational(),
    writable: () => lifecycle.writable(),
    commit: (effect) => lifecycle.gate.run(effect),
    sanitizeFact: (manifest, fact) =>
      lifecycle.applyReadGrants(manifest, fact as OperationFact),
    rpc,
    network,
  }, { disposalMs: 20, ...fixtureOptions.runtimeLimits });
  initState(config, null, notes, indexer, files, null as never);
  const operations = new NoteOperations({
    notes,
    files,
    indexer,
    lifecycle,
    runtime: () => runtime,
  });
  const actions: PluginActions = new PluginActions({
    operations,
    vaultPath: fixture.vault,
    statePath: fixture.statePath,
    runtime: () => runtime,
    limits,
  });
  state.lifecycle = lifecycle;
  state.operations = operations;
  state.actions = actions;
  lifecycle.onFact((fact) => {
    facts.push(fact);
    runtime.post(`on-${fact.action}` as never, fact);
  });
  const dir = await fixture.install("requester", {
    runtime: { server: "service.js" },
    hooks,
    capabilities: {
      write,
      read,
      ...(fixtureOptions.network?.length
        ? { network: fixtureOptions.network, imports: false }
        : {}),
    },
  }, {
    "service.js": service ??
      `export function activate(ctx){ctx.commands.register({id:'request',label:'Request',target:'server'},a=>ctx.actions.request(a.action,a.args));ctx.commands.register({id:'file',label:'File',target:'server'},a=>ctx.files.requestWrite(a.path,new TextEncoder().encode(a.content)));ctx.commands.register({id:'private',label:'Private',target:'server'},async()=>{const value=await ctx.data.load();await ctx.data.save({own:'permitted'},value.revision);return ctx.data.load();});ctx.commands.register({id:'result',label:'Result',target:'server'},id=>ctx.actions.result(id));ctx.actions.onResult(value=>{globalThis.latest=value;});ctx.commands.register({id:'latest',label:'Latest',target:'server'},()=>globalThis.latest??null);}`,
    ...fixtureOptions.files,
  });
  const manifest = readManifest(dir);
  sources.push({ id: manifest.id, enabled: true, manifest, hooks });
  if (fixtureOptions.network?.length) {
    await approveFixtureNetwork(network, manifest.id);
  }
  await runtime.reconcile();
  await wait(() => runtime.status("requester")?.status === "ready");
  const generation = runtime.status("requester")!.generation!;
  const query = (requestId: string) =>
    actions.result("requester", generation, requestId);
  async function receipt(requestId: string) {
    await wait(() =>
      !["accepted", "running"].includes(query(requestId).status)
    );
    return query(requestId);
  }
  return {
    fixture,
    lifecycle,
    operations,
    actions,
    runtime,
    network,
    notes,
    indexer,
    facts,
    sources,
    manifest,
    generation,
    retirement,
    receipt,
    request: async (action: string, args: unknown) =>
      (await runtime.invokeCommand("requester", "request", {
        action,
        args,
      }) as { requestId: string }).requestId,
    async dispose() {
      retirement.resolve();
      await runtime.close();
      for (const [key, value] of previous) {
        if (value === undefined) {
          Deno.env.delete(key);
        } else Deno.env.set(key, value);
      }
      if (!fixtureOptions.retain) await fixture.dispose();
    },
  };
}

Deno.test("review repairs: R25 real settle then retire returns receipt-ring count to baseline without a later action or query", async () => {
  const previous = { ...state },
    b = await bundle(["vault"], ["vault"], {}, undefined, [], {}, {
      retain: true,
    });
  try {
    const baseline = b.actions.retentionCounts();
    assertEquals(baseline, { rings: 0, receipts: 0, unfinished: 0 });
    for (let cycle = 0; cycle < 6; cycle++) {
      const generation = b.runtime.status("requester")!.generation!;
      const requestId = await b.request("create", {
        path: `cycle-${cycle}`,
        content: `settled cycle ${cycle}`,
      });
      await wait(() =>
        b.actions.result("requester", generation, requestId).status ===
          "completed"
      );
      assertEquals(
        b.notes.get(`cycle-${cycle}`).content,
        `settled cycle ${cycle}`,
      );
      assertEquals(b.actions.retentionCounts().rings, 1);
      b.sources[0].enabled = false;
      await b.runtime.reconcile();
      // Count observation itself does not query or mutate a receipt ring.
      console.log(
        JSON.stringify({
          cycle,
          retiredGeneration: generation,
          afterRetirement: b.actions.retentionCounts(),
          retainedReceiptRetirementFixture: b.fixture.root,
        }),
      );
      assertEquals(b.actions.retentionCounts(), baseline);
      b.sources[0].enabled = true;
      await b.runtime.reconcile();
      await wait(() => b.runtime.status("requester")?.status === "ready");
    }
  } finally {
    await b.dispose();
    Object.assign(state, previous);
    console.log(JSON.stringify({ retainedR25Fixture: b.fixture.root }));
  }
});

Deno.test("review repairs: R25 unfinished retired accounting survives until settlement and cannot replace B receipts or results", async () => {
  const previous = { ...state },
    b = await bundle(["vault"], ["vault"], {}, undefined, [], {}, {
      retain: true,
    });
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const create = b.operations.createNote.bind(b.operations);
  try {
    b.operations.createNote = async (...args) => {
      if (args[0].path === "retired-A") {
        reached.resolve();
        await release.promise;
      }
      return create(...args);
    };
    const generationA = b.runtime.status("requester")!.generation!;
    const old = await b.request("create", {
      path: "retired-A",
      content: "must not commit",
    });
    await reached.promise;
    await wait(() =>
      b.actions.result("requester", generationA, old).status === "running"
    );
    b.sources[0].enabled = false;
    await b.runtime.reconcile();
    assertEquals(b.actions.retentionCounts(), {
      rings: 1,
      receipts: 1,
      unfinished: 1,
    });
    b.sources[0].enabled = true;
    await b.runtime.reconcile();
    await wait(() => b.runtime.status("requester")?.status === "ready");
    const generationB = b.runtime.status("requester")!.generation!;
    assert(generationA !== generationB);
    const fresh = await b.request("create", {
      path: "B-owned",
      content: "B result consumer",
    });
    release.resolve();
    await wait(() =>
      b.actions.result("requester", generationB, fresh).status ===
        "completed" && b.actions.retentionCounts().unfinished === 0
    );
    assertEquals(b.actions.retentionCounts(), {
      rings: 1,
      receipts: 1,
      unfinished: 0,
    });
    assertEquals(
      b.actions.result("requester", generationA, old).status,
      "unavailable",
    );
    assertEquals(b.notes.getPaths(), ["B-owned"]);
    const latest = await b.runtime.invokeCommand(
      "requester",
      "latest",
      {},
    ) as ActionReceipt;
    assertEquals(latest.requestId, fresh);
    assertEquals(latest.status, "completed");
    console.log(JSON.stringify({
      originalGeneration: generationA,
      replacementGeneration: generationB,
      retiredAccountingSettled: true,
      retainedBReceipt: fresh,
      realBResult: latest,
      counts: b.actions.retentionCounts(),
      retainedPendingRetirementFixture: b.fixture.root,
    }));
    b.sources[0].enabled = false;
    await b.runtime.reconcile();
    assertEquals(b.actions.retentionCounts(), {
      rings: 0,
      receipts: 0,
      unfinished: 0,
    });
  } finally {
    release.resolve();
    b.operations.createNote = create;
    await b.dispose();
    Object.assign(state, previous);
    console.log(JSON.stringify({ retainedR25PendingFixture: b.fixture.root }));
  }
});

Deno.test("plugin authority: note mutations honor write-empty denial without changing disk index or facts", async () => {
  const b = await bundle([]);
  try {
    await b.operations.createNote({ path: "keep", content: "original" }, api());
    b.facts.length = 0;
    const observed: string[] = [];
    for (
      const [action, args] of [
        ["create", { path: "created", content: "x" }],
        ["save", { path: "keep", newContent: "changed" }],
        ["rename", { path: "keep", newPath: "renamed" }],
        ["delete", { path: "keep" }],
        ["file-write", {
          path: "created.md",
          bytes: new TextEncoder().encode("markdown"),
        }],
        ["file-write", {
          path: "created.bin",
          bytes: new Uint8Array([1, 2, 3]),
        }],
      ] as const
    ) {
      try {
        const id = await b.request(action, args);
        observed.push((await b.receipt(id)).status);
      } catch {
        observed.push("denied");
      }
    }
    assertEquals(b.notes.getPaths(), ["keep"]);
    assertEquals(b.notes.get("keep").content, "original");
    assertEquals(b.facts, []);
    assert(
      observed.every((status) => status === "denied" || status === "failed"),
    );
    for (const target of ["facade.md", "facade.bin"]) {
      await assertRejects(() =>
        b.runtime.invokeCommand("requester", "file", {
          path: target,
          content: "forbidden",
        })
      );
      await assertRejects(
        () => Deno.stat(`${b.fixture.vault}/${target}`),
        Deno.errors.NotFound,
      );
    }
    await assertRejects(() =>
      b.request("save", {
        path: "keep",
        newContent: "forged authority",
        pluginId: "other",
        origin: "api",
        capabilities: { write: ["vault"] },
        manifest: { capabilities: { write: ["vault"] } },
        current: true,
      })
    );
    assertEquals(b.indexer.search("original").map((row) => row.path), ["keep"]);
    assertEquals(b.indexer.search("forbidden"), []);
    assertEquals(b.facts, []);
    const ownData = await b.runtime.invokeCommand(
      "requester",
      "private",
      {},
    ) as { values: Record<string, unknown> };
    assertEquals(ownData.values, { own: "permitted" });
    assertEquals(
      JSON.parse(
        Deno.readTextFileSync(
          `${b.fixture.statePath}/plugin-data/requester/data.json`,
        ),
      ).values,
      ownData.values,
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: H1 canonical paths, attachments, mkdir and optional pruning obey narrow grants", async () => {
  const b = await bundle(["old/note.md", "new/note.md"]);
  try {
    await b.operations.createNote({
      path: "old/note",
      content: "# note\n![image](image.png)",
    }, api());
    b.facts.length = 0;
    Deno.mkdirSync(`${b.fixture.vault}/new`);
    Deno.writeTextFileSync(`${b.fixture.vault}/old/image.png`, "image");
    const moved = await b.request("rename", {
      path: "old/note",
      newPath: "new/note",
      fileRefs: "move",
    });
    assertEquals((await b.receipt(moved)).status, "failed");
    assertEquals(
      b.notes.get("old/note").content,
      "# note\n![image](image.png)",
    );
    assertEquals(
      Deno.readTextFileSync(`${b.fixture.vault}/old/image.png`),
      "image",
    );
    assertEquals(b.facts, []);
    const relink = await b.request("rename", {
      path: "old/note",
      newPath: "new/note",
      fileRefs: "relink",
    });
    assertEquals((await b.receipt(relink)).status, "completed");
    assert(b.notes.get("new/note").content!.includes("../old/image.png"));
    assertEquals(
      Deno.readTextFileSync(`${b.fixture.vault}/old/image.png`),
      "image",
    );
    // Actual equal-path requests stay equal: neither facade nor storage may
    // remove the explicit target and invent an H1-derived move.
    const equal = await b.request("save", {
      path: "new/note",
      newPath: "new/note",
      newContent: "# Uncovered",
    });
    assertEquals((await b.receipt(equal)).status, "completed");
    assertEquals(b.notes.get("new/note").content, "# Uncovered");
    const h1 = await b.request("save", {
      path: "new/note",
      newContent: "# Derived",
    });
    assertEquals((await b.receipt(h1)).status, "failed");
    assertEquals(b.notes.get("new/note").content, "# Uncovered");
    const mkdir = requesterAuthority(
      b.manifest,
      b.fixture.vault,
      b.fixture.statePath,
      b.generation,
      () => true,
    );
    await b.operations.deleteNote("new/note", { origin: "plugin" }, mkdir);
    assert(
      Deno.statSync(`${b.fixture.vault}/new`).isDirectory,
      "ungranted optional prune removed parent",
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: uncovered required mkdir, selected directory and symlink retarget deny before effects", async () => {
  const b = await bundle(["old/note.md", "missing/note.md"]);
  try {
    await b.operations.createNote(
      { path: "old/note", content: "original" },
      api(),
    );
    b.facts.length = 0;
    const id = await b.request("rename", {
      path: "old/note",
      newPath: "missing/note",
    });
    assertEquals((await b.receipt(id)).status, "failed");
    assertEquals(b.notes.get("old/note").content, "original");
    let missing = false;
    try {
      Deno.statSync(`${b.fixture.vault}/missing`);
    } catch {
      missing = true;
    }
    assert(missing);
    const authority = requesterAuthority(
      {
        ...b.manifest,
        capabilities: { ...b.manifest.capabilities, write: ["vault"] },
      },
      b.fixture.vault,
      b.fixture.statePath,
      b.generation,
      () => true,
    );
    Deno.mkdirSync(`${b.fixture.vault}/old/directory`);
    await b.operations.updateNote(
      "old/note",
      { newContent: "[directory](directory)" },
      "none",
      api(),
    );
    b.facts.length = 0;
    const error = await b.operations.updateNote(
      "old/note",
      { newPath: "new/note" },
      "move",
      { origin: "plugin" },
      authority,
    ).catch((error) => error);
    assertEquals(error.code, "plugin_permission_denied");
    assert(Deno.statSync(`${b.fixture.vault}/old/directory`).isDirectory);
    assertEquals(b.facts, []);
    const gate = Promise.withResolvers<void>();
    const occupied = b.lifecycle.gate.run(() => gate.promise);
    Deno.mkdirSync(`${b.fixture.vault}/allowed`);
    Deno.symlinkSync(`${b.fixture.vault}/allowed`, `${b.fixture.vault}/link`);
    const writing = b.operations.createNote(
      { path: "link/new", content: "x" },
      { origin: "plugin" },
      authority,
    ).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    Deno.removeSync(`${b.fixture.vault}/link`);
    Deno.symlinkSync(b.fixture.statePath, `${b.fixture.vault}/link`);
    gate.resolve();
    await occupied;
    const result = await writing;
    assert(result instanceof Error);
    let leaked = false;
    try {
      Deno.statSync(`${b.fixture.statePath}/new.md`);
      leaked = true;
    } catch { /* expected */ }
    assertEquals(leaked, false);
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: partial committed effects remain truthful after post-effect revocation", async () => {
  let armed = false, current = true;
  const b = await bundle(["vault"], ["vault"], {
    afterRename() {
      if (armed) {
        current = false;
        throw new Error("after real effect");
      }
    },
  });
  try {
    await b.operations.createNote(
      { path: "old/note", content: "old content" },
      api(),
    );
    b.facts.length = 0;
    armed = true;
    const requester = requesterAuthority(
      b.manifest,
      b.fixture.vault,
      b.fixture.statePath,
      b.generation,
      () => current,
    );
    const error = await b.operations.updateNote(
      "old/note",
      { newPath: "new/note" },
      "none",
      { origin: "plugin" },
      requester,
    ).catch((error) => error);
    assertEquals(error.code, "operation_partial");
    assertEquals(b.notes.get("new/note").content, "old content");
    assertEquals(b.indexer.search("old content").map((result) => result.path), [
      "new/note",
    ]);
    assert(
      b.facts.some((fact) =>
        fact.action === "save" && fact.path === "new/note"
      ),
    );
    assert(b.facts.some((fact) => fact.action === "operation-error"));
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: source-only and destination-only moves reject; granted attachments succeed", async () => {
  for (const grants of [["old/note.md"], ["new/note.md"], ["old", "new"]]) {
    const b = await bundle(grants);
    try {
      await b.operations.createNote({
        path: "old/note",
        content: "![img](image.png)",
      }, api());
      Deno.mkdirSync(`${b.fixture.vault}/new`);
      Deno.writeTextFileSync(`${b.fixture.vault}/old/image.png`, "image");
      b.facts.length = 0;
      let result: ActionReceipt | null = null;
      try {
        result = await b.receipt(
          await b.request("rename", {
            path: "old/note",
            newPath: "new/note",
            fileRefs: "move",
          }),
        );
      } catch { /* admission denial */ }
      if (grants.length === 1) {
        assertEquals(b.notes.get("old/note").content, "![img](image.png)");
        assertEquals(b.facts, []);
      } else {
        assertEquals(result?.status, "completed");
        assertEquals(
          Deno.readTextFileSync(`${b.fixture.vault}/new/image.png`),
          "image",
        );
        assert(b.notes.get("new/note").content!.includes("image.png"));
      }
    } finally {
      await b.dispose();
    }
  }
});

Deno.test("plugin authority: requester disabled behind independent healthy guard cannot commit", async () => {
  const b = await bundle();
  const guardEntered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let guardReceived = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async () => {
      guardReceived = true;
      guardEntered.resolve();
      await release.promise;
      return new Response("accept");
    },
  );
  try {
    let operationFailure: { code?: string } | undefined;
    const originalUpdate = b.operations.updateNote.bind(b.operations);
    b.operations.updateNote = (...args) =>
      originalUpdate(...args).catch((error) => {
        operationFailure = error;
        throw error;
      });
    await b.operations.createNote({ path: "keep", content: "original" }, api());
    b.facts.length = 0;
    const dir = await b.fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
      capabilities: {
        network: [`127.0.0.1:${server.addr.port}`],
        imports: false,
      },
    }, {
      "service.js":
        `export function activate(ctx){ctx.hooks.on('pre-save',async()=>{const r=await fetch('http://127.0.0.1:${server.addr.port}');await r.text();});}`,
    });
    const manifest = readManifest(dir);
    b.sources.push({
      id: "guard",
      enabled: true,
      manifest,
      hooks: manifest.hooks,
    });
    await approveFixtureNetwork(b.network, "guard");
    await b.runtime.reconcile();
    await wait(() => b.runtime.status("guard")?.status === "ready");
    const id = await b.request("save", { path: "keep", newContent: "changed" });
    await wait(() => guardReceived);
    await guardEntered.promise;
    b.sources[0].enabled = false;
    await b.runtime.reconcile();
    release.resolve();
    await wait(() => operationFailure !== undefined);
    assertEquals(operationFailure?.code, "plugin_generation_revoked");
    assertEquals((await b.receipt(id)).status, "unavailable");
    assertEquals(b.notes.get("keep").content, "original");
    assertEquals(b.facts, []);
  } finally {
    release.resolve();
    await server.shutdown();
    await b.dispose();
  }
});

Deno.test("plugin authority: deferred action waits for requester release and immutable bytes", async () => {
  const b = await bundle();
  const release = Promise.withResolvers<{ status: "settled" }>();
  try {
    const args = { path: "first", content: "captured" };
    const id = b.actions.request(
      b.manifest,
      "create",
      args,
      {
        pluginId: "requester",
        generation: b.generation,
        causalDepth: 0,
        current: () => true,
        release: release.promise,
        generationRetired: b.retirement.promise,
      } as never,
    ).requestId;
    args.path = "mutated";
    args.content = "mutated";
    // A separate real API operation proves the operation executor has had a
    // scheduling opportunity without releasing the captured requesting scope.
    await b.operations.createNote(
      { path: "control", content: "control" },
      api(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(b.notes.getPaths(), ["control"]);
    assertEquals(
      b.actions.result("requester", b.generation, id).status,
      "accepted",
    );
    release.resolve({ status: "settled" });
    assertEquals((await b.receipt(id)).status, "completed");
    assertEquals(b.notes.get("first").content, "captured");
  } finally {
    release.resolve({ status: "settled" });
    await b.dispose();
  }
});

Deno.test("plugin authority: initiator revocation during commit-gate wait leaves known no effect", async () => {
  const b = await bundle();
  const gate = Promise.withResolvers<void>();
  let current = true;
  try {
    let operationFailure: { code?: string } | undefined;
    const originalUpdate = b.operations.updateNote.bind(b.operations);
    b.operations.updateNote = (...args) =>
      originalUpdate(...args).catch((error) => {
        operationFailure = error;
        throw error;
      });
    await b.operations.createNote({ path: "keep", content: "original" }, api());
    b.facts.length = 0;
    const occupied = b.lifecycle.gate.run(() => gate.promise);
    const id = b.actions.request(
      b.manifest,
      "save",
      { path: "keep", newContent: "changed" },
      {
        pluginId: "requester",
        generation: b.generation,
        causalDepth: 0,
        current: () => current,
        release: Promise.resolve({ status: "settled" }),
        generationRetired: b.retirement.promise,
      } as never,
    ).requestId;
    await wait(() =>
      b.actions.result("requester", b.generation, id).status === "running"
    );
    current = false;
    b.retirement.resolve();
    gate.resolve();
    await occupied;
    await wait(() => operationFailure !== undefined);
    assertEquals(operationFailure?.code, "plugin_generation_revoked");
    assertEquals((await b.receipt(id)).status, "unavailable");
    assertEquals(b.notes.get("keep").content, "original");
    assertEquals(b.facts, []);
  } finally {
    gate.resolve();
    await b.dispose();
  }
});

Deno.test("plugin authority: successful receipt carries actual operation identity and withholds write-only content", async () => {
  const b = await bundle(["vault"], []);
  try {
    const id = await b.request("create", {
      path: "created",
      content: "# Private title\nprivate content",
    });
    const receipt = await b.receipt(id);
    assertEquals(receipt.status, "completed");
    assertEquals(receipt.operationId, b.facts[0].operationId);
    assert(receipt.operationId !== id);
    assertEquals((receipt.result as { content?: string }).content, undefined);
    assertEquals((receipt.result as { title?: string }).title, undefined);
    const delivered = await b.runtime.invokeCommand(
      "requester",
      "latest",
      {},
    ) as ActionReceipt;
    assertEquals(delivered, receipt);
    assertEquals(
      b.notes.get("created").content,
      "# Private title\nprivate content",
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: old-generation completion cannot replace a new receipt ring or notify new handlers", async () => {
  const b = await bundle();
  const gate = Promise.withResolvers<void>();
  let oldCurrent = true;
  try {
    const occupied = b.lifecycle.gate.run(() => gate.promise);
    const old = b.actions.request(
      b.manifest,
      "create",
      { path: "old", content: "old" },
      {
        pluginId: "requester",
        generation: "old-generation",
        causalDepth: 0,
        current: () => oldCurrent,
        release: Promise.resolve({ status: "settled" }),
        generationRetired: b.retirement.promise,
      } as never,
    ).requestId;
    await wait(() =>
      b.actions.result("requester", "old-generation", old).status === "running"
    );
    const fresh = await b.request("create", {
      path: "fresh",
      content: "fresh",
    });
    oldCurrent = false;
    b.retirement.resolve();
    gate.resolve();
    await occupied;
    const baseline = await b.receipt(fresh);
    assertEquals(baseline.status, "completed");
    // Both operations finished, but the old owner must never reach today's
    // action-result handler (the current host can inspect its stored IDs).
    const latest = await b.runtime.invokeCommand(
      "requester",
      "latest",
      {},
    ) as ActionReceipt;
    assertEquals(latest.requestId, fresh);
    assert(latest.requestId !== old);
    assertEquals(
      b.actions.result("requester", "old-generation", old).status,
      "unavailable",
    );
  } finally {
    gate.resolve();
    await b.dispose();
  }
});

Deno.test("plugin authority: both completion routes retain bounded host causality including failed actions", async () => {
  for (const route of ["hook", "subscription"] as const) {
    for (const fails of [false, true]) {
      const hook = route === "hook" ? ["on-action-result" as const] : [];
      const service =
        `export function activate(ctx){let n=0, stopped=false; const request=()=>ctx.actions.request('create',{path:${
          fails ? "'duplicate'" : "'chain-'+(++n)"
        },content:'x'}); const consume=async()=>{try{await request();}catch{stopped=true;}}; ${
          route === "hook"
            ? "ctx.hooks.on('on-action-result',consume);"
            : "ctx.actions.onResult(consume);"
        }ctx.commands.register({id:'start',label:'Start',target:'server'},request);ctx.commands.register({id:'state',label:'State',target:'server'},()=>({n,stopped}));}`;
      const b = await bundle(["vault"], ["vault"], {}, service, hook, {
        causalDepth: 3,
      });
      try {
        if (fails) {
          await b.operations.createNote({
            path: "duplicate",
            content: "original",
          }, api());
        }
        b.facts.length = 0;
        const initial = await b.runtime.invokeCommand("requester", "start", {
          operationId: "forged",
          causalDepth: -900,
        }) as { requestId: string };
        let observed: { n: number; stopped: boolean } = {
          n: 0,
          stopped: false,
        };
        const end = Date.now() + 2000;
        while (!observed.stopped) {
          observed = await b.runtime.invokeCommand(
            "requester",
            "state",
            {},
          ) as typeof observed;
          if (Date.now() > end) {
            throw new Error(
              "completion chain did not reach explicit depth rejection",
            );
          }
        }
        if (!fails) {
          assertEquals(observed.n, 4);
          assertEquals(b.notes.getPaths().sort(), [
            "chain-1",
            "chain-2",
            "chain-3",
          ]);
          assertEquals(b.facts.map((fact) => fact.causalDepth), [1, 2, 3]);
          assertEquals(b.facts[0].causalParent, initial.requestId);
          assertEquals(b.facts[1].causalParent, b.facts[0].operationId);
          assertEquals(b.facts[2].causalParent, b.facts[1].operationId);
        } else {
          assertEquals(b.notes.get("duplicate").content, "original");
          assertEquals(b.facts, []);
        }
      } finally {
        await b.dispose();
      }
    }
  }
});

Deno.test("plugin authority: pending admission capacity never evicts unfinished receipts", async () => {
  const b = await bundle(["vault"], ["vault"], {}, undefined, [], {
    receipts: 1,
  });
  const release = Promise.withResolvers<{ status: "settled" }>();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 64; index++) {
      ids.push(
        b.actions.request(b.manifest, "create", {
          path: `pending-${index}`,
          content: "x",
        }, {
          pluginId: "requester",
          generation: b.generation,
          causalDepth: 0,
          current: () => true,
          release: release.promise,
          generationRetired: b.retirement.promise,
        }).requestId,
      );
    }
    assertEquals(
      ids.map((id) => b.actions.result("requester", b.generation, id).status),
      Array(64).fill("accepted"),
    );
    let rejected = false;
    try {
      b.actions.request(b.manifest, "create", { path: "overflow" }, {
        pluginId: "requester",
        generation: b.generation,
        causalDepth: 0,
        current: () => true,
        release: release.promise,
        generationRetired: b.retirement.promise,
      });
    } catch {
      rejected = true;
    }
    assert(rejected);
    assertEquals(b.notes.getPaths(), []);
    release.resolve({ status: "settled" });
    await wait(() => b.notes.getPaths().length === 64);
    await wait(() =>
      b.actions.result("requester", b.generation, ids.at(-1)!).status ===
        "completed"
    );
    assertEquals(
      b.actions.result("requester", b.generation, ids[0]).status,
      "unavailable",
    );
  } finally {
    release.resolve({ status: "settled" });
    await b.dispose();
  }
});

Deno.test("plugin authority: old operation completion after real re-enable never reaches the replacement instance", async () => {
  const b = await bundle();
  const finish = Promise.withResolvers<void>(),
    committed = Promise.withResolvers<void>();
  try {
    const original = b.operations.createNote.bind(b.operations);
    b.operations.createNote = async (...args) => {
      const note = await original(...args);
      if (args[0].path === "old") {
        committed.resolve();
        await finish.promise;
      }
      return note;
    };
    const id = await b.request("create", {
      path: "old",
      content: "old committed",
    });
    await committed.promise;
    b.sources[0].enabled = false;
    await b.runtime.reconcile();
    b.sources[0].enabled = true;
    await b.runtime.reconcile();
    await wait(() => b.runtime.status("requester")?.status === "ready");
    const newGeneration = b.runtime.status("requester")!.generation!;
    assert(newGeneration !== b.generation);
    const fresh = await b.runtime.invokeCommand("requester", "request", {
      action: "create",
      args: { path: "new", content: "new committed" },
    }) as { requestId: string };
    await wait(() =>
      b.actions.result("requester", newGeneration, fresh.requestId).status ===
        "completed"
    );
    const baseline = b.actions.result(
      "requester",
      newGeneration,
      fresh.requestId,
    );
    finish.resolve();
    // A command behind previously queued completion deliveries is the final
    // consumer, rather than a race-prone callback count sampled immediately.
    const latest = await b.runtime.invokeCommand(
      "requester",
      "latest",
      {},
    ) as ActionReceipt;
    assertEquals(latest.requestId, fresh.requestId);
    assertEquals(
      b.actions.result("requester", newGeneration, fresh.requestId),
      baseline,
    );
    assertEquals(
      b.actions.result("requester", b.generation, id).status,
      "unavailable",
    );
    assertEquals(b.notes.get("old").content, "old committed");
  } finally {
    finish.resolve();
    await b.dispose();
  }
});

Deno.test("plugin authority: independent narrow observers receive only authorized effect metadata", async () => {
  const b = await bundle();
  try {
    const narrow = {
      ...b.manifest,
      capabilities: {
        ...b.manifest.capabilities,
        read: ["visible"],
        write: [],
      },
    };
    const fact: OperationFact = {
      operationId: "actual",
      action: "operation-error",
      origin: "plugin",
      timestamp: new Date().toISOString(),
      changedPaths: ["visible/note", "hidden/note"],
      before: { path: "hidden/note", content: "", contentAvailable: true },
      metadata: {
        effects: [{
          kind: "rename",
          oldPath: `${b.fixture.vault}/hidden/image.png`,
          path: `${b.fixture.vault}/visible/image.png`,
        }, { kind: "write", path: `${b.fixture.vault}/visible/image.png` }],
        failedPath: "hidden/note",
      },
    };
    const projected = b.lifecycle.applyReadGrants(narrow, fact);
    assertEquals(projected.changedPaths, ["visible/note"]);
    assertEquals(projected.before?.contentAvailable, false);
    assertEquals(projected.metadata?.effects, [{
      kind: "write",
      path: `${b.fixture.vault}/visible/image.png`,
    }]);
    assertEquals(projected.metadata?.failedPath, undefined);
  } finally {
    await b.dispose();
  }
});

/** This fixture alone owns its child identity/output/deadline. Launch args,
 * inherited environment and cwd match helpers/boot.ts; no permission repair. */
async function launchBackgroundFixture(env: Record<string, string>) {
  const root = new URL("../", import.meta.url).pathname;
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = listener.addr.port;
  listener.close();
  const args = [
    "run",
    "--unstable-worker-options",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    `${root}server/main.ts`,
  ];
  const launchEnv = {
    ...env,
    GLOBNOTES_PORT: String(port),
    GLOBNOTES_HOST: "127.0.0.1",
    NO_COLOR: "1",
  };
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    env: launchEnv,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = { stdout: "", stderr: "" };
  const drains = ["stdout", "stderr"].map(async (name) => {
    const stream = name === "stdout" ? child.stdout : child.stderr;
    for await (const chunk of stream) {
      output[name as keyof typeof output] += new TextDecoder().decode(chunk);
    }
  });
  let status: Deno.CommandStatus | null = null;
  child.status.then((value) => {
    status = value;
  });
  let closed = false;
  const deadline = Date.now() + 10000;
  const server = {
    pid: child.pid,
    baseUrl: `http://127.0.0.1:${port}`,
    status: () => status,
    output,
    deadline,
    async close() {
      if (closed) return;
      closed = true;
      if (!status) child.kill("SIGTERM");
      await child.status;
      await Promise.all(drains);
    },
  };
  console.log(JSON.stringify({
    fixtureLaunch: {
      pid: child.pid,
      executable: Deno.execPath(),
      args,
      cwd: root,
      env: launchEnv,
      inheritsEnvironment: true,
      loggingDelta: "stdout piped; stderr exposed; both continuously drained",
    },
  }));
  try {
    while (true) {
      const exited = server.status();
      if (exited) {
        throw Error(`Background fixture server exited: ${exited.code}`);
      }
      try {
        const response = await fetch(`${server.baseUrl}/_/api/health`, {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(3000, deadline - Date.now())),
          ),
        });
        await response.body?.cancel();
        if (response.ok) return server;
      } catch { /* bounded readiness retry */ }
      if (Date.now() >= deadline) {
        throw Error("Background fixture health deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function waitBackgroundAdmission(
  server: Awaited<ReturnType<typeof launchBackgroundFixture>>,
  fetched: () => boolean,
  bound = 10000,
) {
  const deadline = Math.min(server.deadline, Date.now() + bound);
  while (true) {
    if (server.status()) {
      throw Error(`Background fixture child exited: ${server.status()!.code}`);
    }
    const response = await fetch(`${server.baseUrl}/_/api/plugin-host`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(3000, deadline - Date.now())),
      ),
    });
    let plugin;
    if (response.ok) {
      plugin = (await response.json()).plugins.find((entry: { id: string }) =>
        entry.id === "timer"
      );
    } else {
      await response.body?.cancel();
      throw Error(`Background fixture catalog rejected: ${response.status}`);
    }
    if (!plugin || ["failed", "disabled"].includes(plugin.status)) {
      console.log(
        JSON.stringify({
          backgroundAdmission: {
            fetched: fetched(),
            plugin,
            pid: server.pid,
            status: server.status(),
          },
          childOutput: server.output,
        }),
      );
      throw Error(
        `Background fixture activation failed: ${
          plugin?.diagnostics?.map((diagnostic: { detail: string }) =>
            diagnostic.detail
          ).join("; ") ?? "required plugin missing"
        }`,
      );
    }
    if (fetched() && plugin.status === "ready") return;
    if (Date.now() >= deadline) {
      throw Error("Background fixture startup-fetch deadline");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

Deno.test("plugin authority: fixture admission fails fast on catalog failure, child exit and startup deadline", async () => {
  let pluginStatus = "failed";
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      Response.json({
        plugins: [{
          id: "timer",
          status: pluginStatus,
          diagnostics: [{ detail: "fixture activation failure" }],
        }],
      }),
  );
  const server = {
    baseUrl: `http://127.0.0.1:${receiver.addr.port}`,
    status: () => null,
    pid: 0,
    output: { stdout: "", stderr: "" },
    deadline: Date.now() + 10000,
    close: async () => {},
  };
  try {
    await assertRejects(
      () => waitBackgroundAdmission(server, () => false, 100),
      Error,
      "fixture activation failure",
    );
    await assertRejects(
      () =>
        waitBackgroundAdmission({
          ...server,
          status: () => ({ code: 1, success: false, signal: null }),
        }, () =>
          false, 100),
      Error,
      "child exited",
    );
    pluginStatus = "ready";
    await assertRejects(
      () => waitBackgroundAdmission(server, () => false, 20),
      Error,
      "startup-fetch deadline",
    );
  } finally {
    await receiver.shutdown();
  }
});

Deno.test("plugin authority: real Worker HTTP timer without file hooks persists and correlates narrow granted work", async () => {
  const fixture = await pluginFixture();
  const begin = Promise.withResolvers<void>(),
    fetched = Promise.withResolvers<void>();
  let fetchObserved = false;
  const gate = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async () => {
      fetchObserved = true;
      fetched.resolve();
      await begin.promise;
      return new Response("background consumer");
    },
  );
  let server: Awaited<ReturnType<typeof launchBackgroundFixture>> | undefined;
  try {
    const content =
      "export async function activate(ctx){let receipt=null, completion=null; const response=fetch('http://127.0.0.1:" +
      gate.addr.port +
      "').then(r=>r.text());ctx.actions.onResult(value=>{completion=value;});ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},async()=>({receipt,completion,query:receipt?await ctx.actions.result(receipt.requestId):null}));ctx.timers.setTimeout(async()=>{const text=await response;receipt=await ctx.files.requestWrite('timer.md',new TextEncoder().encode(text));},0);}";
    await fixture.install("timer", {
      runtime: { server: "service.js" },
      capabilities: {
        write: ["timer.md"],
        read: ["timer.md"],
        network: [`127.0.0.1:${gate.addr.port}`],
        imports: false,
      },
    }, { "service.js": content });
    const operator = new PluginManager(
      fixture.vault,
      undefined,
      0,
      fixture.statePath,
      {
        internalRoot: `${fixture.root}/empty-operator-internal`,
        persistence: { commit: (effect) => effect() },
      },
    );
    await approveFixtureNetwork(operator.network, "timer");
    server = await launchBackgroundFixture({
      GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_INDEX_PATH: fixture.statePath,
      GLOBNOTES_AUTH_TYPE: "none",
    });
    await waitBackgroundAdmission(server, () => fetchObserved);
    const invoke = async () => {
      const response = await fetch(
        `${server!.baseUrl}/_/api/plugin-host/timer/commands/inspect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(3000),
        },
      );
      assertEquals(response.status, 200);
      return await response.json();
    };
    let state = await invoke();
    assertEquals((state.result ?? state).receipt, null);
    begin.resolve();
    const end = Date.now() + 3000;
    do {
      state = await invoke();
      if (Date.now() > end) {
        throw new Error("background HTTP consumer deadline");
      }
    } while ((state.result ?? state).completion?.status !== "completed");
    const consumer = state.result ?? state;
    assertEquals(consumer.query.operationId, consumer.completion.operationId);
    assert(consumer.query.operationId !== consumer.receipt.requestId);
    assertEquals(
      Deno.readTextFileSync(`${fixture.vault}/timer.md`),
      "background consumer",
    );
    const index = await (await fetch(`${server.baseUrl}/_/api/note-index`, {
      signal: AbortSignal.timeout(3000),
    })).json();
    assert(index.some((entry: { path: string }) => entry.path === "timer"));
    console.log(
      JSON.stringify({
        backgroundNoFileHooks: true,
        receipt: consumer.receipt,
        operationId: consumer.query.operationId,
        bytes: consumer.completion.result.content,
        indexVisible: true,
      }),
    );
  } finally {
    begin.resolve();
    await gate.shutdown();
    await server?.close();
    await fixture.dispose();
  }
});

Deno.test("plugin authority: forged pre false is rejected by the actual runtime before mutation admission", async () => {
  const service = `let incoming,wire=100000,pending=new Map(),denied=false;
    addEventListener('message',({data})=>{if(data.type==='invoke')incoming=data;if(data.type==='rpcResponse'&&pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}});
    export function activate(ctx){
      ctx.hooks.on('pre-save',async()=>{await Promise.resolve();const id=++wire,result=new Promise(resolve=>pending.set(id,resolve));postMessage({type:'rpc',generation:incoming.generation,contextId:incoming.context.id,id,method:'actions.request',args:['create',{path:'forged',content:'forbidden'}],pre:false});denied=!(await result).ok;});
      ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>({denied}));
    }`;
  const b = await bundle(["vault"], ["vault"], {}, service, ["pre-save"]);
  try {
    await b.operations.createNote({ path: "keep", content: "seed" }, api());
    b.facts.length = 0;
    await b.operations.updateNote(
      "keep",
      { newContent: "authorized control" },
      "none",
      api(),
    );
    assertEquals(await b.runtime.invokeCommand("requester", "inspect", {}), {
      denied: true,
    });
    assertEquals(b.notes.getPaths(), ["keep"]);
    assertEquals(b.notes.get("keep").content, "authorized control");
    assertEquals(b.indexer.search("forbidden"), []);
    assertEquals(b.facts.map((fact) => fact.action), ["save"]);
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: real command observer and endpoint acceptance precede their own settlement but no effect does", async (t) => {
  for (const origin of ["command", "observer", "endpoint"] as const) {
    await t.step(origin, async () => {
      const accepted = Promise.withResolvers<string>(),
        release = Promise.withResolvers<void>();
      const receiver = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, async (request) => {
        accepted.resolve(new URL(request.url).searchParams.get("requestId")!);
        await release.promise;
        return new Response("origin released");
      });
      const authority = `127.0.0.1:${receiver.addr.port}`;
      const execute =
        `async()=>{const receipt=await ctx.actions.request('create',{path:'from-${origin}',content:'settled ${origin} consumer'});await(await fetch('http://${authority}/hold?requestId='+receipt.requestId)).text();return receipt;}`;
      const service =
        `export function activate(ctx){ctx.commands.register({id:'start',label:'Start',target:'server'},${execute});ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>true);${
          origin === "observer" ? `ctx.hooks.on('on-sync',${execute});` : ""
        }}`;
      const b = await bundle(
        ["vault"],
        ["vault"],
        {},
        service,
        origin === "observer" ? ["on-sync"] : [],
        {},
        {
          network: [authority],
          files: origin === "endpoint"
            ? {
              "endpoints/post.js":
                `export default async(_,ctx)=>(${execute})();`,
            }
            : {},
        },
      );
      let running: Promise<unknown> | undefined;
      try {
        if (origin === "command") {
          running = b.runtime.invokeCommand("requester", "start", {});
        } else if (origin === "endpoint") {
          running = b.runtime.invokeHandler(
            "requester",
            b.runtime.endpointDescriptors("requester")[0].handlerId,
            [{}],
          );
        } else {b.runtime.post("on-sync", {
            operationId: "observer-origin",
            action: "sync",
            origin: "api",
            timestamp: new Date().toISOString(),
            causalDepth: 2,
          });}
        running?.catch(() => undefined);
        let id: string | undefined;
        accepted.promise.then((value) => {
          id = value;
        });
        await wait(() => id !== undefined);
        // A real independent storage consumer gives the executor an opportunity;
        // it is not a sleep pretending that the originating promise settled.
        await b.operations.createNote(
          { path: "control", content: "control" },
          api(),
        );
        b.facts.length = 0;
        assertEquals(b.notes.getPaths(), ["control"]);
        assertEquals(b.indexer.search("settled"), []);
        assertEquals(
          b.actions.result("requester", b.generation, id!).status,
          "accepted",
        );
        release.resolve();
        await running;
        const receipt = await b.receipt(id!);
        assertEquals(receipt.status, "completed");
        assertEquals(
          b.notes.get(`from-${origin}`).content,
          `settled ${origin} consumer`,
        );
        assertEquals(b.indexer.search("settled").map((row) => row.path), [
          `from-${origin}`,
        ]);
        assertEquals(b.facts.length, 1);
        assertEquals(receipt.operationId, b.facts[0].operationId);
        assertEquals(
          b.facts[0].causalParent,
          origin === "observer" ? "observer-origin" : id,
        );
        assertEquals(b.facts[0].causalDepth, origin === "observer" ? 3 : 1);
        console.log(
          JSON.stringify({
            origin,
            requestId: id,
            operationId: receipt.operationId,
            persisted: b.notes.get(`from-${origin}`).content,
            acceptanceBeforeSettlement: true,
            effectsBeforeSettlement: 0,
          }),
        );
      } finally {
        release.resolve();
        await running?.catch(() => undefined);
        await receiver.shutdown();
        await b.dispose();
      }
    });
  }
});

Deno.test("plugin authority: ordinary error releases accepted work while timeout and real Worker crash abort it", async (t) => {
  for (const ending of ["error", "timeout", "crash"] as const) {
    await t.step(ending, async () => {
      let accepted = false;
      const receiver = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, () => {
        accepted = true;
        return new Response("admission observed");
      });
      const authority = `127.0.0.1:${receiver.addr.port}`;
      const service =
        `export function activate(ctx){ctx.commands.register({id:'start',label:'Start',target:'server'},async()=>{await ctx.actions.request('create',{path:'accepted',content:'after ordinary error'});await(await fetch('http://${authority}/accepted')).text();${
          ending === "error"
            ? "throw Error('ordinary');"
            : ending === "crash"
            ? "queueMicrotask(()=>{throw Error('real Worker crash');});await new Promise(()=>{});"
            : "await new Promise(()=>{});"
        }});}`;
      const b = await bundle(["vault"], ["vault"], {}, service, [], {}, {
        network: [authority],
        runtimeLimits: { serviceCallMs: ending === "timeout" ? 150 : 1000 },
      });
      try {
        const caller = b.runtime.invokeCommand("requester", "start", {}).catch(
          (error) => error,
        );
        await wait(() => accepted);
        assert(await caller instanceof Error);
        if (ending === "error") {
          await wait(() => b.facts.length === 1);
          const requestId = b.facts[0].causalParent!;
          assertEquals((await b.receipt(requestId)).status, "completed");
          assertEquals(b.notes.get("accepted").content, "after ordinary error");
          assertEquals(b.indexer.search("ordinary").map((row) => row.path), [
            "accepted",
          ]);
        } else {
          assertEquals(b.runtime.status("requester")?.status, "failed");
          await b.operations.createNote({
            path: "control",
            content: "unrelated API remains available",
          }, api());
          assertEquals(b.notes.getPaths(), ["control"]);
          assertEquals(b.indexer.search("ordinary"), []);
          assertEquals(b.facts.map((fact) => fact.path), ["control"]);
        }
        console.log(
          JSON.stringify({
            ending,
            acceptanceObserved: accepted,
            paths: b.notes.getPaths(),
            actualEffects: ending === "error" ? 1 : 0,
          }),
        );
      } finally {
        await receiver.shutdown();
        await b.dispose();
      }
    });
  }
});

Deno.test("plugin authority: saved generation ctx drives startup network and managed interval mutations while an observer is held", async () => {
  const network = Promise.withResolvers<void>(),
    interval = Promise.withResolvers<void>(),
    observer = Promise.withResolvers<void>();
  let observerEntered = false;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const name = new URL(request.url).pathname;
      if (name === "/network") {
        await network.promise;
        return new Response("background network consumer");
      }
      if (name === "/interval") {
        await interval.promise;
        return new Response("background interval consumer");
      }
      observerEntered = true;
      await observer.promise;
      return new Response("observer released");
    },
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const service =
    `export function activate(ctx){const saved=ctx,accepted=[],completed=[];
    fetch('http://${authority}/network').then(r=>r.text()).then(async text=>accepted.push(await saved.actions.request('create',{path:'network-callback',content:text})));
    const stop=saved.timers.setInterval(async()=>{stop();const text=await(await fetch('http://${authority}/interval')).text();accepted.push(await saved.files.requestWrite('interval.md',new TextEncoder().encode(text)));},0);
    saved.hooks.on('on-sync',async()=>{await(await fetch('http://${authority}/observer')).text();});
    saved.actions.onResult(receipt=>completed.push(receipt));
    saved.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>({accepted,completed}));
  }`;
  const b = await bundle(
    ["network-callback.md", "interval.md"],
    ["network-callback.md", "interval.md"],
    {},
    service,
    ["on-sync"],
    {},
    { network: [authority] },
  );
  try {
    b.runtime.post("on-sync", {
      operationId: "unrelated-observer",
      action: "sync",
      origin: "api",
      timestamp: new Date().toISOString(),
      causalDepth: 7,
    });
    await wait(() => observerEntered);
    network.resolve();
    interval.resolve();
    await wait(() => b.notes.getPaths().length === 2);
    assertEquals(
      b.notes.get("network-callback").content,
      "background network consumer",
    );
    assertEquals(
      b.notes.get("interval").content,
      "background interval consumer",
    );
    assertEquals(b.indexer.search("background").map((row) => row.path).sort(), [
      "interval",
      "network-callback",
    ]);
    assertEquals(b.facts.length, 2);
    assert(
      b.facts.every((fact) =>
        fact.causalDepth === 1 && fact.causalParent !== "unrelated-observer"
      ),
    );
    for (const fact of b.facts) {
      assertEquals(
        (await b.receipt(fact.causalParent!)).operationId,
        fact.operationId,
      );
    }
    observer.resolve();
    const consumed = await b.runtime.invokeCommand(
      "requester",
      "inspect",
      {},
    ) as { accepted: { requestId: string }[]; completed: ActionReceipt[] };
    assertEquals(consumed.accepted.length, 2);
    assertEquals(
      consumed.completed.filter((receipt) => receipt.status === "completed")
        .length,
      2,
    );
    assertEquals(
      new Set(consumed.accepted.map((receipt) => receipt.requestId)),
      new Set(b.facts.map((fact) => fact.causalParent)),
    );
    console.log(
      JSON.stringify({
        noFileHooks: true,
        persistedWhileObserverHeld: true,
        causalDepths: b.facts.map((fact) => fact.causalDepth),
        completions: consumed.completed,
      }),
    );
  } finally {
    network.resolve();
    interval.resolve();
    observer.resolve();
    await receiver.shutdown();
    await b.dispose();
  }
});

Deno.test("plugin authority: disable and replacement abort accepted unstarted work without redirecting it to a new owner", async (t) => {
  for (const ending of ["disable", "replacement"] as const) {
    await t.step(ending, async () => {
      const accepted = Promise.withResolvers<string>(),
        release = Promise.withResolvers<void>();
      const receiver = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, async (request) => {
        accepted.resolve(new URL(request.url).searchParams.get("requestId")!);
        await release.promise;
        return new Response("old caller released");
      });
      const authority = `127.0.0.1:${receiver.addr.port}`;
      const service =
        `export function activate(ctx){ctx.commands.register({id:'hold',label:'Hold',target:'server'},async()=>{const receipt=await ctx.actions.request('create',{path:'old-owner',content:'must not start'});await(await fetch('http://${authority}/hold?requestId='+receipt.requestId)).text();return receipt;});ctx.commands.register({id:'positive',label:'Positive',target:'server'},()=>ctx.actions.request('create',{path:'new-owner',content:'new owner consumer'}));ctx.commands.register({id:'result',label:'Result',target:'server'},id=>ctx.actions.result(id));}`;
      const b = await bundle(["vault"], ["vault"], {}, service, [], {}, {
        network: [authority],
      });
      const caller = b.runtime.invokeCommand("requester", "hold", {}).catch(
        (error) => error,
      );
      try {
        let id: string | undefined;
        accepted.promise.then((value) => {
          id = value;
        });
        await wait(() => id !== undefined);
        assertEquals(
          b.actions.result("requester", b.generation, id!).status,
          "accepted",
        );
        b.sources[0].enabled = false;
        await b.runtime.reconcile();
        release.resolve();
        assert(await caller instanceof Error);
        await b.operations.createNote(
          { path: "control", content: "control" },
          api(),
        );
        assertEquals(b.notes.getPaths(), ["control"]);
        assertEquals(b.indexer.search("must not start"), []);
        assertEquals(
          b.actions.result("requester", b.generation, id!).status,
          "unavailable",
        );
        if (ending === "replacement") {
          b.sources[0].enabled = true;
          await b.runtime.reconcile();
          await wait(() => b.runtime.status("requester")?.status === "ready");
          const generation = b.runtime.status("requester")!.generation!;
          assert(generation !== b.generation);
          const fresh = await b.runtime.invokeCommand(
            "requester",
            "positive",
            {},
          ) as { requestId: string };
          await wait(() =>
            b.actions.result("requester", generation, fresh.requestId)
              .status === "completed"
          );
          const queried = await b.runtime.invokeCommand(
            "requester",
            "result",
            fresh.requestId,
          ) as ActionReceipt;
          assertEquals(queried.status, "completed");
          assertEquals(b.notes.get("new-owner").content, "new owner consumer");
          assertEquals(
            (await b.runtime.invokeCommand(
              "requester",
              "result",
              id!,
            ) as ActionReceipt).status,
            "unavailable",
          );
          assert(b.facts.every((fact) => fact.path !== "old-owner"));
        }
        console.log(
          JSON.stringify({
            ending,
            retiredRequest: id,
            oldOwnerEffects: 0,
            paths: b.notes.getPaths(),
          }),
        );
      } finally {
        release.resolve();
        await caller;
        await receiver.shutdown();
        await b.dispose();
      }
    });
  }
});

Deno.test("plugin authority: failed activation aborts its accepted mutation before readiness and leaves unrelated APIs available", async () => {
  const b = await bundle();
  const accepted = Promise.withResolvers<string>(),
    release = Promise.withResolvers<void>();
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      accepted.resolve(new URL(request.url).searchParams.get("requestId")!);
      await release.promise;
      return new Response("activation release");
    },
  );
  try {
    const authority = `127.0.0.1:${receiver.addr.port}`;
    const dir = await b.fixture.install("startup", {
      runtime: { server: "service.js" },
      capabilities: { write: ["vault"], network: [authority], imports: false },
    }, {
      "service.js":
        `export async function activate(ctx){const receipt=await ctx.actions.request('create',{path:'startup-forbidden',content:'must not start'});await(await fetch('http://${authority}/accepted?requestId='+receipt.requestId)).text();throw Error('activation failed');}`,
    });
    const manifest = readManifest(dir);
    b.sources.push({ id: "startup", enabled: true, manifest, hooks: [] });
    await approveFixtureNetwork(b.network, "startup");
    await b.runtime.reconcile();
    let id: string | undefined;
    accepted.promise.then((value) => {
      id = value;
    });
    await wait(() => id !== undefined);
    assertEquals(b.runtime.status("startup")?.status, "starting");
    const generation = b.runtime.status("startup")!.generation!;
    assertEquals(
      b.actions.result("startup", generation, id!).status,
      "accepted",
    );
    assertEquals(b.notes.getPaths(), []);
    release.resolve();
    await wait(() => b.runtime.status("startup")?.status === "failed");
    await b.operations.createNote({
      path: "control",
      content: "unrelated control",
    }, api());
    assertEquals(b.notes.getPaths(), ["control"]);
    assertEquals(b.indexer.search("must not start"), []);
    assertEquals(b.facts.map((fact) => fact.path), ["control"]);
    assertEquals(
      b.actions.result("startup", generation, id!).status,
      "unavailable",
    );
    console.log(
      JSON.stringify({
        activationAcceptanceObserved: true,
        readinessFailed: true,
        startupEffects: 0,
        independentControlPersisted: true,
      }),
    );
  } finally {
    release.resolve();
    await receiver.shutdown();
    await b.dispose();
  }
});

Deno.test("plugin authority: requester revoked while waiting for the managed operation lock cannot enter effects", async () => {
  const b = await bundle();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const requests: string[] = [];
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      requests.push(new URL(request.url).searchParams.get("path")!);
      entered.resolve();
      await release.promise;
      return new Response("healthy guard accepted");
    },
  );
  let first: Promise<unknown> | undefined;
  try {
    await b.operations.createNote({ path: "keep", content: "original" }, api());
    await b.operations.createNote(
      { path: "control", content: "control" },
      api(),
    );
    const authority = `127.0.0.1:${receiver.addr.port}`;
    const dir = await b.fixture.install("lock-guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save"],
      capabilities: { network: [authority], imports: false },
    }, {
      "service.js":
        `export function activate(ctx){ctx.hooks.on('pre-save',async fact=>{await(await fetch('http://${authority}/guard?path='+encodeURIComponent(fact.path))).text();});}`,
    });
    const manifest = readManifest(dir);
    b.sources.push({
      id: manifest.id,
      enabled: true,
      manifest,
      hooks: manifest.hooks,
    });
    await approveFixtureNetwork(b.network, manifest.id);
    await b.runtime.reconcile();
    await wait(() => b.runtime.status(manifest.id)?.status === "ready");
    b.facts.length = 0;
    let rejected: string | undefined;
    const original = b.operations.updateNote.bind(b.operations);
    b.operations.updateNote = (...args) =>
      original(...args).catch((error) => {
        if (args[0] === "keep") rejected = error.code;
        throw error;
      });
    first = b.operations.updateNote(
      "control",
      { newContent: "healthy control committed" },
      "none",
      api(),
    );
    first.catch(() => undefined);
    await entered.promise;
    const id = await b.request("save", {
      path: "keep",
      newContent: "forbidden late write",
    });
    await wait(() =>
      b.actions.result("requester", b.generation, id).status === "running"
    );
    assertEquals(
      requests,
      ["control"],
      "queued requester must still be behind the managed lock",
    );
    b.sources[0].enabled = false;
    await b.runtime.reconcile();
    assertEquals(b.runtime.status("lock-guard")?.status, "ready");
    release.resolve();
    await first;
    await wait(() => rejected !== undefined);
    assertEquals(rejected, "plugin_generation_revoked");
    assertEquals(b.notes.get("keep").content, "original");
    assertEquals(b.notes.get("control").content, "healthy control committed");
    assertEquals(b.indexer.search("forbidden"), []);
    assertEquals(b.facts.map((fact) => fact.path), ["control"]);
    assertEquals(
      b.actions.result("requester", b.generation, id).status,
      "unavailable",
    );
    assertEquals(requests, ["control"]);
  } finally {
    release.resolve();
    await first?.catch(() => undefined);
    await receiver.shutdown();
    await b.dispose();
  }
});

Deno.test("plugin authority: canonical H1 trimmed targets and frontmatter opt-out share the granted committed effects", async () => {
  const b = await bundle(["old/note.md", "old/Derived.md", "new/Allowed.md"]);
  try {
    await b.operations.createNote(
      { path: "old/note", content: "# note\nbody" },
      api(),
    );
    Deno.mkdirSync(`${b.fixture.vault}/new`);
    b.facts.length = 0;
    const derived = await b.receipt(
      await b.request("save", {
        path: "old/note",
        newContent: "# Derived\nbody",
      }),
    );
    assertEquals(derived.status, "completed");
    assertEquals(b.notes.getPaths(), ["old/Derived"]);
    assertEquals(b.facts.map((fact) => fact.action), ["rename", "save"]);
    assert(b.facts.every((fact) => fact.operationId === derived.operationId));
    const trimmed = await b.receipt(
      await b.request("rename", {
        path: "old/Derived",
        newPath: "  new/Allowed  ",
      }),
    );
    assertEquals(trimmed.status, "completed");
    assertEquals(b.notes.getPaths(), ["new/Allowed"]);
    assert(b.notes.get("new/Allowed").content!.startsWith("# Allowed"));
    const optedOut = await b.receipt(
      await b.request("save", {
        path: "new/Allowed",
        newContent: "---\ntitle: stable\n---\n# Uncovered title\nbody",
      }),
    );
    assertEquals(optedOut.status, "completed");
    assertEquals(b.notes.getPaths(), ["new/Allowed"]);
    assertEquals(
      b.notes.get("new/Allowed").content,
      "---\ntitle: stable\n---\n# Uncovered title\nbody",
    );
    assertEquals(b.indexer.search("Uncovered").map((row) => row.path), [
      "new/Allowed",
    ]);
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: write-only rename queries and subscriptions never disclose existing content or its title", async () => {
  const b = await bundle(["vault"], []);
  try {
    await b.operations.createNote({
      path: "original",
      content: "# Secret existing title\nprivate-existing-body",
    }, api());
    b.facts.length = 0;
    const id = await b.request("rename", {
      path: "original",
      newPath: "renamed",
    });
    const queried = await b.receipt(id);
    const subscribed = await b.runtime.invokeCommand(
      "requester",
      "latest",
      {},
    ) as ActionReceipt;
    assertEquals(queried.status, "completed");
    assertEquals(subscribed, queried);
    assertEquals(
      (queried.result as { contentAvailable: boolean }).contentAvailable,
      false,
    );
    assert(!JSON.stringify(queried).includes("private-existing-body"));
    assert(!JSON.stringify(queried).includes("Secret existing title"));
    assertEquals((queried.result as { title?: string }).title, undefined);
    assert(b.notes.get("renamed").content!.includes("private-existing-body"));
    assertEquals(queried.operationId, b.facts[0].operationId);
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: real independent pre and partial-effect observers project under their own read grants", async () => {
  let armed = false;
  const b = await bundle(["vault"], ["vault"], {
    afterRename() {
      if (armed) throw Error("after actual rename");
    },
  });
  try {
    await b.operations.createNote({
      path: "old/note",
      content: "# note\nprivate-existing-body",
    }, api());
    for (const [id, read] of [["narrow", ["new"]], ["none", []]] as const) {
      const dir = await b.fixture.install(id, {
        runtime: { server: "service.js" },
        hooks: ["pre-rename", "on-save", "on-operation-error"],
        capabilities: { read: [...read], write: [] },
      }, {
        "service.js":
          `export function activate(ctx){const events=[];for(const hook of ['pre-rename','on-save','on-operation-error'])ctx.hooks.on(hook,fact=>{events.push({hook,fact});});ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>events);}`,
      });
      const manifest = readManifest(dir);
      b.sources.push({ id, enabled: true, manifest, hooks: manifest.hooks });
    }
    await b.runtime.reconcile();
    await wait(() =>
      ["narrow", "none"].every((id) => b.runtime.status(id)?.status === "ready")
    );
    b.facts.length = 0;
    armed = true;
    const result = await b.receipt(
      await b.request("rename", { path: "old/note", newPath: "new/note" }),
    );
    assertEquals(result.status, "partial");
    assertEquals(
      b.notes.get("new/note").content,
      "# note\nprivate-existing-body",
    );
    assertEquals(b.indexer.search("private").map((row) => row.path), [
      "new/note",
    ]);
    type Event = { hook: string; fact: OperationFact };
    const narrow = await b.runtime.invokeCommand(
      "narrow",
      "inspect",
      {},
    ) as Event[];
    const none = await b.runtime.invokeCommand(
      "none",
      "inspect",
      {},
    ) as Event[];
    assertEquals(narrow.map((event) => event.hook), [
      "pre-rename",
      "on-save",
      "on-operation-error",
    ]);
    assertEquals(
      none.map((event) => event.hook),
      narrow.map((event) => event.hook),
    );
    assertEquals(narrow[0].fact.before?.contentAvailable, false);
    assertEquals(narrow[0].fact.proposed?.contentAvailable, true);
    assertEquals(
      narrow[1].fact.after?.content,
      "# note\nprivate-existing-body",
    );
    assert(!JSON.stringify(none).includes("private-existing-body"));
    assertEquals(none[0].fact.proposed?.contentAvailable, false);
    const narrowError = narrow[2].fact;
    assertEquals(narrowError.changedPaths, ["new/note"]);
    assertEquals(none[2].fact.changedPaths, []);
    assertEquals(none[2].fact.metadata?.effects, []);
    const effects = narrowError.metadata?.effects as {
      path?: string;
      oldPath?: string;
    }[];
    assert(
      effects.every((effect) =>
        !effect.oldPath && effect.path?.startsWith(`${b.fixture.vault}/new`)
      ),
    );
    assert(
      narrow.every((event) => event.fact.operationId === result.operationId),
    );
    assert(
      none.every((event) => event.fact.operationId === result.operationId),
    );
    console.log(
      JSON.stringify({
        senderRead: "vault",
        observerRead: ["new", "none"],
        actualPartialOperation: result.operationId,
        narrowEffects: effects,
        noneEffects: none[2].fact.metadata?.effects,
      }),
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("plugin authority: admitted file bytes are immutable even when the Worker supplied shared backing memory", async (t) => {
  for (const shared of [false, true]) {
    await t.step(shared ? "shared backing" : "ordinary backing", async () => {
      const accepted = Promise.withResolvers<string>(),
        release = Promise.withResolvers<void>();
      const receiver = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, async (request) => {
        accepted.resolve(new URL(request.url).searchParams.get("requestId")!);
        await release.promise;
        return new Response("origin released");
      });
      const authority = `127.0.0.1:${receiver.addr.port}`;
      const service =
        `export function activate(ctx){ctx.commands.register({id:'write',label:'Write',target:'server'},async()=>{const bytes=${
          shared
            ? "new Uint8Array(new SharedArrayBuffer(3))"
            : "new Uint8Array(3)"
        };bytes.set([65,66,67]);const receipt=await ctx.files.requestWrite('captured.bin',bytes);bytes.fill(90);await(await fetch('http://${authority}/accepted?requestId='+receipt.requestId)).text();return receipt;});}`;
      const b = await bundle(
        ["captured.bin"],
        ["captured.bin"],
        {},
        service,
        [],
        {},
        { network: [authority] },
      );
      const caller = b.runtime.invokeCommand("requester", "write", {});
      caller.catch(() => undefined);
      try {
        let id: string | undefined;
        accepted.promise.then((value) => {
          id = value;
        });
        await wait(() => id !== undefined);
        assertEquals(
          b.actions.result("requester", b.generation, id!).status,
          "accepted",
        );
        await assertRejects(
          () => Deno.stat(`${b.fixture.vault}/captured.bin`),
          Deno.errors.NotFound,
        );
        release.resolve();
        await caller;
        assertEquals((await b.receipt(id!)).status, "completed");
        assertEquals(
          await Deno.readFile(`${b.fixture.vault}/captured.bin`),
          new Uint8Array([65, 66, 67]),
        );
        assertEquals(b.notes.getPaths(), []);
        assertEquals(b.facts.map((fact) => fact.action), ["file-write"]);
        console.log(
          JSON.stringify({
            sharedBacking: shared,
            capturedBytes: [65, 66, 67],
            laterCallerBytes: [90, 90, 90],
            persistedBytes: [
              ...await Deno.readFile(`${b.fixture.vault}/captured.bin`),
            ],
          }),
        );
      } finally {
        release.resolve();
        await caller.catch(() => undefined);
        await receiver.shutdown();
        await b.dispose();
      }
    });
  }
});

Deno.test("plugin authority: sibling and relocated reserved writes deny while a granted external markdown write stays outside the note index", async () => {
  const b = await bundle([]);
  const service =
    `export function activate(ctx){ctx.commands.register({id:'note',label:'Note',target:'server'},args=>ctx.actions.request('create',args));ctx.commands.register({id:'file',label:'File',target:'server'},args=>ctx.files.requestWrite(args.path,new TextEncoder().encode(args.content)));ctx.commands.register({id:'result',label:'Result',target:'server'},id=>ctx.actions.result(id));}`;
  try {
    Deno.mkdirSync(`${b.fixture.vault}/allowed`);
    const reserved = `${b.fixture.statePath}/control.json`;
    Deno.writeTextFileSync(reserved, "preserved control bytes");
    for (
      const [id, write] of [
        ["narrow-writer", ["allowed"]],
        ["broad-writer", [b.fixture.root]],
      ] as const
    ) {
      const dir = await b.fixture.install(id, {
        runtime: { server: "service.js" },
        capabilities: { write: [...write], read: [] },
      }, { "service.js": service });
      const manifest = readManifest(dir);
      b.sources.push({ id, enabled: true, manifest, hooks: [] });
    }
    await b.runtime.reconcile();
    await wait(() =>
      ["narrow-writer", "broad-writer"].every((id) =>
        b.runtime.status(id)?.status === "ready"
      )
    );
    await assertRejects(() =>
      b.runtime.invokeCommand("narrow-writer", "note", {
        path: "allowed-sibling/escape",
        content: "forbidden sibling",
      })
    );
    await assertRejects(() =>
      b.runtime.invokeCommand("narrow-writer", "file", {
        path: "allowed-sibling/escape.bin",
        content: "forbidden sibling",
      })
    );
    await assertRejects(() =>
      b.runtime.invokeCommand("broad-writer", "file", {
        path: reserved,
        content: "forbidden reserved replacement",
      })
    );
    await assertRejects(() =>
      b.runtime.invokeCommand("broad-writer", "note", {
        path: "../relocated-state/escape",
        content: "forbidden reserved note",
      })
    );
    assertEquals(Deno.readTextFileSync(reserved), "preserved control bytes");
    assertEquals(b.notes.getPaths(), []);
    assertEquals(b.facts, []);
    await assertRejects(
      () => Deno.stat(`${b.fixture.vault}/allowed-sibling`),
      Deno.errors.NotFound,
    );
    const complete = async (id: string, requestId: string) => {
      const generation = b.runtime.status(id)!.generation!;
      await wait(() =>
        b.actions.result(id, generation, requestId).status === "completed"
      );
      return await b.runtime.invokeCommand(
        id,
        "result",
        requestId,
      ) as ActionReceipt;
    };
    const external = `${b.fixture.root}/external.md`;
    const externalRequest = await b.runtime.invokeCommand(
      "broad-writer",
      "file",
      {
        path: external,
        content: "external markdown consumer",
      },
    ) as { requestId: string };
    const externalReceipt = await complete(
      "broad-writer",
      externalRequest.requestId,
    );
    assertEquals(Deno.readTextFileSync(external), "external markdown consumer");
    assertEquals(b.notes.getPaths(), []);
    assertEquals(b.indexer.search("external"), []);
    assertEquals(b.facts.map((fact) => fact.action), ["file-write"]);
    assertEquals(externalReceipt.operationId, b.facts[0].operationId);
    const narrowRequest = await b.runtime.invokeCommand(
      "narrow-writer",
      "note",
      {
        path: "allowed/note",
        content: "granted narrow consumer",
      },
    ) as { requestId: string };
    await complete("narrow-writer", narrowRequest.requestId);
    assertEquals(
      b.notes.get("allowed/note").content,
      "granted narrow consumer",
    );
    assertEquals(b.indexer.search("granted").map((row) => row.path), [
      "allowed/note",
    ]);
  } finally {
    await b.dispose();
  }
});
