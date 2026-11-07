// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { walkSync } from "@std/fs";
import { storageServerFixture } from "./helpers/driver_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { versionOf } from "../server/hub/merge.ts";

function metadata(statePath: string, sql: string) {
  const db = new DatabaseSync(`${statePath}/hub.sqlite`, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
function sequence(statePath: string) {
  return metadata(statePath, "SELECT MAX(seq) AS seq FROM changes")[0].seq;
}
function disk(vault: string) {
  return new Map(
    [...walkSync(vault, { includeDirs: false })].map((
      entry,
    ) => [entry.path.slice(vault.length + 1), Deno.readFileSync(entry.path)]),
  );
}
function equalRemote(vault: string, remote: ReturnType<typeof memoryRemote>) {
  assertEquals(
    new Map([...remote.objects].map(([key, value]) => [key, value.bytes])),
    disk(vault),
  );
}
function writes(remote: ReturnType<typeof memoryRemote>) {
  return remote.requests.filter(({ method }) =>
    method === "PUT" || method === "DELETE"
  );
}

Deno.test("driver acceptance: real API + Workers + storage SDK + two HTTP remotes converge across editors, disk and remote collisions without echo", async () => {
  const a = memoryRemote({ token: "instance-alpha-key", pageSize: 2 });
  const b = memoryRemote({ token: "instance-beta-key", pageSize: 2 });
  a.put("remote-a.md", "from A");
  b.put("remote-b.md", "from B");
  const f = await storageServerFixture([a.authority, b.authority]);
  try {
    const first = await f.add(a.baseUrl, a.token, "Alpha"),
      second = await f.add(b.baseUrl, b.token, "Beta");
    await f.sync(first);
    equalRemote(f.vault, a);
    equalRemote(f.vault, b);
    await f.call("notes", "POST", {
      path: "editor",
      content: "# Editor\nfirst round\n",
    });
    await f.sync(first);
    await f.sync(second);
    equalRemote(f.vault, a);
    equalRemote(f.vault, b);
    // Local tools participate through the actual scanner, not a driver write.
    Deno.writeTextFileSync(`${f.vault}/disk.md`, "disk author");
    await waitUntil(
      () =>
        metadata(f.statePath, "SELECT disk_path FROM files").some((row) =>
            row.disk_path === "disk.md"
          )
          ? done()
          : pending("scanner"),
      { label: "local file enters hub inventory" },
    );
    await f.sync(first);
    await f.sync(second);
    const note = await f.call("notes/editor");
    await f.call("notes/editor", "PATCH", {
      newContent: "# Editor\nsecond round\n",
      baseContent: note.content,
    });
    a.put("remote-a.md", "A changed independently");
    await f.sync(first);
    await f.sync(second);
    equalRemote(f.vault, a);
    equalRemote(f.vault, b);
    // The two endpoints edit from the same admitted revision.
    a.put("editor.md", "A collision body");
    b.put("editor.md", "B collision body");
    await f.sync(first);
    await f.sync(second);
    await f.sync(first);
    equalRemote(f.vault, a);
    equalRemote(f.vault, b);
    const conflicts = await f.call("conflicts");
    assertEquals(conflicts.total, 1);
    assertEquals(conflicts.conflicts[0].peer, second);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/${conflicts.conflicts[0].copyPath}`),
      "B collision body",
    );
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/editor.md`),
      "A collision body",
    );
    assert(a.requests.some(({ cursor }) => cursor !== undefined));
    assert(a.requests.every(({ authorized }) => authorized));
    assert(b.requests.every(({ authorized }) => authorized));
    const before = sequence(f.statePath),
      nativeWrites = [writes(a).length, writes(b).length];
    for (let cycle = 0; cycle < 5; cycle++) {
      await f.sync(first);
      await f.sync(second);
    }
    assertEquals(sequence(f.statePath), before);
    assertEquals([writes(a).length, writes(b).length], nativeWrites);
    assertEquals((await f.call("conflicts")).total, 1);
  } finally {
    await f.close();
    await a.close();
    await b.close();
  }
});

Deno.test("driver acceptance: locked keys, incomplete multipage listings and failed GET never authorize deletion or advance past failed input", async () => {
  const remote = memoryRemote({ pageSize: 1 });
  remote.put("a.md", "A");
  remote.put("b.md", "B");
  remote.put("c.md", "C");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    const rows = metadata(f.statePath, "SELECT * FROM peer_files"),
      before = sequence(f.statePath);
    await f.key(id, "wrong-token");
    assertEquals((await f.one(id)).status, "locked");
    remote.clear();
    assertEquals((await f.sync(id)).status, "locked");
    assertEquals(sequence(f.statePath), before);
    assertEquals(metadata(f.statePath, "SELECT * FROM peer_files"), rows);
    assertEquals(writes(remote), []);
    // A genuinely empty, now authenticated endpoint is held for explicit review.
    await f.key(id, remote.token);
    assert((await f.one(id)).attention.remoteEmpty);
    await f.decide(id, "remote_empty_upload");
    equalRemote(f.vault, remote);
    remote.delete("a.md");
    remote.put("c.md", "new C");
    const cursor = metadata(f.statePath, "SELECT cursor FROM peer_sync");
    remote.faults.push({ path: "/list", cursor: "1", status: 500 });
    assertEquals((await f.sync(id)).status, "failed");
    assertEquals(Deno.readTextFileSync(`${f.vault}/a.md`), "A");
    assertEquals(metadata(f.statePath, "SELECT cursor FROM peer_sync"), cursor);
    remote.faults.push({
      path: "/object",
      key: "c.md",
      method: "GET",
      status: 500,
    });
    assertEquals((await f.sync(id)).status, "failed");
    assertEquals(Deno.readTextFileSync(`${f.vault}/a.md`), "A");
    assertEquals(Deno.readTextFileSync(`${f.vault}/c.md`), "C");
    assertEquals(metadata(f.statePath, "SELECT cursor FROM peer_sync"), cursor);
    assertEquals((await f.sync(id)).status, "active");
    equalRemote(f.vault, remote);
    assert(!disk(f.vault).has("a.md"));
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: complete empty remotes require explicit upload or delete decisions at real endpoints", async () => {
  const remote = memoryRemote();
  remote.put("a.md", "A");
  remote.put("b.md", "B");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    remote.clear();
    const before = sequence(f.statePath);
    assertEquals((await f.sync(id)).attention.remoteEmpty.files.length, 2);
    assertEquals(sequence(f.statePath), before);
    await f.decide(id, "remote_empty_upload");
    equalRemote(f.vault, remote);
    remote.clear();
    await f.sync(id);
    await f.decide(id, "remote_empty_delete");
    assertEquals(disk(f.vault).size, 0);
    assertEquals(remote.objects.size, 0);
    assertEquals((await f.one(id)).attention.remoteEmpty, null);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: commit then lost reply settles by read-back with no replay or conflict", async () => {
  const remote = memoryRemote();
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    await f.exportPrepared(id, async () => {
      await f.call("notes", "POST", {
        path: "uncertain",
        content: "native committed bytes",
      });
      remote.faults.push({
        method: "PUT",
        key: "uncertain.md",
        dropAfterCommit: true,
      });
    });
    assertEquals(remote.text("uncertain.md"), "native committed bytes");
    assertEquals(
      metadata(f.statePath, "SELECT state FROM peer_files")[0].state,
      "uncertain",
    );
    const count = writes(remote).length;
    await f.sync(id);
    assertEquals(
      metadata(f.statePath, "SELECT state FROM peer_files")[0].state,
      "synced",
    );
    assertEquals(writes(remote).length, count);
    assertEquals((await f.call("conflicts")).total, 0);
    equalRemote(f.vault, remote);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: conditional export conflicts preserve the intervening endpoint edit and converge", async () => {
  const remote = memoryRemote();
  remote.put("same.md", "base");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    await f.exportPrepared(id, async () => {
      await f.call("notes/same", "PATCH", {
        baseContent: "base",
        newContent: "hub edit",
      });
      remote.faults.push({
        method: "PUT",
        key: "same.md",
        before: () => {
          remote.put("same.md", "intervening remote edit");
        },
      });
    });
    assertEquals(remote.text("same.md"), "intervening remote edit");
    assertEquals(
      metadata(f.statePath, "SELECT state FROM peer_files")[0].state,
      "pending",
    );
    await f.sync(id);
    const conflicts = await f.call("conflicts");
    assertEquals(conflicts.total, 1);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/${conflicts.conflicts[0].copyPath}`),
      "intervening remote edit",
    );
    equalRemote(f.vault, remote);
    assert(writes(remote).some(({ ifMatch }) => ifMatch !== null));
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: endpoint epoch replacement adopts equals and preserves differing first-sync alternatives", async () => {
  const remote = memoryRemote();
  remote.put("same.md", "same");
  remote.put("changed.md", "before");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    remote.resetEpoch();
    remote.put("changed.md", "after reset");
    const count = writes(remote).length;
    await f.restart();
    await f.sync(id);
    assertEquals(Deno.readTextFileSync(`${f.vault}/changed.md`), "before");
    const conflicts = await f.call("conflicts");
    assertEquals(conflicts.total, 1);
    assertEquals(conflicts.conflicts[0].reason, "unknown-base");
    assertEquals(conflicts.conflicts[0].peer, id);
    assert(!writes(remote).slice(count).some(({ key }) => key === "same.md"));
    equalRemote(f.vault, remote);
    const sequenceBefore = sequence(f.statePath),
      writeCount = writes(remote).length;
    await f.restart();
    await f.sync(id);
    assertEquals(sequence(f.statePath), sequenceBefore);
    assertEquals(writes(remote).length, writeCount);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: deleted-here unchanged replicas delete there; edited replicas remain held until explicit restore or delete", async () => {
  const a = memoryRemote(), b = memoryRemote();
  a.put("note.md", "base");
  b.put("note.md", "base");
  const f = await storageServerFixture([a.authority, b.authority]);
  try {
    const first = await f.add(a.baseUrl, a.token, "A"),
      second = await f.add(b.baseUrl, b.token, "B");
    const before = await f.call("notes/note");
    b.put("note.md", "edited while offline");
    await f.call(`notes/note?base_version=${before.version}`, "DELETE");
    await f.sync(first);
    const held = await f.sync(second);
    assertEquals(a.text("note.md"), null);
    assertEquals(b.text("note.md"), "edited while offline");
    assertEquals(held.attention.held, [{ path: "note.md" }]);
    assertEquals(disk(f.vault).size, 0);
    await f.decide(second, "held_restore", ["note.md"]);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/note.md`),
      "edited while offline",
    );
    await f.sync(first);
    equalRemote(f.vault, a);
    equalRemote(f.vault, b);
    const next = await f.call("notes/note");
    b.put("note.md", "another offline edit");
    await f.call(`notes/note?base_version=${next.version}`, "DELETE");
    await f.sync(first);
    await f.sync(second);
    await f.decide(second, "held_delete");
    assertEquals(disk(f.vault).size, 0);
    assertEquals(b.objects.size, 0);
  } finally {
    await f.close();
    await a.close();
    await b.close();
  }
});

Deno.test("driver acceptance: exclusions, unsupported names and 17 MiB objects remain intact while eligible files sync", async () => {
  const remote = memoryRemote();
  remote.put("excluded/remote.md", "ignored");
  remote.put("large.bin", new Uint8Array(17 * 1024 * 1024));
  remote.put("ok.md", "eligible");
  const f = await storageServerFixture([remote.authority]);
  try {
    await f.call("notes", "POST", {
      path: "bad-name",
      content: "not portable on this endpoint",
    });
    const id = await f.add(remote.baseUrl, remote.token, "Names", {
      exclude: "excluded/",
      forbiddenCharacters: "-",
    });
    const row = await f.sync(id);
    assertEquals(Deno.readTextFileSync(`${f.vault}/ok.md`), "eligible");
    assertEquals(remote.text("bad-name.md"), null);
    assertEquals(
      remote.objects.get("large.bin")!.bytes.length,
      17 * 1024 * 1024,
    );
    assert(!disk(f.vault).has("large.bin"));
    assert(!disk(f.vault).has("excluded/remote.md"));
    assert(
      row.attention.issues.some((issue: { reason: string }) =>
        issue.reason === "too_large"
      ),
    );
    assert(
      row.attention.issues.some((issue: { reason: string }) =>
        issue.reason === "name_not_storable"
      ),
    );
    assert(
      metadata(f.statePath, "SELECT state FROM peer_files").some((row) =>
        row.state === "excluded"
      ),
    );
    await f.sync(id);
    assert(
      !remote.requests.some(({ method, key }) =>
        method !== "GET" && key === "large.bin"
      ),
    );
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: actual provider error strings are redacted across API, captured logs and durable state; removal securely deletes the only stored key", async () => {
  const marker = "secret-marker-/+==%20",
    remote = memoryRemote({ token: marker });
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, marker);
    for (const value of [marker, encodeURIComponent(marker), btoa(marker)]) {
      remote.faults.push({
        path: "/list",
        status: 401,
        message: `denied ${value}`,
      });
      assertEquals((await f.sync(id)).status, "locked");
    }
    assert(
      f.packets.every((value) =>
        !value.includes(marker) &&
        !value.includes(encodeURIComponent(marker)) &&
        !value.includes(btoa(marker))
      ),
    );
    assert(!JSON.stringify(f.server().logs()).includes(marker));
    for (const entry of walkSync(f.root, { includeDirs: false })) {
      if (entry.path.endsWith("driver-secrets.sqlite")) continue;
      assert(
        !new TextDecoder().decode(Deno.readFileSync(entry.path)).includes(
          marker,
        ),
        entry.path,
      );
    }
    assert(
      new TextDecoder().decode(
        Deno.readFileSync(`${f.statePath}/driver-secrets.sqlite`),
      ).includes(marker),
    );
    await f.call(`drivers/${id}`, "DELETE", {
      revision: (await f.one(id)).revision,
    });
    assert(
      !new TextDecoder().decode(
        Deno.readFileSync(`${f.statePath}/driver-secrets.sqlite`),
      ).includes(marker),
    );
    assertEquals(remote.objects.size, 0);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: read-only server restart pauses persisted instances; reenable resumes without echo", async () => {
  const remote = memoryRemote();
  remote.put("note.md", "initial");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    await f.configure(id, { enabled: false });
    remote.put("note.md", "off edit");
    assertEquals((await f.one(id)).status, "off");
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "initial");
    await f.configure(id, { enabled: true });
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "off edit");
    await f.restart({ GLOBNOTES_AUTH_TYPE: "read_only" });
    assertEquals((await f.one(id)).status, "paused");
    remote.put("note.md", "paused edit");
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "off edit");
    await f.restart();
    await f.sync(id);
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "paused edit");
    equalRemote(f.vault, remote);
    assertEquals(
      versionOf(Deno.readFileSync(`${f.vault}/note.md`)),
      metadata(f.statePath, "SELECT version FROM peer_files")[0].version,
    );
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: discovery rate-limit advice reaches instance retry state without losing its cursor or files", async () => {
  const remote = memoryRemote();
  remote.put("note.md", "retained");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    const cursor = metadata(f.statePath, "SELECT cursor FROM peer_sync");
    remote.faults.push({ path: "/list", status: 429, retryAfterMs: 23000 });
    const row = await f.sync(id);
    assertEquals(row.status, "failed");
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "retained");
    assertEquals(metadata(f.statePath, "SELECT cursor FROM peer_sync"), cursor);
    assertEquals(row.error.code, "rate_limited");
    assertEquals(row.error.retryAfterMs, 23000);
    assert(row.nextRetry > 22000);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: GET retry advice survives Worker transport; denied writes lock and stop subsequent packets", async () => {
  const remote = memoryRemote();
  remote.put("base.md", "base");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    remote.put("base.md", "new remote bytes");
    remote.faults.push({
      path: "/object",
      key: "base.md",
      method: "GET",
      status: 429,
      retryAfterMs: 27000,
    });
    const failed = await f.sync(id);
    assertEquals(failed.error.code, "rate_limited");
    assertEquals(failed.error.retryAfterMs, 27000);
    assert(failed.nextRetry > 26000);
    assertEquals(Deno.readTextFileSync(`${f.vault}/base.md`), "base");
    await f.sync(id);
    const count = writes(remote).length;
    const locked = await f.exportPrepared(id, async () => {
      await f.call("notes", "POST", { path: "a", content: "first packet" });
      await f.call("notes", "POST", { path: "b", content: "later packet" });
      remote.faults.push({
        method: "PUT",
        status: 401,
        message: "credentials rejected",
      });
      assertEquals(writes(remote).length, count);
    });
    assertEquals(
      locked.status,
      "locked",
      JSON.stringify({
        beforeFaultWrites: count,
        requests: remote.requests,
        pendingFaults: remote.faults.length,
        objects: [...remote.objects.keys()],
      }),
    );
    assertEquals(locked.reason, "credentials rejected");
    assertEquals(writes(remote).length, count + 1);
    assertEquals(remote.text("a.md"), null);
    assertEquals(remote.text("b.md"), null);
    assertEquals(
      metadata(
        f.statePath,
        "SELECT state FROM peer_files WHERE state='uncertain'",
      ),
      [],
    );
    await f.sync(id);
    equalRemote(f.vault, remote);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: sandbox network denial is distinct from endpoint authentication and links to permission controls", async () => {
  const remote = memoryRemote();
  const f = await storageServerFixture([remote.authority]);
  try {
    await f.approve(false);
    const id = await f.add(remote.baseUrl, remote.token);
    const row = await f.one(id);
    assertEquals(row.status, "failed");
    assertEquals(row.error.code, "network_denied");
    assertEquals(
      row.permissionsPage,
      "core:plugin-permissions:globnotes-test-driver",
    );
    assertEquals(remote.requests, []);
  } finally {
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: process restart during held native GET resumes from metadata and converges without replay", async () => {
  const remote = memoryRemote();
  remote.put("note.md", "base");
  const f = await storageServerFixture([remote.authority]);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let syncing: Promise<unknown> | undefined;
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    remote.put("note.md", "changed while running");
    remote.faults.push({
      method: "GET",
      path: "/object",
      key: "note.md",
      before: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    syncing = f.sync(id).catch(() => undefined); // A killed process cannot return its receipt.
    await entered.promise;
    await f.restart();
    release.resolve();
    await syncing;
    await f.sync(id);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/note.md`),
      "changed while running",
    );
    assertEquals((await f.call("conflicts")).total, 0);
    assertEquals(writes(remote), []);
    const before = sequence(f.statePath);
    await f.sync(id);
    assertEquals(sequence(f.statePath), before);
    equalRemote(f.vault, remote);
  } finally {
    release.resolve();
    await syncing;
    await f.close();
    await remote.close();
  }
});

Deno.test("driver acceptance: plugin disable synchronously turns its instances off; reenable imports retained endpoint changes", async () => {
  const remote = memoryRemote();
  remote.put("note.md", "base");
  const f = await storageServerFixture([remote.authority]);
  try {
    const id = await f.add(remote.baseUrl, remote.token);
    const toggle = async (enabled: boolean) => {
      const catalog = await f.call("plugin-host");
      await f.call("plugin-host/globnotes-test-driver/enabled", "PUT", {
        enabled,
        revision: catalog.policy.revision,
        signature: catalog.policy.signature,
      });
    };
    await toggle(false);
    remote.put("note.md", "edited while plugin off");
    assertEquals((await f.one(id)).status, "off");
    assertEquals(Deno.readTextFileSync(`${f.vault}/note.md`), "base");
    await toggle(true);
    await f.sync(id);
    assertEquals((await f.one(id)).status, "active");
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/note.md`),
      "edited while plugin off",
    );
    equalRemote(f.vault, remote);
  } finally {
    await f.close();
    await remote.close();
  }
});
