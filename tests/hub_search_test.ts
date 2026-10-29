// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  subscribeExternalFacts,
  subscribeIndex,
} from "../server/hub/subscribers.ts";
import { setupState } from "./helpers/state.ts";
import { state } from "../server/state.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import type { OperationFact } from "../server/plugins/contracts.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { Fts5Indexer } from "../server/search/fts5.ts";

Deno.test("hub search: outside write/scan/delete updates index; managed save visible immediately without scanning", async () => {
  const vault = Deno.makeTempDirSync(), previous = { ...state };
  const s = setupState(vault);
  try {
    Deno.writeTextFileSync(`${vault}/outside.md`, "externalneedle #outside");
    assertEquals(
      s.indexer.search("externalneedle"),
      [],
      "search itself never scans",
    );
    s.hub.scanNow();
    assertEquals(s.indexer.search("externalneedle").map((r) => r.path), [
      "outside",
    ]);
    assertEquals(s.indexer.getTags(), ["outside"]);
    Deno.removeSync(`${vault}/outside.md`);
    s.hub.scanNow();
    assertEquals(s.indexer.search("externalneedle"), []);
    assertEquals(s.indexer.getTags(), []);
    await s.operations.createNote(
      { path: "managed", content: "ownneedle" },
      s.api(),
    );
    assertEquals(s.indexer.search("ownneedle").map((r) => r.path), ["managed"]);
    await s.operations.updateNote(
      "managed",
      { newContent: "nextneedle" },
      "none",
      s.api(),
    );
    assertEquals(s.indexer.search("ownneedle"), []);
    assertEquals(s.indexer.search("nextneedle").map((r) => r.path), [
      "managed",
    ]);
    await s.operations.updateNote(
      "managed",
      { newPath: "moved" },
      "none",
      s.api(),
    );
    assertEquals(s.indexer.search("nextneedle").map((r) => r.path), ["moved"]);
    await s.operations.deleteNote("moved", s.api());
    assertEquals(s.indexer.search("nextneedle"), []);
  } finally {
    s.hub.stop();
    Object.assign(state, previous);
    Deno.removeSync(vault, { recursive: true });
  }
});

Deno.test("hub facts: local rename is delete/create after index reconciliation, one sync batch, no managed echo", async () => {
  const vault = Deno.makeTempDirSync(), previous = { ...state };
  const s = setupState(vault),
    facts: OperationFact[] = [],
    syncs: OperationFact[] = [];
  const lifecycle = new PluginLifecycle(s.config);
  subscribeExternalFacts(s.hub, lifecycle);
  lifecycle.onFact((fact) => {
    facts.push(fact);
    if (fact.action === "create") {
      assertEquals(s.indexer.search("renameword").map((r) => r.path), [
        fact.path,
      ]);
    }
  });
  lifecycle.onSync((fact) => syncs.push(fact));
  try {
    await s.operations.createNote(
      { path: "old", content: "renameword" },
      s.api(),
    );
    s.hub.scanNow();
    assertEquals(facts, []);
    assertEquals(syncs, []);
    Deno.renameSync(`${vault}/old.md`, `${vault}/new.md`);
    s.hub.scanNow();
    assertEquals(facts.map((f) => f.action), ["delete", "create"]);
    assertEquals(facts[0].before?.contentAvailable, false);
    assertEquals(facts[1].after?.content, "renameword");
    assertEquals(syncs.length, 1);
    assertEquals(syncs[0].initial, false);
    assertEquals(syncs[0].changedPaths, ["old", "new"]);
  } finally {
    s.hub.stop();
    Object.assign(state, previous);
    Deno.removeSync(vault, { recursive: true });
  }
});

Deno.test("hub search: partial-save lifecycle consumers see reconciled committed bytes", async () => {
  let armed = false;
  const vault = Deno.makeTempDirSync(), previous = { ...state };
  const s = setupState(vault, null, {
    afterWrite() {
      if (armed) throw new Error("partial search fixture");
    },
  });
  const observed: string[][] = [];
  try {
    await s.operations.createNote(
      { path: "partial", content: "beforeword" },
      s.api(),
    );
    s.lifecycle.onFact(() =>
      observed.push(s.indexer.search("afterword").map((r) => r.path))
    );
    armed = true;
    await assertRejects(() =>
      s.operations.updateNote(
        "partial",
        { newContent: "afterword" },
        "none",
        s.api(),
      )
    );
    assertEquals(observed, [["partial"], ["partial"]]);
    assertEquals(s.indexer.search("beforeword"), []);
  } finally {
    s.hub.stop();
    Object.assign(state, previous);
    Deno.removeSync(vault, { recursive: true });
  }
});

Deno.test("hub facts: pre-effect reconciliation publishes the real outside create before the managed delete", async () => {
  const vault = Deno.makeTempDirSync(), previous = { ...state };
  const s = setupState(vault);
  const observed: {
    origin: string;
    action: string;
    hits: string[];
    content?: string;
  }[] = [];
  const syncs: OperationFact[] = [];
  subscribeExternalFacts(s.hub, s.lifecycle);
  s.lifecycle.onFact((fact) =>
    observed.push({
      origin: fact.origin,
      action: fact.action,
      hits: s.indexer.search("unobservedword").map((row) => row.path),
      ...(fact.after?.content ? { content: fact.after.content } : {}),
    })
  );
  s.lifecycle.onSync((fact) => syncs.push(fact));
  try {
    Deno.writeTextFileSync(`${vault}/outside.md`, "unobservedword");
    await s.operations.deleteNote("outside", s.api());
    assertEquals(observed, [
      {
        origin: "external",
        action: "create",
        hits: ["outside"],
        content: "unobservedword",
      },
      { origin: "api", action: "delete", hits: [] },
    ]);
    assertEquals(
      syncs.map((fact) => [fact.origin, fact.initial, fact.changedPaths]),
      [
        ["external", false, ["outside"]],
        ["api", false, ["outside"]],
      ],
    );
  } finally {
    s.hub.stop();
    Object.assign(state, previous);
    Deno.removeSync(vault, { recursive: true });
  }
});

Deno.test("hub projections: a vanished first entry does not drop later index values, facts or sync", () => {
  const f = hubOperationsFixture();
  const indexer = new Fts5Indexer(f.config.statePath);
  const facts: OperationFact[] = [], syncs: OperationFact[] = [];
  f.hub.subscribe(() => Deno.removeSync(`${f.vault}/a-gone.md`));
  subscribeIndex(f.hub, indexer);
  subscribeExternalFacts(f.hub, f.lifecycle);
  f.lifecycle.onFact((fact) => facts.push(fact));
  f.lifecycle.onSync((fact) => syncs.push(fact));
  try {
    Deno.writeTextFileSync(`${f.vault}/a-gone.md`, "projectionneedle gone");
    Deno.writeTextFileSync(`${f.vault}/b-kept.md`, "projectionneedle kept");
    f.hub.scanNow();
    assertEquals(indexer.search("projectionneedle").map((hit) => hit.path), [
      "b-kept",
    ]);
    assertEquals(
      facts.map((fact) => [fact.action, fact.path, fact.after?.content]),
      [["create", "b-kept", "projectionneedle kept"]],
    );
    assertEquals(syncs.length, 1);
    assert(syncs[0].changedPaths?.includes("b-kept"));
  } finally {
    f.close();
  }
});
