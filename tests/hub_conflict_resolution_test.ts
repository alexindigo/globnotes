// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { readConflict } from "../server/hub/conflicts.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import {
  PluginGuardError,
  type PluginRuntime,
} from "../server/plugins/runtime.ts";
import type { HookName, OperationFact } from "../server/plugins/contracts.ts";
import { AuthType } from "../server/config.ts";
import { HubGate } from "../server/hub/gate.ts";
import { versionOf } from "../server/hub/merge.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";
import { subscribeIndex } from "../server/hub/subscribers.ts";
import resolve from "../server/api/endpoints/_/api/conflicts/%23id/resolve/post.ts";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "../server/state.ts";
import { VaultHub } from "../server/hub/hub.ts";

const actions = ["original", "copy", "both", "merge"] as const;
function pair(f: ReturnType<typeof hubOperationsFixture>) {
  Deno.writeTextFileSync(
    `${f.vault}/original.md`,
    "\ufeff# Original\r\n[link](asset.bin)\r\n",
  );
  Deno.writeTextFileSync(`${f.vault}/copy.md`, "\ufeff# Copy\r\n");
  f.hub.recordConflict({
    id: "pair",
    path: "original.md",
    copyPath: "copy.md",
    peer: "globnotes",
    reason: "stale-base",
    state: "open",
    createdAt: "2026-11-07T00:00:00Z",
    resolvedAt: null,
  });
  const detail = readConflict(
    { hub: f.hub, stateRoot: f.config.statePath },
    "pair",
  );
  assert(detail.state === "open");
  return {
    revision: detail.revision,
    base: {
      original: { kind: "version", version: detail.original.version },
      copy: { kind: "version", version: detail.copy.version },
    },
  };
}

Deno.test("conflict resolution: each explicit choice has only its exact fixed-path effects", async () => {
  for (const action of actions) {
    const f = hubOperationsFixture();
    try {
      const reviewed = pair(f);
      const original = Deno.readFileSync(`${f.vault}/original.md`),
        copy = Deno.readFileSync(`${f.vault}/copy.md`);
      const draft = "\ufeff# A different heading\r\n[link](asset.bin)\n";
      const seq = f.hub.sequence();
      const result = await f.operations.resolveConflict("pair", {
        ...reviewed,
        action,
        ...(action === "merge" ? { content: draft } : {}),
      }, f.api());
      assertEquals(result.status, "settled");
      assert("action" in result);
      assertEquals(result.action, action);
      assertEquals(
        Deno.readFileSync(`${f.vault}/original.md`),
        action === "copy"
          ? copy
          : action === "merge"
          ? new TextEncoder().encode(draft)
          : original,
      );
      assertEquals(
        [...Deno.readDirSync(f.vault)].map((e) => e.name).sort(),
        action === "both" ? ["copy.md", "original.md"] : ["original.md"],
      );
      assertEquals(f.hub.conflict("pair")!.state, "resolved");
      assertEquals(
        f.hub.conflict("pair")!.path,
        action === "both" ? "original.md" : null,
      );
      if (action === "both") assertEquals(f.hub.sequence(), seq);
      assertEquals(result.removed, action === "both" ? [] : ["copy.md"]);
      assert(
        f.hub.changesSince(seq).entries.every((e) =>
          e.peer === "globnotes" && e.origin === "api"
        ),
      );
    } finally {
      f.close();
    }
  }
});

function guarded(
  f: ReturnType<typeof hubOperationsFixture>,
  guard: (hook: HookName, fact: OperationFact) => unknown,
) {
  const runtime = {
    limits: { preOperationMs: 5000 },
    guard,
    assertGuardAuthority() {},
  } as unknown as PluginRuntime;
  return new NoteOperations({
    notes: f.notes,
    files: f.files,
    hub: f.hub,
    indexer: null,
    lifecycle: f.lifecycle,
    runtime: () => runtime,
  });
}

Deno.test("conflict resolution: cancellation of either guard leaves every member unchanged", async () => {
  for (const stopped of ["pre-save", "pre-delete"] as const) {
    const f = hubOperationsFixture();
    try {
      const reviewed = pair(f), hooks: HookName[] = [];
      const ops = guarded(f, (hook) => {
        hooks.push(hook);
        if (hook === stopped) {
          throw new PluginGuardError("protector", hook, "blocked", true);
        }
        return [];
      });
      const before = ["original", "copy"].map((n) =>
        Deno.readFileSync(`${f.vault}/${n}.md`)
      );
      const error = await ops.resolveConflict("pair", {
        ...reviewed,
        action: "copy",
      }, f.api()).catch((e) => e);
      assertEquals(error.code, "plugin_cancelled");
      assertEquals(
        hooks,
        stopped === "pre-save" ? ["pre-save"] : ["pre-save", "pre-delete"],
      );
      assertEquals(
        ["original", "copy"].map((n) =>
          Deno.readFileSync(`${f.vault}/${n}.md`)
        ),
        before,
      );
      assertEquals(f.hub.conflict("pair")!.state, "open");
    } finally {
      f.close();
    }
  }
});

Deno.test("conflict resolution: awaited guards cannot lend stale bytes, record identities or authority to effects", async () => {
  for (
    const change of [
      "original",
      "copy",
      "rename",
      "readonly",
      "epoch",
      "symlink",
    ] as const
  ) {
    const f = hubOperationsFixture();
    try {
      const reviewed = pair(f);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const ops = guarded(f, async (hook) => {
        if (hook === "pre-save") {
          entered.resolve();
          await release.promise;
        }
        return [];
      });
      const sending = ops.resolveConflict("pair", {
        ...reviewed,
        action: "copy",
      }, f.api());
      await entered.promise;
      if (change === "original" || change === "copy") {
        Deno.writeTextFileSync(`${f.vault}/${change}.md`, "outside");
      }
      if (change === "rename") {
        Deno.renameSync(`${f.vault}/copy.md`, `${f.vault}/renamed.md`);
        f.hub.scanNow();
      }
      if (change === "readonly") f.config.authType = AuthType.READ_ONLY;
      if (change === "epoch") f.lifecycle.bumpEpoch();
      if (change === "symlink") {
        Deno.renameSync(`${f.vault}/copy.md`, `${f.vault}/renamed.md`);
        Deno.symlinkSync(`${f.vault}/renamed.md`, `${f.vault}/copy.md`);
      }
      release.resolve();
      const error = await sending.catch((e) => e);
      assertEquals(
        error.status,
        change === "readonly" ? 403 : change === "symlink" ? 404 : 409,
      );
      if (["original", "copy", "rename"].includes(change)) {
        assertEquals(error.code, "conflict_stale");
      }
      assert(!f.batches.flat().some((e) => e.peer === "globnotes"));
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/original.md`),
        change === "original"
          ? "outside"
          : "\ufeff# Original\r\n[link](asset.bin)\r\n",
      );
    } finally {
      f.close();
    }
  }
});

Deno.test("conflict resolution: concurrent decisions settle once and closed receipts disclose no paths", async () => {
  const f = hubOperationsFixture();
  try {
    const reviewed = pair(f);
    const results = await Promise.all(
      ["copy", "original"].map((action) =>
        f.operations.resolveConflict("pair", { ...reviewed, action }, f.api())
      ),
    );
    assert("action" in results[0]);
    assertEquals(results[0].action, "copy");
    assertEquals(results[1], {
      status: "settled",
      id: "pair",
      revision: f.hub.conflict("pair")!.revision,
      alreadyResolved: true,
    });
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/original.md`),
      "\ufeff# Copy\r\n",
    );
  } finally {
    f.close();
  }
});

Deno.test("conflict resolution: exact binary/invalid UTF-8/large/extensionless copies, no merge decoding", async () => {
  for (const name of ["data.bin", "no-extension", "invalid.md", "large.md"]) {
    const f = hubOperationsFixture();
    try {
      const bytes = name === "large.md"
        ? new Uint8Array(16 * 1024 * 1024 + 1).fill(97)
        : new Uint8Array([0, 255, 254, 13, 10]);
      Deno.writeFileSync(`${f.vault}/${name}`, new Uint8Array([1, 255]));
      Deno.writeFileSync(`${f.vault}/copy-${name}`, bytes);
      f.hub.recordConflict({
        id: "pair",
        path: name,
        copyPath: `copy-${name}`,
        peer: "globnotes",
        reason: "stale-base",
        state: "open",
        createdAt: "now",
        resolvedAt: null,
      });
      const detail = readConflict(
        { hub: f.hub, stateRoot: f.config.statePath },
        "pair",
      );
      assert(detail.state === "open");
      const reviewed = {
        revision: detail.revision,
        base: {
          original: { kind: "version", version: detail.original.version },
          copy: { kind: "version", version: detail.copy.version },
        },
      };
      const merge = await f.operations.resolveConflict("pair", {
        ...reviewed,
        action: "merge",
        content: "lossy",
      }, f.api()).catch((e) => e);
      assertEquals(merge.status, 400);
      const result = await f.operations.resolveConflict("pair", {
        ...reviewed,
        action: "copy",
      }, f.api());
      assert("action" in result);
      assertEquals(result.remaining, [{
        path: name,
        version: versionOf(bytes),
      }]);
      assertEquals(Deno.readFileSync(`${f.vault}/${name}`), bytes);
      assertEquals(f.hub.fileState(name)!.hash, versionOf(bytes));
    } finally {
      f.close();
    }
  }
});

Deno.test("conflict resolution: one selected copy closes, shared relationships close only on actual deletion", async () => {
  const f = hubOperationsFixture();
  try {
    const reviewed = pair(f);
    Deno.writeTextFileSync(`${f.vault}/other.md`, "another copy");
    for (
      const [id, original, copy] of [["other", "original.md", "other.md"], [
        "nested",
        "copy.md",
        "other.md",
      ]]
    ) {
      f.hub.recordConflict({
        id,
        path: original,
        copyPath: copy,
        peer: "globnotes",
        reason: "stale-base",
        state: "open",
        createdAt: "now",
        resolvedAt: null,
      });
    }
    await f.operations.resolveConflict(
      "pair",
      { ...reviewed, action: "copy" },
      f.api(),
    );
    assertEquals(f.hub.conflict("other")!.state, "open");
    assertEquals(f.hub.conflict("nested")!.state, "resolved");
    assertEquals(Deno.readTextFileSync(`${f.vault}/other.md`), "another copy");
  } finally {
    f.close();
  }
});

Deno.test("conflict resolution: partial failures journal actual effects, retain copy after failed replacement, never claim stale", async () => {
  for (
    const stage of [
      "before-replace",
      "partial-replace",
      "after-replace",
      "verify-replace",
      "before-remove",
      "after-remove",
      "reconcile",
      "record",
    ] as const
  ) {
    const f = hubOperationsFixture();
    try {
      const reviewed = pair(f),
        replace = f.notes.effects.replace.bind(f.notes.effects),
        remove = f.notes.effects.remove.bind(f.notes.effects);
      const facts: OperationFact[] = [], sync: OperationFact[] = [];
      f.lifecycle.onFact((fact) => facts.push(fact));
      f.lifecycle.onSync((fact) => sync.push(fact));
      f.notes.effects.replace = (file, bytes) => {
        if (stage === "before-replace") throw new Error(stage);
        if (stage === "partial-replace") {
          replace(file, "partial");
          throw new Error(stage);
        }
        if (stage === "verify-replace") {
          replace(file, "wrong bytes");
          return;
        }
        replace(file, bytes);
        if (stage === "after-replace") throw new Error(stage);
      };
      f.notes.effects.remove = (file) => {
        if (stage === "before-remove") throw new Error(stage);
        remove(file);
        if (stage === "after-remove") throw new Error(stage);
      };
      if (stage === "record") {
        const apply = f.hub.store.apply.bind(f.hub.store);
        f.hub.store.apply = (mutations, peer, origin) => {
          if (peer === "globnotes") throw new Error(stage);
          return apply(mutations, peer, origin);
        };
      }
      if (stage === "reconcile") {
        f.notes.reconcileEffects = () => {
          throw new Error(stage);
        };
      }
      const error = await f.operations.resolveConflict("pair", {
        ...reviewed,
        action: "copy",
      }, f.api()).catch((e) => e);
      if (stage === "before-replace") {
        assertEquals(error.message, stage);
        assertEquals(sync.length, 0);
      } else {
        assertEquals(error.code, "operation_partial");
        assertEquals(sync.length, 1);
        assert(facts.some((fact) => fact.action === "operation-error"));
      }
      const removed = stage === "after-remove" || stage === "record" ||
        stage === "reconcile";
      assertEquals(Deno.statSync(`${f.vault}/original.md`).isFile, true);
      assertEquals(
        [...Deno.readDirSync(f.vault)].some((e) => e.name === "copy.md"),
        !removed,
      );
      if (stage !== "record") {
        assertEquals(
          f.hub.conflict("pair")!.state,
          removed ? "resolved" : "open",
        );
      }
      if (stage === "after-remove") {
        assert(
          facts.some((fact) =>
            fact.action === "delete" && fact.path === "copy"
          ),
        );
      }
    } finally {
      f.close();
    }
  }
});

Deno.test("conflict resolution: actual changes reach cache/index/facts and asynchronous displacement consumers", async () => {
  const f = hubOperationsFixture();
  const index = new Fts5Indexer(f.config.statePath);
  const dispose = subscribeIndex(f.hub, index);
  try {
    const reviewed = pair(f),
      offers: unknown[] = [],
      facts: OperationFact[] = [],
      sync: OperationFact[] = [];
    f.lifecycle.onFact((fact) => facts.push(fact));
    f.lifecycle.onSync((fact) => sync.push(fact));
    f.notes.listAllNoteFilenames();
    const ops = new NoteOperations({
      notes: f.notes,
      files: f.files,
      hub: f.hub,
      indexer: index,
      lifecycle: f.lifecycle,
      runtime: () => null,
      gate: new HubGate({
        hub: f.hub,
        versioning: () => ({
          interested: () => true,
          enqueue: (batch) => {
            offers.push(...batch);
          },
        }),
      }),
    });
    await ops.resolveConflict("pair", {
      ...reviewed,
      action: "merge",
      content: "# ConsumerProof\n",
    }, f.api());
    assertEquals(index.search("ConsumerProof").map((r) => r.path), [
      "original",
    ]);
    assertEquals(f.notes.listAllNoteFilenames(), ["original.md"]);
    assertEquals(facts.map((fact) => fact.action), ["save", "delete"]);
    assertEquals(sync.length, 1);
    assertEquals(sync[0].changedPaths, ["original", "copy"]);
    assertEquals((offers as { kind: string }[]).map((o) => o.kind), [
      "replace",
      "delete",
    ]);
    f.hub.store.checkpoint();
    assert(
      !new TextDecoder().decode(
        Deno.readFileSync(`${f.config.statePath}/hub.sqlite`),
      ).includes("ConsumerProof"),
    );
  } finally {
    dispose();
    f.close();
  }
});

function request(
  body: unknown,
  prepare: () => void | Promise<void> = () => {},
) {
  return {
    _raw: new Request("http://fixture/_/api/conflicts/pair/resolve", {
      method: "POST",
    }),
    params: { id: "pair" },
    body: {
      json: async () => {
        await prepare();
        return body;
      },
    },
  } as unknown as PathfinderRequest<{ id: string }>;
}
Deno.test("conflict resolution REST: original lease precedes body preparation; read-only refuses every action", async () => {
  for (const action of actions) {
    const f = hubOperationsFixture();
    try {
      const reviewed = pair(f);
      let prepared = false;
      f.config.authType = AuthType.READ_ONLY;
      const error = await resolve(request({ ...reviewed, action }, () => {
        prepared = true;
      })).catch((e) => e);
      assertEquals(error.status, 403);
      assertEquals(prepared, false);
      assertEquals(f.hub.conflict("pair")!.state, "open");
    } finally {
      f.close();
    }
  }
  const f = hubOperationsFixture();
  try {
    const reviewed = pair(f);
    const response = await resolve(
      request({ ...reviewed, action: "both" }, () => {
        f.lifecycle.bumpEpoch();
      }),
    );
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, "operation_conflict");
    assertEquals(f.hub.conflict("pair")!.state, "open");
    const unauthorized = await resolve(
      request({ ...reviewed, action: "both" }, () => {
        state.auth = {} as typeof state.auth;
      }),
    ).catch((e) => e);
    assert(unauthorized instanceof HttpError);
    assertEquals(unauthorized.status, 401);
    assertEquals(f.hub.conflict("pair")!.state, "open");
  } finally {
    f.close();
  }
});

Deno.test("conflict resolution REST: stale envelope, both bases/revision, closed no-op and malformed payload", async () => {
  const f = hubOperationsFixture();
  try {
    const reviewed = pair(f);
    for (
      const body of [
        {},
        { ...reviewed, action: "bogus" },
        { ...reviewed, action: "both", content: "discard" },
        { ...reviewed, action: "both", path: "other.md" },
        { ...reviewed, action: "merge" },
        { ...reviewed, action: "both", revision: 0 },
        {
          ...reviewed,
          action: "both",
          base: {
            ...reviewed.base,
            original: { kind: "text", content: "not a reviewed byte version" },
          },
        },
      ]
    ) {
      const outcome = await resolve(request(body)).catch((e) => e);
      assertEquals(outcome.status, Object.keys(body).length === 0 ? 428 : 400);
    }
    const stale = await resolve(
      request({ ...reviewed, revision: 999, action: "both" }),
    );
    assertEquals(stale.status, 409);
    assertEquals(stale.headers.get("cache-control"), "no-store");
    assertEquals(await stale.json(), {
      code: "conflict_stale",
      status: "stale",
      id: "pair",
    });
    const settled = await resolve(request({ ...reviewed, action: "original" }));
    assertEquals(settled.status, 200);
    const closed = await resolve(
      request({ ...reviewed, action: "merge", content: "never recreate" }),
    );
    assertEquals(await closed.json(), {
      status: "settled",
      id: "pair",
      revision: f.hub.conflict("pair")!.revision,
      alreadyResolved: true,
    });
  } finally {
    f.close();
  }
});

Deno.test("conflict resolution: every action requires both bases and rejects either stale member without effects", async () => {
  for (const action of actions) {
    for (const member of ["original", "copy"] as const) {
      const f = hubOperationsFixture();
      try {
        const reviewed = pair(f),
          content = action === "merge" ? "draft" : undefined;
        const incomplete = {
          ...reviewed,
          action,
          content,
          base: { ...reviewed.base, [member]: undefined },
        };
        let error = await f.operations.resolveConflict(
          "pair",
          incomplete,
          f.api(),
        ).catch((e) => e);
        assertEquals([error.status, error.code], [428, "base_required"]);
        Deno.writeTextFileSync(`${f.vault}/${member}.md`, "outside");
        const before = ["original", "copy"].map((n) =>
          Deno.readFileSync(`${f.vault}/${n}.md`)
        );
        error = await f.operations.resolveConflict("pair", {
          ...reviewed,
          action,
          ...(content === undefined ? {} : { content }),
        }, f.api()).catch((e) => e);
        assertEquals([error.status, error.code], [409, "conflict_stale"]);
        assertEquals(
          ["original", "copy"].map((n) =>
            Deno.readFileSync(`${f.vault}/${n}.md`)
          ),
          before,
        );
        assertEquals(f.hub.conflict("pair")!.state, "open");
      } finally {
        f.close();
      }
    }
  }
});

Deno.test("conflict resolution: partial binary receipts include the actual displaced file and failed copy removal", async () => {
  const f = hubOperationsFixture();
  try {
    const reviewed = pair(f);
    Deno.renameSync(`${f.vault}/original.md`, `${f.vault}/original.bin`);
    Deno.renameSync(`${f.vault}/copy.md`, `${f.vault}/copy.bin`);
    f.hub.scanNow();
    const current = {
      ...reviewed,
      revision: f.hub.conflict("pair")!.revision,
      action: "copy",
    };
    f.notes.effects.remove = () => {
      throw new Error("injected removal failure");
    };
    const error = await f.operations.resolveConflict("pair", current, f.api())
      .catch((e) => e);
    assertEquals(error.code, "operation_partial");
    assertEquals(error.partial, {
      completedPaths: ["original.bin"],
      failedPath: "copy.bin",
    });
    assertEquals(
      Deno.readFileSync(`${f.vault}/original.bin`),
      Deno.readFileSync(`${f.vault}/copy.bin`),
    );
    assertEquals(f.hub.conflict("pair")!.state, "open");
  } finally {
    f.close();
  }
});

Deno.test("conflict resolution: known hidden/state/symlink/foreign ids cannot authorize effects", async () => {
  const f = hubOperationsFixture();
  try {
    const reviewed = pair(f);
    Deno.mkdirSync(`${f.vault}/.hidden`);
    Deno.writeTextFileSync(`${f.vault}/.hidden/secret.md`, "private");
    Deno.symlinkSync(`${f.vault}/original.md`, `${f.vault}/alias.md`);
    for (
      const [id, name] of [
        ["hidden", ".hidden/secret.md"],
        ["symlink", "alias.md"],
        ["state", "../state/hub.sqlite"],
        ["escape", "../other.md"],
      ]
    ) {
      f.hub.store.db.prepare(
        "INSERT INTO conflicts VALUES(?,?,?,?,'key','globnotes','stale-base','open','now',NULL,1)",
      ).run(id, name, "key", "copy.md");
      const error = await f.operations.resolveConflict(id, {
        ...reviewed,
        action: "both",
      }, f.api()).catch((e) => e);
      assertEquals(error.status, 404);
      assertEquals(f.hub.conflict(id)!.state, "open");
    }
    Deno.mkdirSync(`${f.root}/other`);
    const other = new VaultHub(`${f.root}/other`, `${f.root}/other-state`);
    try {
      const ops = new NoteOperations({
        notes: f.notes,
        files: f.files,
        hub: other,
        indexer: null,
        lifecycle: f.lifecycle,
        runtime: () => null,
      });
      const error = await ops.resolveConflict("pair", {
        ...reviewed,
        action: "original",
      }, f.api()).catch((e) => e);
      assertEquals(error.status, 404);
      assertEquals(f.hub.conflict("pair")!.state, "open");
    } finally {
      other.stop();
    }
  } finally {
    f.close();
  }
});
