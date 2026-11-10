// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { HubStore } from "../server/hub/store.ts";
import {
  DriverPeers,
  PeerRevisionConflict,
} from "../server/hub/drivers/peers.ts";

const observation = (diskPath: string, hash = "abc") => ({
  key: diskPath,
  diskPath,
  hash,
  size: 3,
  mtimeMs: 1,
});
Deno.test("driver store: failure onset survives restart and replacement, but recovery and Off reset it", () => {
  const root = Deno.makeTempDirSync();
  let store = new HubStore(root);
  try {
    let peers = new DriverPeers(store);
    const instance = peers.create("test", "Remote");
    peers.observeStatus(instance.id, "failed", true);
    const onset = peers.failingSince(instance.id);
    assert(typeof onset === "number" && onset > 0);
    peers.observeStatus(instance.id, "locked", true);
    peers.observeStatus(instance.id, "starting", true);
    assertEquals(peers.failingSince(instance.id), onset);
    store.close();
    store = new HubStore(root);
    peers = new DriverPeers(store);
    assertEquals(peers.failingSince(instance.id), onset);
    peers.observeStatus(instance.id, "active", true);
    assertEquals(peers.failingSince(instance.id), null);
    peers.observeStatus(instance.id, "locked", true);
    peers.update(instance.id, instance.revision, {
      ...instance,
      enabled: false,
    });
    assertEquals(peers.failingSince(instance.id), null);
    peers.observeStatus(instance.id, "failed", true);
    peers.retire(instance.id, peers.instance(instance.id)!.revision);
    assertEquals(peers.failingSince(instance.id), null);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
Deno.test("driver store: v3 migration preserves conflict revisions and old batches", () => {
  const root = Deno.makeTempDirSync();
  let store = new HubStore(root);
  try {
    store.apply(
      ["a.md", "copy.md"].map((name) => ({
        path: name,
        file: observation(name),
      })),
      "local",
      null,
    );
    store.recordConflict({
      id: "pair",
      path: "a.md",
      copyPath: "copy.md",
      peer: "globnotes",
      reason: "stale-base",
      state: "open",
      createdAt: "now",
      resolvedAt: null,
    });
    store.db.exec(
      "UPDATE meta SET value='3' WHERE key='schema_version'; DROP INDEX changes_batch; ALTER TABLE changes DROP COLUMN batch; ALTER TABLE peers DROP COLUMN plugin; ALTER TABLE peers DROP COLUMN settings; ALTER TABLE peers DROP COLUMN enabled; ALTER TABLE peers DROP COLUMN revision; DROP TABLE peer_files; DROP TABLE peer_sync;",
    );
    const secret = store.secret;
    store.close();
    store = new HubStore(root);
    assertEquals(store.secret, secret);
    assertEquals(store.conflictRevision(), 1);
    assertEquals(store.conflict("pair")?.revision, 1);
    assertEquals(store.changesSince(0).entries.map((e) => e.batch), [1, 2]);
    assertEquals(
      store.db.prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get()!.value,
      "5",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
Deno.test("driver store: peer acknowledgements commit or roll back with one file batch", () => {
  const root = Deno.makeTempDirSync(),
    store = new HubStore(root, { changeLimit: 2 }),
    peers = new DriverPeers(store);
  try {
    const peer = peers.create("test", "Remote");
    assertEquals(peer.enabled, false);
    const updated = peers.update(peer.id, 1, { ...peer, enabled: true });
    assertThrows(() => peers.update(peer.id, 1, updated), PeerRevisionConflict);
    assertThrows(() =>
      store.apply(
        [{ path: "a.md", file: observation("a.md") }],
        peer.id,
        "external",
        () => {
          peers.acknowledge(peer.id, "a.md", "abc", "r1");
          throw new Error("ack failed");
        },
      )
    );
    assertEquals(store.sequence(), 0);
    assertEquals(peers.files(peer.id), []);
    assertEquals(store.files(), []);
    const entries = store.apply(
      ["a.md", "b.md"].map((name) => ({ path: name, file: observation(name) })),
      peer.id,
      "external",
      (entries) => {
        assertEquals(entries.length, 2);
        for (const e of entries) {
          peers.acknowledge(peer.id, e.path!, e.afterHash, "r1");
        }
      },
    );
    assertEquals(
      entries.map((e) => e.batch),
      [1, 1],
    );
    assertEquals(store.fileState("a.md")?.vector, { remote: 1 });
    assertEquals(peers.file(peer.id, "a.md")?.revision, "r1");
    store.apply([{ path: "c.md", file: observation("c.md") }], "local", null);
    assertEquals(store.changesSince(0).gap, true);
    peers.retire(peer.id, updated.revision);
    assertEquals(peers.instance(peer.id), null);
    assertEquals(peers.create("test", "Remote").id, "remote-2");
    assertEquals(store.fileState("a.md")?.hash, "abc");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
Deno.test("driver store: endpoint/scope changes detach metadata, deleted names stay anonymous", () => {
  const root = Deno.makeTempDirSync(),
    store = new HubStore(root),
    peers = new DriverPeers(store);
  try {
    const peer = peers.create("test", "Remote").id,
      name = "secret-file-name.md";
    peers.bind(peer, { id: "endpoint", epoch: "1" }, "all");
    store.apply([{ path: name, file: observation(name) }], "local", null);
    peers.acknowledge(peer, name, "abc", "r1");
    peers.acknowledge(peer, "excluded", "abc", "r2", "excluded");
    assertEquals(peers.bind(peer, { id: "endpoint", epoch: "1" }, "narrow"), {
      rebootstrap: false,
      scopeChanged: true,
    });
    assertEquals(peers.file(peer, "excluded"), null);
    store.apply([{ path: name }], "local", null);
    assert(peers.deleted(name));
    assertEquals(peers.file(peer, name)?.revision, "r1");
    for (const suffix of ["", "-wal"]) {
      assert(
        !new TextDecoder().decode(
          Deno.readFileSync(`${root}/hub.sqlite${suffix}`),
        ).includes(name),
      );
    }
    assertEquals(peers.bind(peer, { id: "endpoint", epoch: "2" }, "narrow"), {
      rebootstrap: true,
      scopeChanged: false,
    });
    assertEquals(peers.files(peer), []);
    assertEquals(peers.sync(peer).exportSeq, 0);
    // Reserved built-in ids are never reused, either.
    assertEquals(peers.create("test", "local").id, "local-2");
    assertEquals(peers.create("test", "globnotes").id, "globnotes-2");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
