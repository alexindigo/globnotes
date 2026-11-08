// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { hubDriverFixture } from "./helpers/driver_inprocess.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { versionOf } from "../server/hub/merge.ts";
import changes from "../server/api/endpoints/_/api/changes/get.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

Deno.test("driver native acceptance: failed 13-file native group writes none, then one attachment-first batch is visible to every subscriber", async () => {
  const remote = memoryRemote();
  remote.native.groups = true;
  for (let i = 0; i < 12; i++) {
    remote.put(`group/${i}.md`, `![image](image.png)\n${i}`);
  }
  remote.put("group/image.png", new Uint8Array([137, 80, 78, 71]));
  remote.faults.push({
    path: "/object",
    method: "GET",
    key: "group/6.md",
    status: 500,
  });
  const f = await hubDriverFixture(remote, { native: true });
  const snapshots: number[] = [];
  const stream = await changes({
    _raw: new Request("http://globnotes.test/_/api/changes", {
      headers: { accept: "text/event-stream" },
    }),
    query: new URLSearchParams(),
  } as PathfinderRequest);
  const reader = stream.body!.getReader();
  let frames = "";
  const consumers: number[] = [];
  const draining = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      const text = new TextDecoder().decode(next.value);
      frames += text;
      if (text.includes("event: change")) {
        consumers.push(f.hub.store.files().length);
      }
    }
  })();
  const off = f.hub.subscribe(() => snapshots.push(f.hub.store.files().length));
  try {
    const id = await f.add();
    assertEquals((await f.one(id)).status, "failed");
    assertEquals(f.hub.store.files(), []);
    assertEquals([...Deno.readDirSync(f.vault)], []);
    assertEquals(f.supervisor.peers.sync(id).cursor, null);
    assertEquals((await f.run(id)).status, "active");
    assertEquals(f.hub.store.files().length, 13);
    assertEquals(f.batches.length, 1);
    assertEquals(f.batches[0].length, 13);
    assertEquals(new Set(f.batches[0].map(({ batch }) => batch)).size, 1);
    assertEquals(f.batches[0][0].path, "group/image.png");
    assertEquals(snapshots, [13]);
    await waitUntil(
      () =>
        (frames.match(/event: change\n/g)?.length ?? 0) === 13
          ? done()
          : pending(frames.length),
      { label: "browser stream sees complete native group" },
    );
    assert(consumers.every((count) => count === 13));
    assertEquals(
      JSON.parse(/event: change\ndata: ([^\n]+)/.exec(frames)![1]).path,
      "group/image.png",
    );
    for (const [path, value] of remote.objects) {
      assertEquals(Deno.readFileSync(`${f.vault}/${path}`), value.bytes);
    }
    // One member diverges from its mapped base; the rest still arrive together.
    Deno.writeTextFileSync(`${f.vault}/group/0.md`, "local divergence");
    f.hub.scanNow();
    remote.put("group/0.md", "remote divergence");
    remote.put("group/1.md", "other member");
    await f.run(id);
    assertEquals(
      f.hub.conflicts().filter((row) => row.state === "open").length,
      1,
    );
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/group/0.md`),
      "local divergence",
    );
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/group/1.md`),
      "other member",
    );
    assertEquals(
      f.batches.filter((batch) => batch.some(({ peer }) => peer === id)).at(-1)!
        .length,
      2,
    );
  } finally {
    await reader.cancel();
    await draining;
    off();
    await f.close();
    await remote.close();
  }
});

Deno.test("driver native acceptance: multipage deltas preserve cursor on unknown, omitted paths survive, proven native deletes apply", async () => {
  const remote = memoryRemote({ pageSize: 2 });
  for (const name of ["a", "b", "c", "d"]) remote.put(`${name}.md`, name);
  const f = await hubDriverFixture(remote, { native: true });
  try {
    const id = await f.add();
    const before = f.supervisor.peers.sync(id).cursor;
    remote.put("a.md", "changed");
    remote.delete("b.md");
    remote.put("new.md", "new");
    remote.native.unknown = "a.md";
    assertEquals((await f.run(id)).status, "failed");
    assertEquals(f.supervisor.peers.sync(id).cursor, before);
    assertEquals(Deno.readTextFileSync(`${f.vault}/a.md`), "a");
    assertEquals(Deno.readTextFileSync(`${f.vault}/b.md`), "b");
    remote.native.unknown = undefined;
    assertEquals((await f.run(id)).status, "active");
    assertEquals(Deno.readTextFileSync(`${f.vault}/a.md`), "changed");
    assertEquals(f.hub.fileState("b.md"), null);
    assertEquals(Deno.readTextFileSync(`${f.vault}/c.md`), "c");
    assertEquals(Deno.readTextFileSync(`${f.vault}/new.md`), "new");
    const stable = f.hub.sequence(), sends = remote.batches.length;
    await f.run(id);
    await f.run(id);
    assertEquals(f.hub.sequence(), stable);
    assertEquals(remote.batches.length, sends);
    assert(
      remote.requests.filter(({ path }) => path === "/native/discover")
        .length >= 5,
    );
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: a real Worker recovers a pruned change log by state reconciliation after its instance was off", async () => {
  const remote = memoryRemote();
  const f = await hubDriverFixture(remote, { changeLimit: 3 });
  try {
    await f.operations.createNote({ path: "first", content: "first" }, f.api());
    const id = await f.add();
    const cursor = f.supervisor.peers.sync(id).exportSeq;
    await f.configure(id, false);
    for (let i = 0; i < 8; i++) {
      await f.operations.createNote({
        path: `gap-${i}`,
        content: `version-${i}`,
      }, f.api());
    }
    assertEquals(f.hub.changesSince(cursor).gap, true);
    await f.configure(id, true);
    assertEquals(remote.objects.size, 9);
    for (const file of f.hub.store.files()) {
      assertEquals(
        remote.objects.get(file.diskPath)!.bytes,
        Deno.readFileSync(`${f.vault}/${file.diskPath}`),
      );
    }
    const writes = remote.requests.filter(({ method }) =>
      method === "PUT"
    ).length;
    await f.run(id);
    assertEquals(
      remote.requests.filter(({ method }) => method === "PUT").length,
      writes,
    );
    assertEquals(f.hub.conflicts(), []);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver native acceptance: editor rename with attachment exports the actual hub batch as one conditional native unit", async () => {
  const remote = memoryRemote();
  const f = await hubDriverFixture(remote, { native: true });
  try {
    Deno.mkdirSync(`${f.vault}/Old`);
    Deno.writeFileSync(`${f.vault}/Old/image.png`, new Uint8Array([1, 2, 3]));
    f.hub.scanNow();
    await f.operations.createNote({
      path: "Old/note",
      content: "![image](image.png)",
    }, f.api());
    const id = await f.add();
    remote.batches.length = 0;
    await f.operations.updateNote(
      "Old/note",
      {
        newPath: "New/note",
        base: {
          kind: "version",
          version: versionOf(Deno.readFileSync(`${f.vault}/Old/note.md`)),
        },
      },
      "move",
      f.api(),
    );
    await f.run(id);
    const packets = remote.batches;
    assertEquals(packets.length, 1);
    assertEquals(new Set(packets[0].map(({ batch }) => batch)).size, 1);
    assert(
      packets[0].some(({ path, op }) => path === "New/note.md" && op === "put"),
    );
    assert(
      packets[0].some(({ path, op }) =>
        path === "Old/note.md" && op === "delete"
      ),
    );
    assert(packets[0].some(({ path }) => path.endsWith("image.png")));
    for (const file of f.hub.store.files()) {
      assertEquals(
        remote.objects.get(file.diskPath)!.bytes,
        Deno.readFileSync(`${f.vault}/${file.diskPath}`),
      );
    }
  } finally {
    await f.close();
    await remote.close();
  }
});

for (
  const [name, override] of [
    ["malformed", { entries: [{ state: "invented", path: "safe.md" }] }],
    ["oversized", {
      entries: [{ state: "unknown", reason: "x".repeat(1024 * 1024) }],
    }],
    ["escape", {
      entries: [{ state: "known", path: "../escape.md", revision: "opaque" }],
    }],
  ] as const
) {
  Deno.test(`driver native acceptance: ${name} discovery fails closed before applying anything`, async () => {
    const remote = memoryRemote();
    remote.put("safe.md", "must not apply");
    remote.native.override = override;
    const f = await hubDriverFixture(remote, { native: true });
    try {
      const id = await f.add();
      assertEquals((await f.one(id)).status, "failed");
      assertEquals((await f.one(id)).reason, "driver_contract_violation");
      assertEquals(f.hub.sequence(), 0);
      assertEquals([...Deno.readDirSync(f.vault)], []);
      assertEquals(remote.batches, []);
    } finally {
      await f.close();
      await remote.close();
    }
  });
}

Deno.test("driver native acceptance: state paths are refused at the hub boundary without damaging canonical state", async () => {
  const remote = memoryRemote();
  const f = await hubDriverFixture(remote, { native: true });
  try {
    // Canonical state is outside this vault. A symlink inside the vault cannot
    // turn a contract-valid path into access to that protected namespace.
    Deno.symlinkSync(f.config.statePath, `${f.vault}/State`);
    remote.put("State/hub.sqlite", "not a database");
    remote.put("safe.md", "eligible");
    const id = await f.add();
    const row = await f.one(id);
    assert(
      row.attention?.issues.some(({ code }: { code: string }) =>
        code === "invalid"
      ),
    );
    assertEquals(Deno.readTextFileSync(`${f.vault}/safe.md`), "eligible");
    assertEquals(f.hub.fileState("State/hub.sqlite"), null);
    assertEquals(
      f.hub.store.db.prepare(
        "SELECT value FROM meta WHERE key='schema_version'",
      ).get()!.value,
      "5",
    );
    assertEquals(
      f.hub.store.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver native acceptance: one hung HTTP-backed instance fails its heartbeat while another instance still imports", async () => {
  const remote = memoryRemote();
  remote.put("note.md", "native bytes");
  const f = await hubDriverFixture(remote, { native: true });
  try {
    const first = await f.add("First");
    remote.native.hang = true;
    const hanging = f.run(first);
    await waitUntil(
      async () =>
        (await f.one(first)).status === "failed"
          ? done()
          : pending("heartbeat"),
      { label: "hung native driver heartbeat failure" },
    );
    await hanging;
    remote.native.hang = false;
    remote.put("second.md", "other instance survives");
    const second = await f.add("Second");
    assertEquals((await f.one(second)).status, "active");
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/second.md`),
      "other instance survives",
    );
    assertEquals((await f.one(first)).status, "failed");
    assertEquals(
      versionOf(Deno.readFileSync(`${f.vault}/second.md`)),
      f.supervisor.peers.file(second, "second.md")!.version,
    );
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver native acceptance: oversized native group splits at 256 files, exposes partial progress and retries without duplicate effects", async () => {
  const remote = memoryRemote();
  remote.native.groups = true;
  for (let i = 0; i < 257; i++) {
    remote.put(`unit/${String(i).padStart(3, "0")}.md`, `body ${i}`);
  }
  remote.faults.push({
    method: "GET",
    path: "/object",
    key: "unit/256.md",
    status: 500,
  });
  const f = await hubDriverFixture(remote, { native: true });
  try {
    const id = await f.add();
    assertEquals((await f.one(id)).status, "failed");
    assertEquals(f.hub.store.files().length, 256);
    assertEquals(f.batches.map((batch) => batch.length), [256]);
    assertEquals(f.supervisor.peers.sync(id).cursor, null);
    assert((await f.one(id)).attention.notices.includes("group_split"));
    await f.run(id);
    assertEquals(f.hub.store.files().length, 257);
    assertEquals(f.batches.map((batch) => batch.length), [256, 1]);
    assertEquals(f.hub.conflicts(), []);
    assert(remote.batches.every((batch) => batch.length <= 64));
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver native acceptance: group body acquisition is bounded to 64 MiB and exporter packets obey a smaller declared maxBatch", async () => {
  const remote = memoryRemote();
  remote.native.groups = true;
  const body = new Uint8Array(13 * 1024 * 1024);
  for (let i = 0; i < 5; i++) remote.put(`large/${i}.bin`, body);
  const f = await hubDriverFixture(remote, { native: true, maxBatch: 3 });
  try {
    const id = await f.add();
    assertEquals((await f.one(id)).status, "active");
    assertEquals(f.batches.map((batch) => batch.length), [4, 1]);
    assert((await f.one(id)).attention.notices.includes("group_split"));
    // One local scan transaction is one hub batch, too large for this endpoint.
    for (let i = 0; i < 8; i++) {
      Deno.writeTextFileSync(`${f.vault}/out-${i}.md`, `out ${i}`);
    }
    f.hub.scanNow();
    await f.run(id);
    assertEquals(remote.batches.map((batch) => batch.length), [3, 3, 2]);
    assert((await f.one(id)).attention.notices.includes("group_split"));
    assert(
      remote.batches.every((batch) =>
        batch.reduce((sum, item) => sum + (item.bytes?.length ?? 0), 0) <=
          16 * 1024 * 1024
      ),
    );
    for (const file of f.hub.store.files()) {
      assertEquals(
        versionOf(remote.objects.get(file.diskPath)!.bytes),
        file.hash,
      );
    }
  } finally {
    await f.close();
    await remote.close();
  }
});
