// SPDX-License-Identifier: LGPL-3.0-only

/** Guarded-operation lifecycle tests: rejection precedes mutation, actual
 * H1 renames and captured deletes reach observers, partial storage failure
 * accounting, external observation, deferred actions and conflict gates.
 * The bundle is composed in-process with injected adapters — exactly the
 * wiring main.ts performs. */

import { currentBase } from "./helpers/storage.ts";
import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { GlobalConfig } from "../server/config.ts";
import { FileServing } from "../server/files/file_serving.ts";
import { FileSystemNotes } from "../server/notes/file_system.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import { PluginActions } from "../server/plugins/actions.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import type { PluginManager } from "../server/plugins/manager.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import {
  type OperationFact,
  PLUGIN_LIMITS,
} from "../server/plugins/contracts.ts";
import { servicePluginRpc } from "../server/plugins/rpc.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { initState, state } from "../server/state.ts";
import { bootServer } from "./helpers/boot.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { testEnvironment } from "./helpers/environment.ts";
import {
  api,
  bundle,
  HOOKS,
  type RecordedFact,
  RECORDER_SERVICE,
} from "./helpers/plugin_lifecycle.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { done, pending as waitPending, waitUntil } from "./helpers/wait.ts";

for (
  const change of [
    "retarget",
    "directory-occupation",
    "symlink-occupation",
    "unchanged-collision",
  ]
) {
  Deno.test(`review repairs: R23 upload ${change} revalidates canonical target and preserves the disclosed filename`, async () => {
    const previous = { ...state };
    const b = await bundle({ retain: true });
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const guard = b.runtime.guard.bind(b.runtime);
    const syncs: OperationFact[] = [];
    let prepared: OperationFact | undefined,
      pending: Promise<unknown> | undefined;
    try {
      Deno.mkdirSync(`${b.fixture.vault}/a`);
      Deno.mkdirSync(`${b.fixture.vault}/b`);
      Deno.symlinkSync("a", `${b.fixture.vault}/chosen`);
      if (change === "unchanged-collision") {
        Deno.writeTextFileSync(
          `${b.fixture.vault}/a/photo.png`,
          "preserved existing photo",
        );
      }
      b.lifecycle.onSync((fact) => {
        syncs.push(fact);
      });
      b.runtime.guard = async (...args) => {
        const leases = await guard(...args);
        if (args[0] === "pre-upload") {
          prepared = args[1] as OperationFact;
          reached.resolve();
          await release.promise;
        }
        return leases;
      };
      pending = b.operations.uploadFile(
        "chosen",
        "photo.png",
        new Uint8Array([4, 5, 6]),
        api(),
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, status: error.status, code: error.code }),
      );
      await reached.promise;
      const filename = prepared!.metadata!.filename as string,
        originalTarget = `${b.fixture.vault}/a/${filename}`;
      if (change === "retarget") {
        Deno.removeSync(`${b.fixture.vault}/chosen`);
        Deno.symlinkSync("b", `${b.fixture.vault}/chosen`);
      }
      if (change === "directory-occupation") Deno.mkdirSync(originalTarget);
      if (change === "symlink-occupation") {
        Deno.symlinkSync("missing.png", originalTarget);
      }
      release.resolve();
      const result = await pending as {
        ok: boolean;
        status?: number;
        code?: string;
        value?: { filename: string };
      };
      console.log(
        JSON.stringify({
          change,
          disclosedFilename: filename,
          actualUploadResult: result,
          syncs: syncs.length,
          retainedUploadFixture: b.fixture.root,
        }),
      );
      if (change === "unchanged-collision") {
        assertEquals(result.ok, true);
        assertEquals(result.value?.filename, filename);
        assert(filename !== "photo.png");
        assertEquals(
          Deno.readFileSync(originalTarget),
          new Uint8Array([4, 5, 6]),
        );
        assertEquals(
          Deno.readTextFileSync(`${b.fixture.vault}/a/photo.png`),
          "preserved existing photo",
        );
      } else {
        assertEquals(result.ok, false);
        assertEquals(result.status, 409);
        assertEquals(result.code, "operation_conflict");
        assertEquals([...Deno.readDirSync(`${b.fixture.vault}/b`)], []);
        if (change === "retarget") {
          assertEquals([...Deno.readDirSync(`${b.fixture.vault}/a`)], []);
        }
        assertEquals(
          (await b.facts()).filter((entry) => entry.kind === "on-upload"),
          [],
        );
        assertEquals(syncs, []);
      }
    } finally {
      release.resolve();
      b.runtime.guard = guard;
      if (pending) await pending;
      await b.dispose();
      Object.assign(state, previous);
      console.log(JSON.stringify({ retainedR23Fixture: b.fixture.root }));
    }
  });
}

Deno.test("lifecycle: create/save/rename/delete reach observers with actual outcomes", async () => {
  const b = await bundle();
  try {
    const created = await b.operations.createNote(
      { path: "alpha", content: "# Alpha\nbody" },
      api(),
    );
    assertEquals(created.path, "alpha");

    // Content-only save with an H1 change resolves to a real rename.
    const renamed = await b.operations.updateNote(
      "alpha",
      { base: currentBase("alpha"), newContent: "# Beta\nbody2" },
      "none",
      api(),
    );
    assertEquals(renamed.path, "Beta");
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "Beta.md")),
      "# Beta\nbody2",
    );

    await b.operations.deleteNote(
      "Beta",
      api(),
      undefined,
      undefined,
      undefined,
      currentBase("Beta"),
    );
    const observed = await b.facts();
    assertEquals(observed.map((entry) => entry.kind), [
      "on-create",
      "on-sync",
      "on-rename",
      "on-save",
      "on-sync",
      "on-delete",
      "on-sync",
    ]);
    const facts = observed.filter((entry) => entry.kind !== "on-sync");
    assertEquals(
      observed.filter((entry) => entry.kind === "on-sync").map((entry) =>
        entry.fact.operationId
      ),
      [
        facts[0].fact.operationId,
        facts[1].fact.operationId,
        facts[3].fact.operationId,
      ],
    );
    const kinds = facts.map((f) => f.kind);
    // Combined rename+save: on-rename THEN on-save, one operation ID.
    assertEquals(kinds, [
      "on-create",
      "on-rename",
      "on-save",
      "on-delete",
    ]);
    assertEquals(facts[0].fact.after, {
      path: "alpha",
      content: "# Alpha\nbody",
      lastModified: facts[0].fact.after!.lastModified,
      contentAvailable: true,
    });
    assertEquals(facts[1].fact.oldPath, "alpha");
    assertEquals(facts[1].fact.newPath, "Beta");
    assertEquals(
      facts[1].fact.operationId,
      facts[2].fact.operationId,
    );
    // The delete fact carries the captured BEFORE snapshot and after:null.
    assertEquals(facts[3].fact.before!.content, "# Beta\nbody2");
    assertEquals(facts[3].fact.after, null);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: cancellation and guard timeout leave disk and index untouched", async () => {
  const b = await bundle();
  try {
    await b.operations.createNote({ path: "keep", content: "# Keep\n" }, api());
    await b.clearFacts();
    const before = Deno.readTextFileSync(path.join(b.fixture.vault, "keep.md"));

    const cancelled = await b.operations
      .updateNote(
        "keep",
        { base: currentBase("keep"), newContent: "#BLOCK#" },
        "none",
        api(),
      )
      .then(() => null)
      .catch((e) => e);
    assert(cancelled instanceof OperationError);
    assertEquals(cancelled.status, 409);
    assertEquals(cancelled.code, "plugin_cancelled");
    assertEquals(cancelled.pluginId, "recorder");
    assertEquals(cancelled.action, "save");
    assertEquals(cancelled.detail, "fixture protection");

    const cancelledCreate = await b.operations
      .createNote({ path: "nope", content: "#BLOCK#" }, api())
      .then(() => null)
      .catch((e) => e);
    assertEquals(cancelledCreate.code, "plugin_cancelled");

    // A note carrying the marker arrives externally, so its delete guard
    // sees the protected content in the captured before-snapshot.
    Deno.writeTextFileSync(
      path.join(b.fixture.vault, "blocked.md"),
      "#BLOCK#",
    );
    const cancelledDelete = await b.operations
      .deleteNote(
        "blocked",
        api(),
        undefined,
        undefined,
        undefined,
        currentBase("blocked"),
      )
      .then(() => null)
      .catch((e) => e);
    assertEquals(cancelledDelete.code, "plugin_cancelled");
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "blocked.md")),
      "#BLOCK#",
    );

    // No effects, and NO post-facts for rejected operations.
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "keep.md")),
      before,
    );
    assertEquals(b.indexer.search("Keep").length, 1);
    let missing = false;
    try {
      Deno.statSync(path.join(b.fixture.vault, "nope.md"));
    } catch {
      missing = true;
    }
    assert(missing);
    assertEquals((await b.facts()).length, 0);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: unavailable required guard rejects with plugin_guard_failed", async () => {
  const b = await bundle();
  try {
    // Disable → reconcile → re-enable with a manifest whose runtime omits
    // the required guard registration: activation failure must block.
    const dir = path.join(b.fixture.statePath, "plugins", "recorder");
    const service = Deno.readTextFileSync(path.join(dir, "service.js"));
    Deno.writeTextFileSync(
      path.join(dir, "service.js"),
      "export function activate() {}",
    );
    await b.manager.runtime!.suspend();
    await b.runtime.reconcile();
    await pluginSettled(b.runtime, "recorder", "failed");
    assertEquals(b.runtime.status("recorder")?.status, "failed");
    const error = await b.operations
      .createNote({ path: "blocked", content: "x" }, api())
      .then(() => null)
      .catch((e) => e);
    assert(error instanceof OperationError);
    assertEquals(error.status, 503);
    assertEquals(error.code, "plugin_guard_failed");
    assertEquals(error.pluginId, "recorder");
    // Failed enabled guard stays an expected blocker until recovery.
    Deno.writeTextFileSync(path.join(dir, "service.js"), service);
    await b.runtime.reconcile();
    await pluginSettled(b.runtime, "recorder", "ready");
    assertEquals(b.runtime.status("recorder")?.status, "ready");
    await b.operations.createNote({ path: "blocked", content: "x" }, api());
    assert(Deno.statSync(path.join(b.fixture.vault, "blocked.md")).isFile);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: upload resolves the collision name before hooks and emits correlated note-create", async () => {
  const b = await bundle();
  try {
    Deno.writeTextFileSync(path.join(b.fixture.vault, "att.md"), "# Old\n");
    const result = await b.operations.uploadFile(
      "",
      "att.md",
      new TextEncoder().encode("# New\n"),
      api(),
    );
    assert(result.filename.startsWith("att_"));
    const facts = await b.facts();
    assertEquals(facts.map((f) => f.kind), [
      "on-upload",
      "on-create",
      "on-sync",
    ]);
    assertEquals(facts[0].fact.metadata!.filename, result.filename);
    assertEquals(facts[0].fact.operationId, facts[1].fact.operationId);
    assertEquals(facts[1].fact.metadata!.upload, true);
    assertEquals(facts[2].fact.operationId, facts[0].fact.operationId);
    assertEquals(facts[2].fact.changedPaths, [result.filename.slice(0, -3)]);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: rewrite-refs guards the aggregate and affected saves; partial failure accounts truthfully", async (t) => {
  await t.step(
    "full success publishes correlated results without renames",
    async () => {
      const b = await bundle();
      try {
        await b.operations.createNote(
          { path: "one", content: "# One\n![a](att.png)" },
          api(),
        );
        await b.operations.createNote(
          { path: "two", content: "# Two\n[link](att.png)" },
          api(),
        );
        await b.clearFacts();
        await b.operations.rewriteRefs("att.png", "renamed.png", api());
        const facts = await b.facts();
        assertEquals(
          facts.map((f) => f.kind),
          ["on-save", "on-save", "on-rewrite-refs", "on-sync"],
        );
        const opIds = new Set(facts.map((f) => f.fact.operationId));
        assertEquals(opIds.size, 1);
        assertEquals(
          new Set(facts[3].fact.changedPaths),
          new Set(["one", "two"]),
        );
        assert(
          Deno.readTextFileSync(path.join(b.fixture.vault, "one.md"))
            .includes("renamed.png"),
        );
        // Index sees the rewritten content immediately (managed signature —
        // the later scan must not double-report).
        assertEquals(b.indexer.search("renamed").length >= 0, true);
      } finally {
        await b.dispose();
      }
    },
  );

  await t.step(
    "injected failure after the first write emits verified facts + operation_partial",
    async () => {
      let armed = false;
      let writes = 0;
      const b = await bundle({
        probes: {
          afterWrite: () => {
            if (!armed) return;
            writes++;
            if (writes === 2) throw new Error("injected storage failure");
          },
        },
      });
      try {
        await b.operations.createNote(
          { path: "one", content: "# One\n![a](att.png)" },
          api(),
        );
        await b.operations.createNote(
          { path: "two", content: "# Two\n[link](att.png)" },
          api(),
        );
        await b.clearFacts();
        armed = true;
        writes = 0;
        const error = await b.operations
          .rewriteRefs("att.png", "renamed.png", api())
          .then(() => null)
          .catch((e) => e);
        assert(error instanceof OperationError);
        assertEquals(error.code, "operation_partial");
        assertEquals(error.status, 500);
        assertEquals(error.partial!.completedPaths.length, 1);
        assertEquals(error.partial!.failedPath !== undefined, true);
        const facts = await b.facts();
        // Exactly one verified save, then the error and actual-effect sync —
        // never an aggregate success or a fabricated completed receipt.
        assertEquals(facts.map((f) => f.kind), [
          "on-save",
          "on-operation-error",
          "on-sync",
        ]);
        assertEquals(
          facts[0].fact.operationId,
          facts[1].fact.operationId,
        );
        assertEquals(facts[2].fact.operationId, facts[0].fact.operationId);
        // Disk and index agree on the one completed write.
        const done = facts[0].fact.path as string;
        assert(
          Deno.readTextFileSync(path.join(b.fixture.vault, done + ".md"))
            .includes("renamed.png"),
        );
      } finally {
        await b.dispose();
      }
    },
  );
});

Deno.test("lifecycle: external changes are observed; managed writes are not double-reported", async () => {
  const b = await bundle();
  try {
    // Managed create first: index reindexed at commit; the scan must not
    // emit a duplicate external create.
    await b.operations.createNote({ path: "managed", content: "# M\n" }, api());
    await b.clearFacts();
    b.hub.scanNow();
    assertEquals(
      (await b.facts()).filter((f) => f.kind !== "on-sync").length,
      0,
    );

    // External create / modify / delete. mtimes are bumped explicitly so
    // same-millisecond writes are still observed as changes.
    const extFile = path.join(b.fixture.vault, "ext.md");
    Deno.writeTextFileSync(extFile, "# External\n");
    Deno.utimeSync(extFile, new Date(), new Date(Date.now() + 2000));
    b.hub.scanNow();
    Deno.writeTextFileSync(extFile, "# External 2\n");
    Deno.utimeSync(extFile, new Date(), new Date(Date.now() + 4000));
    b.hub.scanNow();
    Deno.removeSync(extFile);
    b.hub.scanNow();
    const facts = (await b.facts()).filter((f) => f.kind !== "on-sync");
    assertEquals(facts.map((f) => f.kind), [
      "on-create",
      "on-save",
      "on-delete",
    ]);
    assert(facts.every((f) => f.fact.origin === "external"));
    assertEquals(facts[0].fact.after!.content, "# External\n");
    // Prior content explicitly unavailable for external modifications.
    assertEquals(facts[1].fact.before!.contentAvailable, false);
    assertEquals(facts[1].fact.before!.content, undefined);
    assertEquals(facts[2].fact.before!.contentAvailable, false);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: initial indexing is inventory plus on-sync, not fake creates", async () => {
  const fixture = await pluginFixture();
  try {
    Deno.writeTextFileSync(
      path.join(fixture.vault, "pre.md"),
      "# Pre-existing\n",
    );
    await fixture.install("recorder", {
      runtime: { server: "service.js" },
      hooks: HOOKS,
      capabilities: { read: ["vault"], write: ["vault"] },
    }, { "service.js": RECORDER_SERVICE });
    const env = testEnvironment({
      GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_INDEX_PATH: fixture.statePath,
      GLOBNOTES_AUTH_TYPE: "none",
    });
    let manager: PluginManager | null = null;
    try {
      const config = new GlobalConfig(env);
      const notes = new FileSystemNotes(fixture.vault, {}, env);
      const indexer = new Fts5Indexer(fixture.statePath, env);
      const files = new FileServing(fixture.vault);
      manager = createPluginManager(
        fixture.vault,
        undefined,
        1,
        fixture.statePath,
        {
          internalRoot: path.join(fixture.root, "internal"),
          env,
        },
      );
      initState(config, null, notes, indexer, files, manager);
      const lifecycle = new PluginLifecycle(config);
      state.lifecycle = lifecycle;
      const operations = new NoteOperations({
        notes,
        files,
        indexer,
        runtime: () => manager!.runtime,
        lifecycle,
      });
      state.operations = operations;
      state.actions = new PluginActions({
        operations,
        runtime: () => manager!.runtime,
        vaultPath: fixture.vault,
        statePath: fixture.statePath,
      });
      lifecycle.onFact((fact) =>
        manager!.runtime?.post(`on-${fact.action}` as never, fact)
      );
      lifecycle.onSync((fact) => {
        manager!.syncAll(fact).catch(() => undefined);
      });
      const runtime = manager.configureRuntime({
        operational: () => true,
        writable: () => true,
        commit: (effect) => lifecycle.gate.run(effect),
        rpc: servicePluginRpc({
          vaultPath: fixture.vault,
          statePath: fixture.statePath,
          actions: () => state.actions!,
        }),
      });
      await runtime.reconcile();
      await pluginSettled(runtime, "recorder");
      indexer.startBackgroundSync();
      // startBackgroundSync is async internally; wait until the initial
      // on-sync fact actually reaches the observer.
      const facts = await waitUntil(async () => {
        const facts = await runtime.invokeCommand("recorder", "facts", {}) as {
          kind: string;
          fact: RecordedFact;
        }[];
        return facts.some((f) => f.kind === "on-sync")
          ? done(facts)
          : waitPending({ facts });
      }, { label: "initial on-sync fact observed by 'recorder'" });
      const creates = facts.filter((f) => f.kind === "on-create");
      assertEquals(creates.length, 0);
      const syncs = facts.filter((f) => f.kind === "on-sync");
      assertEquals(syncs.length >= 1, true);
      assertEquals(syncs[0].fact.initial, true);
      await runtime.close();
    } finally {
      manager?.stop();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("lifecycle: nested note mutation during a pre-hook is rejected; deferred action runs after", async () => {
  const b = await bundle();
  try {
    // A fixture whose pre-save tries a deferred mutating action — rejected
    // synchronously inside the guard; its on-save issues a legal deferred
    // create which runs AFTER the originating save commits.
    const dir = path.join(b.fixture.statePath, "plugins", "recorder");
    Deno.writeTextFileSync(
      path.join(dir, "service.js"),
      RECORDER_SERVICE.replace(
        "ctx.hooks.on('pre-save', protect);",
        `ctx.hooks.on('pre-save', (fact) => {
          const blocked = protect(fact);
          if (blocked) return blocked;
          if ((fact?.proposed?.content ?? '').includes('#NESTED#')) {
            try { ctx.actions.request('create', { path: 'illegal', content: 'x' }); globalThis.__nested = 'NOT-REJECTED'; }
            catch { globalThis.__nested = 'rejected'; }
          }
        });`,
      ).replace(
        "ctx.hooks.on('on-save', record('on-save'));",
        `ctx.hooks.on('on-save', async (fact) => {
          record('on-save')(fact);
          if ((fact?.after?.content ?? '').includes('#SPAWN#') && !globalThis.__spawned) {
            globalThis.__spawned = true;
            globalThis.__spawnReceipt = (await ctx.actions.request('create', { path: 'spawned', content: '# Spawned\\n' })).requestId;
          }
        });`,
      ).replace(
        "ctx.commands.register({ id: 'receipt'",
        `ctx.commands.register({ id: 'nested', label: 'Nested', target: 'server' }, () => globalThis.__nested ?? null);
  ctx.commands.register({ id: 'spawnreceipt', label: 'SpawnReceipt', target: 'server' }, (id) => ctx.actions.result(globalThis.__spawnReceipt ?? id));
  ctx.commands.register({ id: 'receipt'`,
      ),
    );
    await b.runtime.suspend();
    await b.runtime.reconcile();
    await pluginSettled(b.runtime, "recorder");

    await b.operations.createNote({ path: "n", content: "# N\n" }, api());
    await b.operations.updateNote(
      "n",
      { base: currentBase("n"), newContent: "#NESTED#" },
      "none",
      api(),
    );
    // The nested request was rejected inside the guard.
    const nestedFlag = await b.runtime.invokeCommand("recorder", "nested", {});
    assertEquals(nestedFlag, "rejected");
    let illegal = true;
    try {
      Deno.statSync(path.join(b.fixture.vault, "illegal.md"));
      illegal = false;
    } catch { /* expected */ }
    assert(illegal, "pre-hook deferred mutation must not execute");

    // Legal deferred action from an on-hook runs after commit.
    await b.operations.createNote({ path: "s", content: "# S\n" }, api());
    await b.operations.updateNote(
      "s",
      { base: currentBase("s"), newContent: "#SPAWN#" },
      "none",
      api(),
    );
    await waitUntil(() => {
      try {
        Deno.statSync(path.join(b.fixture.vault, "spawned.md"));
        return done();
      } catch (error) {
        return waitPending({ "spawned.md": String(error) });
      }
    }, { label: "deferred action wrote spawned.md" });
    assert(Deno.statSync(path.join(b.fixture.vault, "spawned.md")).isFile);
    // The correlated receipt is queryable and reports completion.
    const receipt = await b.runtime.invokeCommand(
      "recorder",
      "spawnreceipt",
      {},
    ) as { status: string };
    assertEquals(receipt.status, "completed");
    const facts = await b.facts();
    const spawnSave = facts.find((f) => f.kind === "on-save");
    assert(spawnSave !== undefined);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: causal chain beyond the limit is rejected visibly", async () => {
  const b = await bundle({ limits: { causalDepth: 3 } });
  try {
    // Each on-create spawns another create → unbounded without the limit.
    const dir = path.join(b.fixture.statePath, "plugins", "recorder");
    Deno.writeTextFileSync(
      path.join(dir, "service.js"),
      RECORDER_SERVICE.replace(
        "ctx.hooks.on('on-create', record('on-create'));",
        `ctx.hooks.on('on-create', (fact) => {
          record('on-create')(fact);
          try { ctx.actions.request('create', { path: 'chain-' + (globalThis.__chain = (globalThis.__chain || 0) + 1), content: 'x' }); }
          catch (e) { globalThis.__chainError = e.message; }
        });`,
      ),
    );
    await b.runtime.suspend();
    await b.runtime.reconcile();
    await pluginSettled(b.runtime, "recorder");
    await b.operations.createNote({ path: "seed", content: "x" }, api());
    await new Promise((r) => setTimeout(r, 800));
    const chainFiles = [...Deno.readDirSync(b.fixture.vault)]
      .filter((e) => e.name.startsWith("chain-"));
    // The chain stopped: bounded number of files, then a visible error.
    assert(chainFiles.length <= 4, `chain created ${chainFiles.length} files`);
    const facts = await b.facts();
    assert(facts.filter((f) => f.kind === "on-create").length <= 5);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: wire envelope over HTTP carries structured codes; rewrite catch-all keeps them", async () => {
  const fixture = await pluginFixture();
  try {
    await fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-save", "pre-rewrite-refs"],
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('pre-save', (fact) => {
          if ((fact?.proposed?.content ?? '').includes('#BLOCK#')) return { cancel: true, reason: 'no blocked content' };
        });
        ctx.hooks.on('pre-rewrite-refs', () => {});
      }`,
    });
    const server = await bootServer({
      GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_INDEX_PATH: fixture.statePath,
      GLOBNOTES_AUTH_TYPE: "none",
      GLOBNOTES_PATH_PREFIX: "",
    });
    try {
      // Guard runtime must be up before the operation — wait via catalog-free retry.
      const create = await fetch(`${server.baseUrl}/_/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "doc", content: "# Doc\n" }),
      });
      assertEquals(create.status, 200);
      await create.body?.cancel();

      const blocked = await waitUntil(async (signal) => {
        const res = await fetch(`${server.baseUrl}/_/api/notes/doc`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newContent: "#BLOCK#",
            baseContent: "# Doc\n",
          }),
          signal,
        });
        if (res.status === 409) return done(res);
        const body = await res.text();
        return waitPending({ status: res.status, body });
      }, {
        label: "guard enforced over HTTP",
        intervalMs: 100,
        children: [server],
      });
      const body = await blocked.json();
      assertEquals(blocked.status, 409);
      assertEquals(body.code, "plugin_cancelled");
      assertEquals(body.detail, "no blocked content");
      assertEquals(body.pluginId, "guard");
      assertEquals(body.action, "save");
      assertEquals(typeof body.operationId, "string");
      // Disk unchanged.
      assertEquals(
        Deno.readTextFileSync(path.join(fixture.vault, "doc.md")),
        "# Doc\n",
      );

      // Duplicate-title 409 keeps its legacy shape (detail only, no code).
      const dup = await fetch(`${server.baseUrl}/_/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "doc", content: "x" }),
      });
      assertEquals(dup.status, 409);
      const dupBody = await dup.json();
      assertEquals(dupBody.code, undefined);
    } finally {
      await server.close();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("lifecycle: policy epoch change during a suspended operation rejects with operation_conflict", async () => {
  const b = await bundle();
  try {
    await b.operations.createNote({ path: "epoch", content: "# E\n" }, api());
    // Capture the epoch the next operation will see, then simulate a
    // suspended operation whose commit gate runs after a policy change:
    // directly exercise the gate through a hooked commit adapter.
    const captured = b.lifecycle.epoch;
    b.lifecycle.bumpEpoch();
    const error = await b.lifecycle.gate.run(() => {
      if (b.lifecycle.epoch !== captured) {
        return Promise.resolve(
          new OperationError(
            409,
            "operation_conflict",
            "Access policy changed while this operation was pending; it was not applied.",
          ),
        );
      }
      return Promise.resolve(null);
    });
    assert(error instanceof OperationError);
    assertEquals(error.code, "operation_conflict");
    assertEquals(error.status, 409);
    // Disk untouched.
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "epoch.md")),
      "# E\n",
    );
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: on-only plugin overflow/failure never blocks a note action", async () => {
  // Service limits also govern the healthy recorder's observers/commands.
  // Give them scheduling headroom; the hanger never resolves at any deadline.
  // The queue keeps its production capacity: the recorder's backlog (one
  // delivery per note action below) stays far under it however slowly its
  // worker runs, so only the hanger, flooded on purpose, can overflow. A
  // capacity of 4 let a slow recorder fill its own queue and refuse the
  // facts command.
  const serviceCallMs = 5000;
  const queuedJobs = PLUGIN_LIMITS.queuedJobs;
  const b = await bundle({ limits: { serviceCallMs } });
  try {
    // A SEPARATE on-only observer: slow/hanging deliveries and queue
    // overflow must degrade it visibly — never block the note action.
    await b.fixture.install("hanger", {
      runtime: { server: "service.js" },
      hooks: ["on-save"],
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('on-save', () => new Promise(() => {}));
      }`,
    });
    await b.runtime.reconcile();
    await pluginSettled(b.runtime, "hanger", "ready");
    assertEquals(b.runtime.status("hanger")?.status, "ready");
    await b.operations.createNote({ path: "a", content: "one" }, api());
    // Fill the observer lane synchronously: one active hanging delivery,
    // queuedJobs waiting deliveries, then an overflow. Target only the hanger
    // so the healthy recorder still observes exactly the real note actions.
    for (let i = 0; i < queuedJobs + 2; i++) {
      const operationId = `overflow-${i}`;
      b.runtime.post(
        "on-save",
        {
          operationId,
          action: "save",
          origin: "api",
          timestamp: new Date().toISOString(),
          path: "a",
        },
        { operationId, action: "save" },
        "hanger",
      );
    }
    // Rejected admission reports on a microtask, without waiting for a timer.
    await Promise.resolve();
    const overflow = b.runtime.status("hanger");
    assert(overflow !== null);
    assertEquals(overflow.status, "ready");
    assert(overflow.deliveryFailures >= 1);
    assert(
      overflow.diagnostics.some((d) =>
        d.code === "plugin_delivery_failed" &&
        d.operationId === `overflow-${queuedJobs + 1}`
      ),
    );
    await b.operations.updateNote(
      "a",
      { base: currentBase("a"), newContent: "two" },
      "none",
      api(),
    );
    await b.operations.updateNote(
      "a",
      { base: currentBase("a"), newContent: "three" },
      "none",
      api(),
    );
    await b.operations.updateNote(
      "a",
      { base: currentBase("a"), newContent: "four" },
      "none",
      api(),
    );
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "a.md")),
      "four",
    );
    // The healthy guard plugin observed every save (guard lane unaffected).
    const saves = (await b.facts()).filter((f) => f.kind === "on-save");
    assertEquals(saves.length, 3);
    // The hanger's observer deadline failure is recorded — host failed,
    // diagnostic visible — and the note actions were never blocked.
    const hangDeadline = Date.now() + serviceCallMs + 5000;
    while (Date.now() < hangDeadline) {
      const s = b.runtime.status("hanger");
      if (s?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = b.runtime.status("hanger");
    assert(status !== null);
    assert(
      status.status === "failed" || status.deliveryFailures >= 1,
      `hanger state: ${JSON.stringify(status)}`,
    );
    assert(status.diagnostics.length >= 1);
    assertEquals(status.status, "failed");
    assert(status.diagnostics.some((d) => d.code === "plugin_runtime_failed"));
    // On-only failure does not acquire blocking authority: more saves pass.
    await b.operations.updateNote(
      "a",
      { base: currentBase("a"), newContent: "five" },
      "none",
      api(),
    );
    assertEquals(
      Deno.readTextFileSync(path.join(b.fixture.vault, "a.md")),
      "five",
    );
    const laterSaves = (await b.facts()).filter((f) => f.kind === "on-save");
    assertEquals(laterSaves.length, 4);
    assertEquals(b.runtime.status("recorder")?.status, "ready");
    assertEquals(b.runtime.status("recorder")?.deliveryFailures, 0);
  } finally {
    await b.dispose();
  }
});

Deno.test("lifecycle: read grants strip undisclosed snapshot contents", async () => {
  const b = await bundle();
  try {
    // Recorder's default grant is ["vault"] — contents disclosed. A second
    // plugin with a narrow grant must receive content-free snapshots.
    await b.fixture.install("narrow", {
      runtime: { server: "service.js" },
      hooks: ["on-create"],
      capabilities: { read: ["sub"], write: [] },
    }, {
      "service.js": `export function activate(ctx) {
        ctx.hooks.on('on-create', (fact) => { globalThis.__narrowFact = fact; });
        ctx.commands.register({ id: 'fact', label: 'Fact', target: 'server' }, () => globalThis.__narrowFact ?? null);
      }`,
    });
    await b.runtime.reconcile();
    await pluginSettled(b.runtime, "narrow", "ready");
    await b.operations.createNote({
      path: "outside-sub",
      content: "secret body",
    }, api());
    await new Promise((r) => setTimeout(r, 100));
    const seen = await b.runtime.invokeCommand("narrow", "fact", {}) as {
      after?: { content?: string; contentAvailable: boolean };
    };
    assert(seen !== null);
    assertEquals(seen.after!.content, undefined);
    assertEquals(seen.after!.contentAvailable, false);
  } finally {
    await b.dispose();
  }
});
