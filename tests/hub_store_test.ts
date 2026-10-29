// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { CHANGE_LIMIT, HubStore } from "../server/hub/store.ts";
import { anonymousPath } from "../server/hub/paths.ts";
import type { Observation } from "../server/hub/types.ts";

const observation = (name: string, hash = "abc"): Observation => ({
  key: name.normalize("NFC"),
  diskPath: name,
  hash,
  size: 3,
  mtimeMs: 42,
});

Deno.test("hub store: persistent peers/secret, vectors, rename, anonymous deletion and recreation", () => {
  const root = Deno.makeTempDirSync();
  let store = new HubStore(root);
  try {
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
    store = new HubStore(root);
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
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("hub store: compaction keeps newest 100000 and reports cursor gaps", () => {
  const root = Deno.makeTempDirSync(), store = new HubStore(root);
  try {
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
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
