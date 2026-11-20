// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { VaultHub } from "../server/hub/hub.ts";
import { withPluginFixture } from "./helpers/plugin_fixture.ts";
import { testServices } from "./helpers/environment.ts";
import { CHANGE_LIMIT, HubStore } from "../server/hub/store.ts";
import { anonymousPath } from "../server/hub/paths.ts";
import type { Observation } from "../server/hub/types.ts";

function closeStore(store: HubStore) {
  if (store.db.isOpen) store.close();
}

const observation = (name: string, hash = "abc"): Observation => ({
  key: name.normalize("NFC"),
  diskPath: name,
  hash,
  size: 3,
  mtimeMs: 42,
});

for (const failure of ["unsupported-schema", "initialization", "state-path"]) {
  Deno.test(`hub construction: ${failure} leaves no open database`, async () => {
    await withPluginFixture(async (fixture, scope) => {
      const seed = (await scope.acquire(() =>
        new HubStore(fixture.statePath), closeStore)).value;
      try {
        if (failure === "unsupported-schema") {
          seed.db.exec(
            "UPDATE meta SET value='unsupported' WHERE key='schema_version'",
          );
        }
      } finally {
        seed.close();
      }
      const exec = DatabaseSync.prototype.exec, realPath = Deno.realPathSync;
      const opened: DatabaseSync[] = [];
      const primary = new Error(`hub construction ${failure}`);
      DatabaseSync.prototype.exec = function (sql) {
        if (!opened.includes(this)) {
          opened.push(this);
        }
        if (failure === "initialization" && sql.includes("BEGIN IMMEDIATE")) {
          throw primary;
        }
        return exec.call(this, sql);
      };
      Deno.realPathSync = (path) => {
        if (failure === "state-path" && path === fixture.statePath) {
          throw primary;
        }
        return realPath(path);
      };
      try {
        const error = assertThrows(
          () =>
            new VaultHub(fixture.vault, fixture.statePath, testServices().hub),
          Error,
        );
        if (failure === "unsupported-schema") {
          assertEquals(error.message, "Unsupported hub schema");
        } else assertEquals(error, primary);
        assertEquals(opened.length, failure === "state-path" ? 0 : 1);
        // Observe the actual SQLite handle before rescue cleanup, not merely
        // a close callback or removal of an unlinkable database file.
        for (const db of opened) {
          assertThrows(() =>
            db.prepare("SELECT 1")
          );
        }
      } finally {
        DatabaseSync.prototype.exec = exec;
        Deno.realPathSync = realPath;
        for (const db of opened) {
          try {
            db.close();
          } catch { /* already closed by construction rollback */ }
        }
      }
    });
  });
}

Deno.test("hub store: persistent peers/secret, vectors, rename, anonymous deletion and recreation", async () => {
  await withPluginFixture(async (fixture, scope) => {
    const root = fixture.root;
    let store = (await scope.acquire(() =>
      new HubStore(root), closeStore)).value;
    const secret = store.secret, name = "classified-private-note.md";
    assertEquals(secret.length, 64);
    assertEquals(
      store.db.prepare("SELECT id FROM peers ORDER BY id").all().map((r) =>
        r.id
      ),
      ["globnotes", "local"],
    );
    store.apply([{ path: name, file: observation(name) }], "local", null);
    store.apply(
      [{ path: name, file: observation(name, "changed") }],
      "globnotes",
      "api",
    );
    assertEquals(store.fileState(name)?.vector, { local: 1, globnotes: 1 });
    store.close();
    store = (await scope.acquire(() => new HubStore(root), closeStore)).value;
    assertEquals(store.secret, secret);
    assertEquals(store.fileState(name)?.hash, "changed");
    const transient = store.apply([{ path: name }], "local", null);
    assertEquals(transient[0].path, name);
    assertEquals(store.fileState(name), null);
    const key = anonymousPath(secret, name);
    const tomb = store.db.prepare("SELECT * FROM tombstones WHERE path_key=?")
      .get(key)!;
    assertEquals(JSON.parse(tomb.vector as string), { local: 2, globnotes: 1 });
    assert(store.changesSince(0).entries.every((e) => e.path === null));
    store.checkpoint();
    for (const suffix of ["", "-wal"]) {
      const bytes = Deno.readFileSync(`${root}/hub.sqlite${suffix}`);
      assert(!new TextDecoder().decode(bytes).includes(name));
      assert(
        !new TextDecoder().decode(bytes).includes("classified-private-note"),
      );
    }
    store.apply(
      [{ path: name, file: observation(name) }],
      "globnotes",
      "plugin:test",
    );
    assertEquals(store.fileState(name)?.vector, { local: 2, globnotes: 2 });
    assertEquals(
      store.db.prepare("SELECT * FROM tombstones WHERE path_key=?").get(key),
      undefined,
    );
    const renamed = "new-name.md";
    store.apply(
      [{ path: renamed, oldPath: name, file: observation(renamed) }],
      "globnotes",
      "api",
    );
    assertEquals(store.fileState(name), null);
    assertEquals(store.fileState(renamed)?.vector, { local: 2, globnotes: 3 });
    // Deleting a path also scrubs that path wherever it was the source of a rename.
    store.apply([{ path: name, file: observation(name) }], "local", null);
    store.apply([{ path: name }], "local", null);
    assert(
      store.changesSince(0).entries.every((e) =>
        e.path !== name && e.oldPath !== name
      ),
    );
    store.checkpoint();
    assert(
      !new TextDecoder().decode(Deno.readFileSync(`${root}/hub.sqlite`))
        .includes(name),
    );
  });
});

Deno.test("hub store: compaction keeps newest 100000 and reports cursor gaps", async () => {
  await withPluginFixture(async (fixture, scope) => {
    const root = fixture.root,
      store = (await scope.acquire(() => new HubStore(root), closeStore)).value;
    store.db.exec(`WITH RECURSIVE numbers(n) AS
      (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<${CHANGE_LIMIT + 1})
      INSERT INTO changes(path_key,kind,peer,at) SELECT 'anonymous','deleted','local','now' FROM numbers`);
    store.apply(
      [{ path: "latest", file: observation("latest") }],
      "local",
      null,
    );
    assertEquals(
      store.db.prepare("SELECT COUNT(*) AS n FROM changes").get()!.n,
      CHANGE_LIMIT,
    );
    assertEquals(store.changesSince(1), { gap: true, entries: [] });
    assertEquals(store.changesSince(2).gap, false);
    const tail = store.changesSince(CHANGE_LIMIT + 1).entries;
    assertEquals(tail.length, 1);
    assertEquals(tail[0].seq, CHANGE_LIMIT + 2);
  });
});

Deno.test("hub store: a late conflict record cannot reintroduce an already-deleted name", async () => {
  await withPluginFixture(async (fixture, scope) => {
    const root = fixture.root,
      store = (await scope.acquire(() => new HubStore(root), closeStore)).value;
    const original = "late-private-original.md", copy = "live-copy.md";
    store.apply(
      [original, copy].map((name) => ({ path: name, file: observation(name) })),
      "local",
      null,
    );
    store.apply([{ path: original }], "local", null);
    store.recordConflict({
      id: crypto.randomUUID(),
      path: original,
      copyPath: copy,
      peer: "globnotes",
      reason: "overlapping-edits",
      state: "open",
      createdAt: "now",
      resolvedAt: null,
    });
    assertEquals(store.conflicts()[0].path, null);
    assertEquals(store.conflicts()[0].copyPath, null);
    assertEquals(store.conflicts()[0].state, "resolved");
    store.checkpoint();
    for (const suffix of ["", "-wal"]) {
      assert(
        !new TextDecoder().decode(
          Deno.readFileSync(`${root}/hub.sqlite${suffix}`),
        ).includes(original),
      );
    }
  });
});

Deno.test("hub store: migrates v1 metadata in place and scrubs conflicts on either deletion", async () => {
  await withPluginFixture(async (fixture, scope) => {
    const root = fixture.root;
    let store = (await scope.acquire(() =>
      new HubStore(root), closeStore)).value;
    store.apply(
      [{ path: "secret-original.md", file: observation("secret-original.md") }],
      "local",
      null,
    );
    const secret = store.secret;
    store.db.exec(
      "DROP TABLE conflicts; UPDATE meta SET value='1' WHERE key='schema_version'",
    );
    store.close();
    store = (await scope.acquire(() => new HubStore(root), closeStore)).value;
    assertEquals(store.secret, secret);
    assertEquals(store.fileState("secret-original.md")!.vector, { local: 1 });
    assertEquals(
      store.db.prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get()!.value,
      "5",
    );
    for (const deleted of ["secret-original.md", "secret-copy.md"]) {
      store.apply(
        ["secret-original.md", "secret-copy.md"].map((name) => ({
          path: name,
          file: observation(name),
        })),
        "local",
        null,
      );
      store.recordConflict({
        id: deleted,
        path: "secret-original.md",
        copyPath: "secret-copy.md",
        peer: "globnotes",
        reason: "overlapping-edits",
        state: "open",
        createdAt: "now",
        resolvedAt: null,
      });
      // IDs are normally UUIDs; use an anonymous ID here too so the name cannot linger there.
      store.db.prepare("UPDATE conflicts SET id=? WHERE id=?").run(
        crypto.randomUUID(),
        deleted,
      );
      store.apply([{ path: deleted }], "local", null);
      assert(
        store.conflicts().every((c) =>
          c.path === null && c.copyPath === null && c.state === "resolved" &&
          c.resolvedAt
        ),
      );
      for (const suffix of ["", "-wal"]) {
        assert(
          !new TextDecoder().decode(
            Deno.readFileSync(`${root}/hub.sqlite${suffix}`),
          ).includes(deleted),
        );
      }
    }
  });
});
