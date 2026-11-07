// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { HubStore } from "../server/hub/store.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { VaultHub } from "../server/hub/hub.ts";

const observation = (diskPath: string) => ({
  key: diskPath,
  diskPath,
  hash: "abc",
  size: 3,
  mtimeMs: 1,
});
const record = (id = "pair", name = "original.md", copy = "copy.md") => ({
  id,
  path: name,
  copyPath: copy,
  peer: "globnotes" as const,
  reason: "overlapping-edits",
  state: "open" as const,
  createdAt: "2026-11-07T00:00:00Z",
  resolvedAt: null,
});

Deno.test("conflicts: v2 migration retains records and assigns persistent revisions without content", () => {
  const root = Deno.makeTempDirSync();
  const db = new DatabaseSync(`${root}/hub.sqlite`);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','2');
    CREATE TABLE conflicts(id TEXT PRIMARY KEY,path TEXT,path_key TEXT NOT NULL,
    copy_path TEXT,copy_path_key TEXT NOT NULL,peer TEXT NOT NULL,reason TEXT NOT NULL,
    state TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT);
    INSERT INTO conflicts VALUES('old','original.md','key','copy.md','copy-key',
    'globnotes','overlapping-edits','open','now',NULL);`);
  db.close();
  let store = new HubStore(root);
  try {
    assertEquals(store.conflict("old")?.revision, 1);
    assertEquals(
      store.db.prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get()!.value,
      "3",
    );
    assertEquals(store.conflictRevision(), 0);
    assert(store.closeConflict("old", 1));
    assertEquals(store.conflict("old")?.revision, 2);
    assertEquals(store.conflictRevision(), 1);
    assertEquals(store.closeConflict("old", 1), false);
    store.close();
    store = new HubStore(root);
    assertEquals(store.conflict("old")?.state, "resolved");
    assertEquals(store.conflictRevision(), 1);
    assertEquals(store.conflict("unknown"), null);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("conflicts: rename uses pre-batch identities and deletion scrubs resolved records too", () => {
  const root = Deno.makeTempDirSync(), store = new HubStore(root);
  try {
    store.apply(
      ["private-original.md", "private-copy.md"].map((path) => ({
        path,
        file: observation(path),
      })),
      "local",
      null,
    );
    store.recordConflict(
      record("pair", "private-original.md", "private-copy.md"),
    );
    assertEquals(store.conflictRevision(), 1);
    store.apply(
      [
        {
          path: "private-copy.md",
          oldPath: "private-original.md",
          file: observation("private-copy.md"),
        },
        {
          path: "private-original.md",
          oldPath: "private-copy.md",
          file: observation("private-original.md"),
        },
      ],
      "local",
      null,
    );
    assertEquals(store.conflict("pair")?.path, "private-copy.md");
    assertEquals(store.conflict("pair")?.copyPath, "private-original.md");
    assertEquals(store.conflict("pair")?.revision, 2);
    assertEquals(store.closeConflict("pair", 1), false);
    assert(store.closeConflict("pair", 2));
    store.apply([{ path: "private-original.md" }], "local", null);
    const closed = store.conflict("pair")!;
    assertEquals(
      [closed.path, closed.copyPath, closed.state, closed.revision],
      [null, null, "resolved", 4],
    );
    const revision = store.conflictRevision();
    assertEquals(store.closeConflict("pair", closed.revision), false);
    assertEquals(store.conflictRevision(), revision);
    for (const suffix of ["", "-wal"]) {
      assert(
        !new TextDecoder().decode(
          Deno.readFileSync(`${root}/hub.sqlite${suffix}`),
        ).includes("private-original.md"),
      );
    }
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("conflicts: vault invalidation follows committed metadata, not file sequence", () => {
  const f = hubOperationsFixture(), revisions: number[] = [];
  try {
    const dispose = f.hub.subscribeConflicts((revision) =>
      revisions.push(revision)
    );
    f.hub.subscribeConflicts(() => {
      throw Error("subscriber fixture");
    });
    for (const name of ["original.md", "copy.md"]) {
      Deno.writeTextFileSync(`${f.vault}/${name}`, "body");
    }
    f.hub.scanNow();
    assertEquals(revisions, []);
    f.hub.recordConflict(record());
    assertEquals(revisions, [1]);
    const seq = f.hub.sequence();
    assert(f.hub.closeConflict("pair", 1));
    assertEquals(f.hub.sequence(), seq);
    assertEquals(revisions, [1, 2]);
    Deno.removeSync(`${f.vault}/copy.md`);
    f.hub.scanNow();
    assertEquals(revisions, [1, 2, 3]);
    dispose();
    f.hub.scanNow();
    assertEquals(revisions, [1, 2, 3]);
  } finally {
    f.close();
  }
});

Deno.test("conflicts: outside renames follow both members; deletion closes only actual relationships across restart", () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.vault}/nested`);
    for (const name of ["original.md", "nested/copy.md", "other-copy.md"]) {
      Deno.writeTextFileSync(`${f.vault}/${name}`, name);
    }
    f.hub.recordConflict(record("one", "original.md", "nested/copy.md"));
    f.hub.recordConflict(record("two", "original.md", "other-copy.md"));
    Deno.renameSync(`${f.vault}/original.md`, `${f.vault}/renamed.md`);
    Deno.renameSync(
      `${f.vault}/nested/copy.md`,
      `${f.vault}/nested/renamed-copy.md`,
    );
    f.hub.scanNow();
    assertEquals(f.hub.conflict("one")?.path, "renamed.md");
    assertEquals(f.hub.conflict("one")?.copyPath, "nested/renamed-copy.md");
    assertEquals(f.hub.conflict("two")?.path, "renamed.md");
    assert(f.hub.closeConflict("one", f.hub.conflict("one")!.revision));
    // A later full scan (no hint) scrubs even the closed Keep both record.
    Deno.removeSync(`${f.vault}/nested`, { recursive: true });
    f.hub.scanNow();
    assertEquals(f.hub.conflict("one")?.path, null);
    assertEquals(f.hub.conflict("two")?.state, "open");
    const reopened = new VaultHub(f.vault, f.config.statePath);
    try {
      reopened.scanNow();
      assertEquals(reopened.conflict("one")?.state, "resolved");
      assertEquals(reopened.conflict("two")?.state, "open");
      Deno.removeSync(`${f.vault}/renamed.md`);
      reopened.scanNow();
      assertEquals(reopened.conflict("two")?.state, "resolved");
      assertEquals(reopened.conflict("two")?.copyPath, null);
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/other-copy.md`),
        "other-copy.md",
      );
    } finally {
      reopened.stop();
    }
  } finally {
    f.close();
  }
});

Deno.test("conflicts: unreadable members are unknown and ambiguous renames close instead of inventing a relationship", () => {
  const f = hubOperationsFixture();
  try {
    Deno.mkdirSync(`${f.vault}/locked`);
    Deno.writeTextFileSync(`${f.vault}/original.md`, "identical");
    Deno.writeTextFileSync(`${f.vault}/locked/copy.md`, "identical");
    f.hub.recordConflict(record("one", "original.md", "locked/copy.md"));
    Deno.chmodSync(`${f.vault}/locked`, 0);
    try {
      f.hub.scanNow();
      assertEquals(f.hub.conflict("one")?.state, "open");
    } finally {
      Deno.chmodSync(`${f.vault}/locked`, 0o755);
    }
    Deno.renameSync(`${f.vault}/original.md`, `${f.vault}/moved-one.md`);
    Deno.renameSync(`${f.vault}/locked/copy.md`, `${f.vault}/moved-two.md`);
    f.hub.scanNow();
    assertEquals(f.hub.conflict("one")?.state, "resolved");
    assertEquals(f.hub.conflict("one")?.path, null);
  } finally {
    f.close();
  }
});
