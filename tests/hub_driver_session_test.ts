// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  DiscoverRequest,
  DiscoveryPage,
  Driver,
  DriverError,
  Entry,
  ExportItem,
  MutationResult,
  ReadRequest,
  ReadResult,
} from "../server/plugins/driver_contract.ts";
import { DriverSession } from "../server/hub/drivers/session.ts";
import {
  DriverPeers,
  PeerRevisionConflict,
} from "../server/hub/drivers/peers.ts";
import { driverRedactor } from "../server/hub/drivers/redact.ts";
import { versionOf } from "../server/hub/merge.ts";
import { driverCapabilities } from "./helpers/driver_fixture.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
class NativeRemote implements Driver {
  files = new Map<string, { bytes: Uint8Array; revision: string }>();
  writes: ExportItem[][] = [];
  count = 0;
  epoch = "1";
  scope = "all";
  excluded = new Set<string>();
  incomplete = false;
  locked = false;
  readFailure: string | null = null;
  readLocked: string | null = null;
  applyFailure: DriverError | null = null;
  uncertain: "committed" | "unsent" | null = null;
  applyConflict: (() => void) | null = null;
  put(path: string, body: string) {
    this.files.set(path, { bytes: bytes(body), revision: `r${++this.count}` });
  }
  open() {
    return this.locked ? { state: "locked" as const, reason: "needs key" } : {
      state: "ready" as const,
      endpoint: { id: "remote", epoch: this.epoch },
      scope: this.scope,
    };
  }
  discover(_request: DiscoverRequest): DiscoveryPage {
    return {
      endpoint: { id: "remote", epoch: this.epoch },
      scope: this.scope,
      mode: "snapshot",
      completion: this.incomplete ? "incomplete" : "complete",
      entries: [...this.files].map(([path, file]): Entry =>
        this.excluded.has(path) ? { state: "excluded", path } : {
          state: "known",
          path,
          revision: file.revision,
          size: file.bytes.length,
        }
      ),
    };
  }
  read(request: ReadRequest): ReadResult {
    if (request.path === this.readLocked) {
      return { state: "locked", reason: "private-key rejected" };
    }
    if (request.path === this.readFailure) {
      return { state: "unknown", reason: "unavailable" };
    }
    const file = this.files.get(request.path);
    return file
      ? { state: "known", bytes: file.bytes.slice(), revision: file.revision }
      : { state: "absent" };
  }
  apply(items: ExportItem[]): MutationResult[] {
    this.writes.push(structuredClone(items));
    this.applyConflict?.();
    this.applyConflict = null;
    return items.map((item) => {
      if (this.applyFailure) {
        return { id: item.id, state: "failed", error: this.applyFailure };
      }
      if (this.uncertain === "unsent") {
        return { id: item.id, state: "uncertain" };
      }
      const old = this.files.get(item.path);
      if (
        "revision" in item.base
          ? item.base.revision !== old?.revision
          : old !== undefined
      ) return { id: item.id, state: "conflict" };
      if (this.excluded.has(item.path)) {
        return { id: item.id, state: "excluded" };
      }
      const revision = `r${++this.count}`;
      if (item.op === "put") {
        this.files.set(item.path, { bytes: item.bytes!.slice(), revision });
      } else this.files.delete(item.path);
      return this.uncertain ? { id: item.id, state: "uncertain" } : {
        id: item.id,
        state: "settled",
        ...(item.op === "put" ? { revision } : {}),
      };
    });
  }
  close() {}
}
function sessionFixture() {
  const f = hubOperationsFixture();
  const peers = new DriverPeers(f.hub.store);
  const remote = new NativeRemote();
  const sessions: DriverSession[] = [];
  let instance = peers.create("test-driver", "Remote");
  instance = peers.update(instance.id, instance.revision, {
    ...instance,
    enabled: true,
  });
  const make = (capabilities = driverCapabilities, changed = () => {}) => {
    const session = new DriverSession(instance, capabilities, {
      hub: f.hub,
      operations: f.operations,
      driver: remote,
      current: () => true,
      writable: () => f.lifecycle.writable(),
      redact: driverRedactor(["private-key"]),
      changed,
    });
    sessions.push(session);
    return session;
  };
  const off = f.hub.subscribe((entries) => {
    for (const session of sessions) session.observe(entries);
  });
  return {
    ...f,
    peers,
    remote,
    instance,
    make,
    close() {
      for (const session of sessions) session.retire();
      off();
      f.close();
    },
  };
}
function disk(f: ReturnType<typeof sessionFixture>, path: string) {
  return Deno.readTextFileSync(`${f.vault}/${path}`);
}

Deno.test("driver session: only real file movement emits activity, coalesced across a multi-file cycle", async () => {
  const f = sessionFixture();
  let session: DriverSession;
  const transitions: ("receiving" | "sending" | null)[] = [];
  try {
    session = f.make(driverCapabilities, () => {
      const activity = session?.activity() ?? null;
      if (transitions.at(-1) !== activity) transitions.push(activity);
    });
    await session.run();
    assertEquals(transitions.filter(Boolean), []);
    transitions.length = 0;
    for (let i = 0; i < 20; i++) f.remote.put(`remote${i}.md`, `body ${i}`);
    await session.run();
    assertEquals(transitions, ["receiving", null]);
    assertEquals(f.hub.store.files().length, 20);
    transitions.length = 0;
    await session.run();
    assertEquals(transitions.filter(Boolean), []);
    transitions.length = 0;
    for (let i = 0; i < 20; i++) {
      Deno.writeTextFileSync(`${f.vault}/remote${i}.md`, `edit ${i}`);
    }
    f.hub.scanNow();
    await session.run(false);
    assertEquals(transitions, ["sending", null]);
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("remote0.md")!.bytes),
      "edit 0",
    );
  } finally {
    f.close();
  }
});

Deno.test("driver session: grouped imports and echo-free export converge through real note operations", async () => {
  const f = sessionFixture();
  try {
    for (let i = 0; i < 13; i++) {
      f.remote.put(i === 12 ? "image.png" : `note${i}.md`, `body ${i}`);
    }
    f.remote.readFailure = "note5.md";
    const session = f.make();
    await session.run();
    assertEquals(f.hub.store.files(), []);
    assertEquals(f.remote.writes.length, 0);
    f.remote.readFailure = null;
    await session.run();
    assertEquals(f.hub.store.files().length, 13);
    assertEquals(f.batches.length, 1);
    assertEquals(f.batches[0].length, 13);
    assertEquals(new Set(f.batches[0].map((entry) => entry.batch)).size, 1);
    assertEquals(f.batches[0][0].path, "image.png");
    assertEquals(f.remote.writes.length, 0);
    const seq = f.hub.sequence();
    for (let i = 0; i < 5; i++) await session.run();
    assertEquals(f.hub.sequence(), seq);
    assertEquals(f.remote.writes.length, 0);
    Deno.writeTextFileSync(`${f.vault}/note0.md`, "local edit");
    f.hub.scanNow();
    await session.run(false);
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("note0.md")!.bytes),
      "local edit",
    );
    assertEquals(f.remote.writes.length, 1);
    await session.run();
    assertEquals(f.hub.sequence(), seq + 1);
    assertEquals(f.remote.writes.length, 1);
  } finally {
    f.close();
  }
});

Deno.test("driver session: metadata-only native conflicts recover the owed local export without copies across restart", async () => {
  for (const restart of [false, true]) {
    const f = sessionFixture();
    try {
      f.remote.put("A.md", "base");
      const original = f.make();
      await original.run();
      Deno.writeFileSync(`${f.vault}/A.md`, bytes("local edit"));
      f.hub.scanNow();
      const seq = f.hub.sequence();
      let nextRevision = "";
      f.remote.applyConflict = () => {
        f.remote.put("A.md", "base");
        nextRevision = f.remote.files.get("A.md")!.revision;
      };
      await original.run(false);
      assertEquals(f.peers.file(f.instance.id, "A.md")?.state, "pending");
      assertEquals(f.remote.writes.length, 1);
      assertEquals(f.hub.conflicts(), []);
      if (restart) original.retire();
      const session = restart ? f.make() : original;
      await session.run();
      assertEquals(disk(f, "A.md"), "local edit");
      assertEquals(f.remote.files.get("A.md")?.bytes, bytes("local edit"));
      assertEquals(f.remote.writes.length, 2);
      assertEquals(f.remote.writes[1][0].base, { revision: nextRevision });
      assertEquals(f.peers.file(f.instance.id, "A.md")?.state, "synced");
      assertEquals(f.hub.conflicts(), []);
      assertEquals(f.hub.sequence(), seq);
      for (let cycle = 0; cycle < 5; cycle++) await session.run();
      assertEquals(f.remote.writes.length, 2);
      assertEquals(f.hub.sequence(), seq);
      assertEquals(f.hub.conflicts(), []);
    } finally {
      f.close();
    }
  }
});

Deno.test("driver session: unknown incomplete and exclusions cannot infer deletions or export", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "A");
    f.remote.put("B.md", "B");
    f.remote.put("keep.md", "known throughout");
    const session = f.make();
    await session.run();
    f.remote.files.delete("B.md");
    f.remote.incomplete = true;
    Deno.writeTextFileSync(`${f.vault}/A.md`, "local");
    f.hub.scanNow();
    await session.run();
    assertEquals(disk(f, "B.md"), "B");
    assertEquals(f.remote.writes.length, 0);
    f.remote.incomplete = false;
    f.remote.excluded.add("A.md");
    await session.run();
    assertEquals(disk(f, "A.md"), "local");
    assertEquals(f.hub.fileState("B.md"), null);
    assertEquals(f.remote.writes.length, 0);
    assertEquals(f.peers.file(f.instance.id, "A.md")?.state, "excluded");
  } finally {
    f.close();
  }
});

Deno.test("driver session: empty remote requires fresh revision-bound delete or upload decisions", async () => {
  for (
    const action of ["remote_empty_delete", "remote_empty_upload"] as const
  ) {
    const f = sessionFixture();
    try {
      f.remote.put("A.md", "A");
      const session = f.make();
      await session.run();
      f.remote.files.clear();
      await session.run();
      const attention = session.snapshot().attention;
      assertEquals(attention.remoteEmpty?.files, [{
        path: "A.md",
        version: versionOf(bytes("A")),
      }]);
      assertEquals(disk(f, "A.md"), "A");
      assertEquals(f.remote.writes.length, 0);
      await assertRejects(() =>
        session.decide({
          instanceRevision: f.instance.revision,
          attentionRevision: attention.revision - 1,
          action,
        }), PeerRevisionConflict);
      await session.decide({
        instanceRevision: f.instance.revision,
        attentionRevision: attention.revision,
        action,
      });
      assertEquals(
        f.hub.fileState("A.md") !== null,
        action === "remote_empty_upload",
      );
      assertEquals(
        f.remote.files.has("A.md"),
        action === "remote_empty_upload",
      );
      assertEquals(session.snapshot().attention.remoteEmpty, null);
    } finally {
      f.close();
    }
  }
});

Deno.test("driver session: deleted-here copies never resurrect, held choices restore or delete only the observed remote", async () => {
  for (const action of ["held_restore", "held_delete"] as const) {
    const f = sessionFixture();
    try {
      f.remote.put("A.md", "base");
      f.remote.put("keep.md", "keep");
      const session = f.make();
      await session.run();
      Deno.removeSync(`${f.vault}/A.md`);
      f.hub.scanNow();
      f.remote.put("A.md", "remote edited");
      await session.run();
      assertEquals(f.hub.fileState("A.md"), null);
      assertEquals(session.snapshot().attention.held, [{ path: "A.md" }]);
      await session.decide({
        instanceRevision: f.instance.revision,
        attentionRevision: session.snapshot().attention.revision,
        action,
      });
      assertEquals(f.hub.fileState("A.md") !== null, action === "held_restore");
      assertEquals(f.remote.files.has("A.md"), action === "held_restore");
      if (action === "held_restore") {
        assertEquals(disk(f, "A.md"), "remote edited");
      }
      assertEquals(disk(f, "keep.md"), "keep");
    } finally {
      f.close();
    }
  }
});

Deno.test("driver session: unchanged deleted-here file is removed remotely, including recovery without persisted names", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const original = f.make();
    await original.run();
    original.retire();
    Deno.removeSync(`${f.vault}/A.md`);
    f.hub.scanNow();
    const session = f.make();
    await session.run();
    assertEquals(f.remote.files.has("A.md"), false);
    assertEquals(f.hub.fileState("A.md"), null);
    assertEquals(session.snapshot().attention.held, []);
  } finally {
    f.close();
  }
});

Deno.test("driver session: uncertain committed or unsent put re-observes before retry without copies", async () => {
  for (const effect of ["committed", "unsent"] as const) {
    const f = sessionFixture();
    try {
      f.remote.put("A.md", "base");
      const session = f.make();
      await session.run();
      Deno.writeTextFileSync(`${f.vault}/A.md`, "local");
      f.hub.scanNow();
      f.remote.uncertain = effect;
      await session.run(false);
      assertEquals(f.peers.file(f.instance.id, "A.md")?.state, "uncertain");
      f.remote.uncertain = null;
      await session.run();
      assertEquals(disk(f, "A.md"), "local");
      assertEquals(
        new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
        "local",
      );
      assertEquals(f.remote.writes.length, effect === "committed" ? 1 : 2);
      assertEquals(f.hub.conflicts(), []);
    } finally {
      f.close();
    }
  }
});

Deno.test("driver session: native conflict imports the changed remote once and preserves both versions", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.writeTextFileSync(`${f.vault}/A.md`, "local");
    f.hub.scanNow();
    f.remote.applyConflict = () => f.remote.put("A.md", "remote raced");
    await session.run(false);
    await session.run();
    assertEquals(disk(f, "A.md"), "local");
    assertEquals(f.hub.conflicts().length, 1);
    assertEquals(disk(f, f.hub.conflicts()[0].copyPath!), "remote raced");
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
      "local",
    );
    assertEquals(f.remote.files.size, 2);
    await session.run();
    assertEquals(f.hub.conflicts().length, 1);
  } finally {
    f.close();
  }
});

Deno.test("driver session: new endpoint epoch adopts equal files and never deletes on rebootstrap", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    f.remote.put("B.md", "old");
    const original = f.make();
    await original.run();
    original.retire();
    f.remote.epoch = "new";
    f.remote.files.delete("B.md");
    const session = f.make();
    await session.run();
    assertEquals(disk(f, "A.md"), "base");
    assertEquals(disk(f, "B.md"), "old");
    assertEquals(f.remote.files.has("B.md"), true);
    assertEquals(f.hub.conflicts(), []);
    assertEquals(f.remote.writes.flat().map((item) => item.path), ["B.md"]);
  } finally {
    f.close();
  }
});

Deno.test("driver session: per-page read locks, invalid state targets and stale attention fail safely", async () => {
  const f = sessionFixture();
  try {
    const session = f.make();
    f.remote.put("A.md", "A");
    await session.run();
    f.remote.files.clear();
    await session.run();
    const attention = session.snapshot().attention.revision;
    f.remote.put("A.md", "returned");
    await assertRejects(
      () =>
        session.decide({
          instanceRevision: f.instance.revision,
          attentionRevision: attention,
          action: "remote_empty_delete",
        }),
      PeerRevisionConflict,
    );
    assert(disk(f, "A.md").length > 0);
    assertEquals(f.remote.files.has("A.md"), true);
    f.remote.put("../state/hub.sqlite", "never applied");
    await session.run();
    assert(
      session.snapshot().attention.issues.some((issue) =>
        issue.code === "invalid"
      ),
    );
  } finally {
    f.close();
  }
});

Deno.test("driver session: failed fresh empty review never authorizes cached deletions", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "A");
    const session = f.make();
    await session.run();
    f.remote.files.clear();
    await session.run();
    const attention = session.snapshot().attention.revision;
    f.remote.incomplete = true;
    await assertRejects(
      () =>
        session.decide({
          instanceRevision: f.instance.revision,
          attentionRevision: attention,
          action: "remote_empty_delete",
        }),
      PeerRevisionConflict,
    );
    assertEquals(disk(f, "A.md"), "A");
    assertEquals(f.remote.writes, []);
  } finally {
    f.close();
  }
});

Deno.test("driver session: held decisions bind native revision even when displayed paths do not change", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.removeSync(`${f.vault}/A.md`);
    f.hub.scanNow();
    f.remote.put("A.md", "held one");
    await session.run();
    const attention = session.snapshot().attention.revision;
    f.remote.put("A.md", "held two");
    await assertRejects(
      () =>
        session.decide({
          instanceRevision: f.instance.revision,
          attentionRevision: attention,
          action: "held_restore",
        }),
      PeerRevisionConflict,
    );
    assertEquals(f.hub.fileState("A.md"), null);
    assert(session.snapshot().attention.revision > attention);
    session.retire();
    const replacement = f.make();
    await replacement.run();
    assert(
      replacement.snapshot().attention.revision >
        session.snapshot().attention.revision,
    );
    await assertRejects(
      () =>
        replacement.decide({
          instanceRevision: f.instance.revision,
          attentionRevision: attention,
          action: "held_delete",
        }),
      PeerRevisionConflict,
    );
  } finally {
    f.close();
  }
});

Deno.test("driver session: cursor never advances through a failed body and read locks recover without export", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "A");
    f.remote.put("B.md", "B");
    const discover = f.remote.discover.bind(f.remote);
    f.remote.discover = (request) => ({
      ...discover(request),
      cursor: "checkpoint",
    });
    const session = f.make();
    f.remote.readFailure = "B.md";
    await session.run();
    assertEquals(f.peers.sync(f.instance.id).cursor, null);
    assertEquals(f.hub.store.files(), []);
    f.remote.readFailure = null;
    f.remote.readLocked = "B.md";
    await session.run();
    assertEquals(session.snapshot().status, "locked");
    assertEquals(session.snapshot().reason, "[secret] rejected");
    assertEquals(f.hub.store.files(), []);
    assertEquals(f.remote.writes, []);
    f.remote.readLocked = null;
    await session.run();
    assertEquals(f.peers.sync(f.instance.id).cursor, "checkpoint");
    assertEquals(disk(f, "A.md"), "A");
    assertEquals(disk(f, "B.md"), "B");
    assertEquals(session.snapshot().status, "active");
  } finally {
    f.close();
  }
});

Deno.test("driver session: all concurrent triggers and decisions share one activity lane", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.removeSync(`${f.vault}/A.md`);
    f.hub.scanNow();
    f.remote.put("A.md", "held");
    await session.run();
    const input = {
      instanceRevision: f.instance.revision,
      attentionRevision: session.snapshot().attention.revision,
      action: "held_restore" as const,
    };
    const results = await Promise.allSettled([
      session.decide(input),
      session.decide(input),
      session.run(),
      session.run(false),
    ]);
    assertEquals(results[0].status, "fulfilled");
    assertEquals(results[1].status, "rejected");
    assertEquals(disk(f, "A.md"), "held");
    assertEquals(f.hub.conflicts(), []);
  } finally {
    f.close();
  }
});

Deno.test("driver session: failed sends retain obligations and retry advice instead of acknowledging bytes", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.writeTextFileSync(`${f.vault}/A.md`, "local");
    f.hub.scanNow();
    f.remote.applyFailure = {
      code: "rate_limited",
      retryAfterMs: 90_000,
      message: "private-key quota",
    };
    await session.run(false);
    const row = f.peers.file(f.instance.id, "A.md")!;
    assertEquals(row.state, "pending");
    assertEquals(row.version, versionOf(bytes("base")));
    assertEquals(row.attempts, 1);
    assert(row.nextAt >= 90_000);
    assertEquals(session.snapshot().status, "failed");
    assertEquals(session.snapshot().error?.message, "[secret] quota");
    f.remote.applyFailure = null;
    await session.run();
    assertEquals(f.remote.writes.length, 1);
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
      "base",
    );
    session.retire();
    const replacement = f.make();
    await replacement.run();
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
      "local",
    );
    assertEquals(f.hub.conflicts(), []);
  } finally {
    f.close();
  }
});

Deno.test("driver session: a changed export receipt cannot skip hub changes made during dispatch", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.writeTextFileSync(`${f.vault}/A.md`, "first");
    f.hub.scanNow();
    f.remote.applyConflict = () => {
      Deno.writeTextFileSync(`${f.vault}/A.md`, "newer");
      f.hub.scanNow();
    };
    await session.run(false);
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
      "first",
    );
    await session.run(false);
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
      "newer",
    );
    assertEquals(f.remote.writes.length, 2);
  } finally {
    f.close();
  }
});

Deno.test("driver session: a complete hub batch is one native apply and an unavailable member defers its whole unit", async () => {
  const f = sessionFixture();
  try {
    const session = f.make();
    await session.run();
    let source = f.peers.create("test-driver", "Source");
    source = f.peers.update(source.id, source.revision, {
      ...source,
      enabled: true,
    });
    const members = Array.from(
      { length: 13 },
      (_, i) => ({
        path: i === 12 ? "image.png" : `N${i}.md`,
        bytes: bytes(`body ${i}`),
        revision: `native-${i}`,
        expectedVersion: null,
      }),
    );
    await f.operations.applyDriverImport(source.id, members);
    Deno.removeSync(`${f.vault}/N5.md`);
    await session.run(false);
    assertEquals(f.remote.writes.length, 0);
    assertEquals(f.peers.file(f.instance.id, "N0.md")?.state, "pending");
    Deno.writeTextFileSync(`${f.vault}/N5.md`, "body 5");
    await session.run(false);
    assertEquals(f.remote.writes.length, 1);
    assertEquals(f.remote.writes[0].length, 13);
    assertEquals(new Set(f.remote.writes[0].map((item) => item.batch)).size, 1);
    assertEquals(f.remote.files.size, 13);
  } finally {
    f.close();
  }
});

Deno.test("driver session: a locally recreated held path reconciles without silently overwriting either version", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.removeSync(`${f.vault}/A.md`);
    f.hub.scanNow();
    f.remote.put("A.md", "held");
    await session.run();
    Deno.writeTextFileSync(`${f.vault}/A.md`, "recreated here");
    f.hub.scanNow();
    await session.run();
    assertEquals(disk(f, "A.md"), "recreated here");
    assertEquals(f.hub.conflicts().length, 1);
    assertEquals(disk(f, f.hub.conflicts()[0].copyPath!), "held");
    assertEquals(session.snapshot().attention.held, []);
  } finally {
    f.close();
  }
});

Deno.test("driver session: decision request authority is rechecked after remote body waits", async () => {
  const f = sessionFixture();
  try {
    f.remote.put("A.md", "base");
    const session = f.make();
    await session.run();
    Deno.removeSync(`${f.vault}/A.md`);
    f.hub.scanNow();
    f.remote.put("A.md", "held");
    await session.run();
    let authorized = true;
    const read = f.remote.read.bind(f.remote);
    f.remote.read = (request) => {
      const result = read(request);
      authorized = false;
      return result;
    };
    await assertRejects(
      () =>
        session.decide({
          instanceRevision: f.instance.revision,
          attentionRevision: session.snapshot().attention.revision,
          action: "held_restore",
        }, () => {
          if (!authorized) throw new Error("request authority expired");
        }),
      Error,
      "request authority expired",
    );
    assertEquals(f.hub.fileState("A.md"), null);
    assertEquals(
      new TextDecoder().decode(f.remote.files.get("A.md")!.bytes),
      "held",
    );
  } finally {
    f.close();
  }
});

Deno.test("driver session: an unchanged oversized native file stays unsupported across repeated passes", async () => {
  const f = sessionFixture();
  try {
    const body = new Uint8Array(17 * 1024 * 1024);
    f.remote.files.set("large.bin", {
      bytes: body,
      revision: "large-revision",
    });
    Deno.writeTextFileSync(`${f.vault}/large.bin`, "local bytes");
    f.hub.scanNow();
    const session = f.make();
    await session.run();
    await session.run();
    assertEquals(disk(f, "large.bin"), "local bytes");
    assertEquals(
      f.remote.files.get("large.bin")!.bytes.byteLength,
      body.byteLength,
    );
    assertEquals(f.remote.writes, []);
    assertEquals(session.snapshot().attention.issues, [{
      path: "large.bin",
      code: "unsupported",
      reason: "too_large",
    }]);
  } finally {
    f.close();
  }
});

Deno.test("driver session: mixed native receipts cannot hide authentication failure or its stop on later packets", async () => {
  const f = sessionFixture();
  try {
    for (const path of ["a.md", "b.md", "c.md"]) {
      Deno.writeTextFileSync(`${f.vault}/${path}`, path);
    }
    f.hub.scanNow();
    f.remote.apply = (items) => {
      f.remote.writes.push(items);
      return items.map(({ id }, index) => ({
        id,
        state: "failed",
        error: {
          code: index === 0 ? "denied" : "offline",
          message: "needs authentication",
        },
      }));
    };
    const session = f.make({ ...driverCapabilities, limits: { maxBatch: 2 } });
    await session.run();
    assertEquals(session.snapshot().status, "locked");
    assertEquals(f.remote.writes.length, 1);
    assertEquals(
      f.peers.files(f.instance.id).some(({ state }) => state === "uncertain"),
      false,
    );
  } finally {
    f.close();
  }
});
