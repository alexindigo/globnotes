// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import {
  planImport,
  snapshotAbsences,
} from "../server/hub/drivers/importer.ts";
import { DriverPeers, type PeerFile } from "../server/hub/drivers/peers.ts";
import { versionOf } from "../server/hub/merge.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { NoteOperations } from "../server/notes/operations.ts";
import type { PluginRuntime } from "../server/plugins/runtime.ts";
const bytes = (value: string) => new TextEncoder().encode(value);
const version = (value: string) => versionOf(bytes(value));
const mapping: PeerFile = {
  pathKey: "key",
  version: version("base"),
  revision: "r1",
  state: "synced",
  attempts: 0,
  nextAt: 0,
};
Deno.test("driver import: base table, equal adoption, history merge and deletion dispositions", () => {
  const input = {
    path: "a.md",
    revision: "r2",
    bytes: bytes("remote"),
    expectedVersion: version("base"),
  };
  const live = (text: string) => ({
    version: version(text),
    bytes: bytes(text),
  });
  assertEquals(
    planImport({ ...input, revision: "r1" }, mapping, live("local"), false)
      .kind,
    "unchanged",
  );
  assertEquals(planImport(input, null, live("remote"), false).kind, "adopt");
  assertEquals(planImport(input, mapping, live("base"), false).kind, "write");
  assertEquals(planImport(input, mapping, live("local"), false), {
    kind: "conflict",
    bytes: input.bytes,
    reason: "stale-base",
  });
  assertEquals(planImport(input, null, live("local"), false), {
    kind: "conflict",
    bytes: input.bytes,
    reason: "unknown-base",
  });
  assertEquals(planImport(input, null, null, true).kind, "held");
  assertEquals(
    planImport({ ...input, restore: true }, null, null, true).kind,
    "write",
  );
  assertEquals(planImport(input, null, null, false).kind, "write");
  assertEquals(
    planImport({ ...input, revision: null }, mapping, live("base"), false).kind,
    "delete",
  );
  assertEquals(
    planImport({ ...input, revision: null }, mapping, live("local"), false)
      .kind,
    "drop",
  );
  assertEquals(
    planImport({ ...input, revision: null }, mapping, null, true).kind,
    "drop",
  );
  const base = "first\nmiddle\nlast\n";
  const merged = planImport(
    { ...input, bytes: bytes("first\nmiddle\nremote\n"), baseText: base },
    { ...mapping, version: version(base) },
    live("local\nmiddle\nlast\n"),
    false,
  );
  assertEquals(merged.kind, "write");
  if (merged.kind === "write") {
    assertEquals(
      new TextDecoder().decode(merged.bytes),
      "local\nmiddle\nremote\n",
    );
  }
});
Deno.test("driver import: only complete comparable nonempty snapshots infer absence", () => {
  const pass = {
    complete: true,
    uncertain: false,
    sameIdentity: true,
    sameScope: true,
    known: new Set(["other"]),
    seen: new Set<string>(),
  };
  assertEquals(snapshotAbsences(pass, [mapping]), {
    keys: ["key"],
    remoteEmpty: false,
  });
  for (const flag of ["complete", "sameIdentity", "sameScope"] as const) {
    assertEquals(
      snapshotAbsences({ ...pass, [flag]: false }, [mapping]).keys,
      [],
    );
  }
  assertEquals(
    snapshotAbsences({ ...pass, uncertain: true }, [mapping]).keys,
    [],
  );
  assertEquals(snapshotAbsences({ ...pass, known: new Set() }, [mapping]), {
    keys: [],
    remoteEmpty: true,
  });
  assertEquals(
    snapshotAbsences({ ...pass, seen: new Set(["key"]) }, [mapping]).keys,
    [],
  );
});
Deno.test("driver import: one group, one publish, no echo, copies and deleted-here holds", async () => {
  const f = hubOperationsFixture(), peers = new DriverPeers(f.hub.store);
  try {
    let peer = peers.create("test", "My remote");
    peer = peers.update(peer.id, 1, { ...peer, enabled: true });
    const guards: string[] = [];
    const operations = new NoteOperations({
      notes: f.notes,
      files: f.files,
      hub: f.hub,
      indexer: null,
      lifecycle: f.lifecycle,
      runtime: () => ({
        limits: { preOperationMs: 5000 },
        guard: (name: string) => {
          guards.push(name);
          return [];
        },
        assertGuardAuthority() {},
      } as unknown as PluginRuntime),
    });
    const members = Array.from(
      { length: 13 },
      (_, n) => ({
        path: n === 12 ? "media/image.png" : `folder/n${n}.md`,
        revision: `r${n}`,
        bytes: bytes(`body ${n}`),
        expectedVersion: null,
      }),
    );
    const seen: number[] = [];
    const observedMappings: (string | null | undefined)[] = [];
    const off = f.hub.subscribe((entries) => {
      seen.push(entries.length);
      for (const e of entries) {
        observedMappings.push(peers.file(peer.id, e.path!)?.version);
      }
    });
    const result = await operations.applyDriverImport(peer.id, members);
    assertEquals(result.length, 13);
    assertEquals(seen, [13]);
    assertEquals(
      observedMappings,
      f.batches[0].map((entry) => entry.afterHash),
    );
    assertEquals(guards, []);
    assertEquals(f.batches[0][0].path, "media/image.png");
    assertEquals(new Set(f.batches[0].map((e) => e.batch)).size, 1);
    assertEquals(f.notes.get("folder/n0").content, "body 0");
    assertEquals(f.hub.fileState("folder/n0.md")?.vector, { "my-remote": 1 });
    off();
    const seq = f.hub.sequence();
    await operations.applyDriverImport(
      peer.id,
      members.map((m) => ({ ...m, expectedVersion: versionOf(m.bytes) })),
    );
    f.hub.scanNow();
    assertEquals(f.hub.sequence(), seq);
    await f.operations.updateNote(
      "folder/n0",
      {
        newContent: "local",
        base: { kind: "version", version: version("body 0") },
      },
      "none",
      f.api(),
    );
    const collision = await operations.applyDriverImport(peer.id, [{
      path: "folder/n0.md",
      revision: "new",
      bytes: bytes("remote"),
      expectedVersion: version("local"),
    }]);
    assertEquals(collision[0].status, "conflict");
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/${collision[0].copyPath}`),
      "remote",
    );
    assertEquals(f.hub.conflicts()[0].peer, peer.id);
    assertEquals(
      peers.file(peer.id, "folder/n0.md")?.version,
      version("remote"),
    );
    await f.operations.deleteNote(
      "folder/n1",
      f.api(),
      undefined,
      undefined,
      undefined,
      { kind: "version", version: version("body 1") },
    );
    const held = await operations.applyDriverImport(peer.id, [{
      path: "folder/n1.md",
      revision: "edited",
      bytes: bytes("new remote"),
      expectedVersion: null,
    }]);
    assertEquals(held[0].status, "held");
    assertEquals(f.hub.fileState("folder/n1.md"), null);
    assertEquals(peers.file(peer.id, "folder/n1.md")?.state, "held");
    await operations.applyDriverImport(peer.id, [{
      path: "folder/n1.md",
      revision: "edited",
      bytes: bytes("new remote"),
      expectedVersion: null,
      restore: true,
    }]);
    assertEquals(f.notes.get("folder/n1").content, "new remote");
  } finally {
    f.close();
  }
});
Deno.test("driver import: missing/stale bases, unsafe names, generation and read-only refuse effects", async () => {
  const f = hubOperationsFixture(), peers = new DriverPeers(f.hub.store);
  try {
    const off = peers.create("test", "Remote"),
      peer = peers.update(off.id, 1, { ...off, enabled: true });
    const input = {
      path: "note.md",
      revision: "r1",
      bytes: bytes("private body"),
      expectedVersion: null,
    };
    const missing = { ...input };
    delete (missing as Partial<typeof input>).expectedVersion;
    await assertRejects(
      () => f.operations.applyDriverImport(peer.id, [missing]),
      Error,
      "base",
    );
    await assertRejects(
      () =>
        f.operations.applyDriverImport(peer.id, [input], () => {
          throw new Error("revoked");
        }),
      Error,
      "revoked",
    );
    const bad = await f.operations.applyDriverImport(peer.id, [{
      ...input,
      path: "../escaped",
    }, { ...input, path: "directory/../escaped" }]);
    assert(bad.every((result) => result.status === "invalid_path"));
    Deno.writeTextFileSync(`${f.vault}/note.md`, "local");
    assertEquals(
      (await f.operations.applyDriverImport(peer.id, [input]))[0].status,
      "replan",
    );
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "local");
    assertEquals(peers.files(peer.id), []);
    const original = f.lifecycle.writable.bind(f.lifecycle);
    f.lifecycle.writable = () => false;
    const refused = await assertRejects(
      () => f.operations.applyDriverImport(peer.id, [input]),
      HttpError,
    );
    assertEquals(refused.status, 403);
    f.lifecycle.writable = original;
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "local");
  } finally {
    f.close();
  }
});
