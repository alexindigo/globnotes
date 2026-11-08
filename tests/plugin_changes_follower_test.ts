// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { type CursorOwner, LogFollower } from "../server/hub/follower.ts";
import type { PluginCursor } from "../server/hub/store.ts";
import { ObservedClock } from "../server/observed_time.ts";
import {
  type ChangePacket,
  encodedBytes,
} from "../server/plugins/change_contract.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";
import { LivenessClock } from "./helpers/worker_liveness.ts";

function fixture(limit?: number) {
  const f = hubOperationsFixture({}, { changeLimit: limit });
  const scheduler = new LivenessClock();
  const clock = new ObservedClock(scheduler);
  const followers: LogFollower[] = [];
  const packets: ChangePacket[] = [];
  let active = true;
  const owner: CursorOwner = {
    load: () => f.hub.store.pluginCursor("test"),
    commit: (expected, next) =>
      f.hub.store.advancePluginCursor("test", expected, next),
  };
  const add = (options: {
    cursor?: CursorOwner;
    authorityKey?: string;
    deliver?(packet: ChangePacket): Promise<unknown>;
  } = {}) => {
    const follower = new LogFollower({
      hub: f.hub,
      cursor: options.cursor ?? owner,
      authorityKey: options.authorityKey ?? "all",
      current: () => active,
      clock,
      deliver: (packet) => {
        packets.push(packet);
        assert(Object.isFrozen(packet));
        assert(encodedBytes(packet) <= 1024 * 1024);
        return options.deliver?.(packet) ??
          Promise.resolve({ ack: packet.token });
      },
    });
    followers.push(follower);
    return follower;
  };
  const step = async (ms = 1) => {
    scheduler.tick(scheduler.time + ms, true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const write = (path: string, text = path) => {
    Deno.writeTextFileSync(`${f.vault}/${path}`, text);
    f.hub.scanNow();
  };
  return {
    ...f,
    scheduler,
    clock,
    owner,
    packets,
    add,
    step,
    write,
    retire() {
      active = false;
    },
    close() {
      followers.forEach((follower) => follower.stop());
      f.close();
    },
  };
}

Deno.test("log follower: acknowledged reset snapshots current metadata, then catches writes during snapshot without sync-stack dispatch", async () => {
  const f = fixture();
  try {
    f.write("one.md");
    const follower = f.add();
    assertEquals(f.packets.length, 0);
    await f.step();
    assertEquals(f.packets[0].type, "gap");
    assertEquals(f.owner.load(), null);
    f.write("two.md");
    assertEquals(f.packets.length, 1);
    await f.step();
    assertEquals(f.packets[1].type, "snapshot");
    const snapshot = f.packets[1];
    assert(snapshot.type === "snapshot");
    assertEquals(snapshot.entries.map((row) => row.path), ["one.md"]);
    assertEquals(f.owner.load()?.seq, 1);
    await f.step();
    const changes = f.packets[2];
    assert(changes.type === "changes");
    assertEquals(changes.entries.map((row) => row.path), ["two.md"]);
    assertEquals(f.owner.load()?.seq, 2);
    await f.step();
    assertEquals(follower.status, {
      cursor: 2,
      lag: 0,
      reset: null,
      lastError: null,
    });
  } finally {
    f.close();
  }
});

Deno.test("log follower: failed/forged acknowledgements retry from SQLite after scrub with observed backoff and no duplicate in-flight call", async () => {
  const f = fixture();
  let reject = true;
  try {
    const follower = f.add({
      deliver: (packet) =>
        Promise.resolve(reject ? { ack: "forged" } : { ack: packet.token }),
    });
    await f.step();
    assertEquals(f.owner.load(), null);
    assertEquals(follower.status.lastError, "changes_delivery_failed");
    await f.step(4999);
    assertEquals(f.packets.length, 1);
    reject = false;
    await f.step(1);
    assertEquals(f.packets.length, 2);
    await f.step(); // empty final snapshot
    assertEquals(f.owner.load()?.seq, 0);
    reject = true;
    f.write("private-deleted-name.md", "body-marker");
    await f.step();
    assertEquals(f.owner.load()?.seq, 0);
    Deno.removeSync(`${f.vault}/private-deleted-name.md`);
    f.hub.scanNow();
    reject = false;
    await f.step(5000);
    const page = f.packets.at(-1)!;
    assert(page.type === "changes");
    assertEquals(page.entries.map((entry) => entry.path), [null, null]);
    assert(!JSON.stringify(page).includes("private-deleted-name"));
    assertEquals(f.owner.load()?.seq, 2);
    f.hub.store.checkpoint();
    for (const suffix of ["", "-wal"]) {
      const text = new TextDecoder().decode(
        Deno.readFileSync(`${f.config.statePath}/hub.sqlite${suffix}`),
      );
      assert(!text.includes("private-deleted-name"));
      assert(!text.includes("body-marker"));
    }
  } finally {
    f.close();
  }
});

Deno.test("log follower: cursor resumes on restart; changed authority, replaced log and future cursors require explicit reset", async () => {
  const f = fixture();
  try {
    f.write("one.md");
    let follower = f.add();
    await f.step();
    await f.step();
    await f.step();
    follower.stop();
    f.write("two.md");
    f.packets.length = 0;
    follower = f.add();
    await f.step();
    assertEquals(f.packets[0].type, "changes");
    assertEquals(f.owner.load()?.seq, 2);
    follower.stop();
    for (
      const [reason, cursor] of [
        ["authority_changed", {
          logId: f.hub.store.logId,
          seq: 2,
          authorityKey: "narrow",
        }],
        ["log_replaced", { logId: "different", seq: 2, authorityKey: "all" }],
        ["future_cursor", {
          logId: f.hub.store.logId,
          seq: 20,
          authorityKey: "all",
        }],
      ] as const
    ) {
      f.packets.length = 0;
      follower = f.add({ cursor: { load: () => cursor, commit: () => false } });
      await f.step();
      const packet = f.packets[0];
      assert(packet.type === "gap");
      assertEquals(packet.reason, reason);
      follower.stop();
    }
  } finally {
    f.close();
  }
});

Deno.test("log follower: held delivery cannot block independent follower or save; retirement fences its late ack", async () => {
  const f = fixture();
  const held = Promise.withResolvers<unknown>();
  try {
    const first = f.add({ deliver: () => held.promise });
    await f.step();
    let other: PluginCursor | null = null;
    const second = f.add({
      cursor: {
        load: () => other,
        commit: (_before, next) => {
          other = next;
          return true;
        },
      },
    });
    await f.step();
    await f.step();
    f.write("independent.md");
    await f.step();
    assertEquals(second.status.cursor, 1);
    assertEquals(f.owner.load(), null);
    first.stop();
    held.resolve({ ack: f.packets[0].token });
    await f.step();
    assertEquals(f.owner.load(), null);
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/independent.md`),
      "independent.md",
    );
  } finally {
    held.resolve({});
    f.close();
  }
});

Deno.test("log follower: multi-page snapshot acks are nondurable; deleted/symlink/state/staging candidates are rechecked before disclosure", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 130; i++) {
      Deno.writeTextFileSync(
        `${f.vault}/${String(i).padStart(3, "0")}.md`,
        "note",
      );
    }
    f.hub.scanNow();
    f.add();
    await f.step();
    await f.step();
    assertEquals(f.owner.load(), null);
    const page = f.packets[1];
    assert(page.type === "snapshot" && !page.complete);
    assertEquals(page.entries.length, 128);
    Deno.removeSync(`${f.vault}/128.md`);
    Deno.removeSync(`${f.vault}/129.md`);
    Deno.symlinkSync(`${f.config.statePath}/hub.sqlite`, `${f.vault}/129.md`);
    f.hub.scanNow();
    await f.step();
    const tail = f.packets[2];
    assert(tail.type === "snapshot" && tail.complete);
    assertEquals(tail.entries, []);
    assertEquals(f.owner.load()?.seq, 130);
    await f.step();
    const replay = f.packets[3];
    assert(replay.type === "changes");
    assert(replay.entries.every((entry) => entry.path === null));
    assertEquals(f.owner.load()?.seq, 132);
    // Inject unsafe metadata to prove disclosure rechecks rather than trusting inventory.
    for (
      const name of [".globnotes-staging-fake", "../state/hub.sqlite", "129.md"]
    ) {
      f.hub.store.apply(
        [{
          path: name,
          file: { key: name, diskPath: name, hash: "a", size: 1, mtimeMs: 1 },
        }],
        "local",
        null,
      );
    }
    f.packets.length = 0;
    const fresh = f.add({ cursor: { load: () => null, commit: () => true } });
    await f.step();
    await f.step();
    await f.step();
    const disclosed = f.packets.filter((packet) => packet.type === "snapshot")
      .flatMap((packet) => packet.entries.map((entry) => entry.path));
    assert(
      disclosed.every((name) =>
        !name.includes("staging") && !name.includes("..") && name !== "129.md"
      ),
    );
    fresh.stop();
  } finally {
    f.close();
  }
});

Deno.test("log follower: retention during held final snapshot ack aborts recovery, and observed expiry releases inventory", async () => {
  const f = fixture(2);
  const held = Promise.withResolvers<unknown>();
  try {
    f.write("one.md");
    let hold = true;
    f.add({
      deliver: (packet) =>
        packet.type === "snapshot" && hold
          ? held.promise
          : Promise.resolve({ ack: packet.token }),
    });
    await f.step();
    await f.step();
    const token = f.packets.at(-1)!.token;
    f.write("two.md");
    f.write("three.md");
    f.write("four.md");
    hold = false;
    held.resolve({ ack: token });
    await f.step();
    await f.step();
    assertEquals(f.owner.load(), null);
    const gap = f.packets.at(-1)!;
    assert(gap.type === "gap");
    assertEquals(gap.reason, "retention");
    // Gap has captured a new inventory; let it expire before its next page.
    await f.step(300_000);
    const expired = f.packets.at(-1)!;
    assert(expired.type === "gap");
    assertEquals(expired.reason, "snapshot_expired");
  } finally {
    held.resolve({});
    f.close();
  }
});

Deno.test("log follower: undefined, partial and reused acknowledgements never advance cursor; restart abandons incomplete snapshot", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 129; i++) {
      Deno.writeTextFileSync(`${f.vault}/${i}.md`, "current");
    }
    f.hub.scanNow();
    let result: unknown;
    const follower = f.add({ deliver: () => Promise.resolve(result) });
    await f.step();
    assertEquals(f.owner.load(), null);
    const stale = f.packets[0].token;
    result = { ack: stale };
    await f.step(5000);
    assertEquals(f.owner.load(), null);
    result = { ack: f.packets.at(-1)!.token, seq: 129 };
    await f.step(10000);
    assertEquals(f.owner.load(), null);
    follower.stop();
    f.packets.length = 0;
    const partial = f.add();
    await f.step();
    await f.step();
    assertEquals(f.owner.load(), null);
    const reset = f.packets[0];
    assert(reset.type === "gap");
    partial.stop();
    f.packets.length = 0;
    f.add();
    await f.step();
    const restarted = f.packets[0];
    assert(restarted.type === "gap");
    assertEquals(restarted.reason, "first_subscription");
    assert(restarted.resetId !== reset.resetId);
    await f.step();
    await f.step();
    assertEquals(f.owner.load()?.seq, 129);
  } finally {
    f.close();
  }
});

Deno.test("log follower: transport queue rechecks SQLite names and snapshot membership at actual disclosure", async () => {
  const f = fixture();
  const queued = Promise.withResolvers<unknown>();
  let disclose: (() => ChangePacket) | undefined;
  try {
    const boot = f.add();
    await f.step();
    await f.step();
    boot.stop();
    f.write("queued-private-name.md");
    const follower = new LogFollower({
      hub: f.hub,
      cursor: f.owner,
      authorityKey: "all",
      current: () => true,
      clock: f.clock,
      deliver: (_packet, prepare) => {
        disclose = prepare;
        return queued.promise;
      },
    });
    try {
      await f.step();
      Deno.removeSync(`${f.vault}/queued-private-name.md`);
      f.hub.scanNow();
      const packet = disclose!();
      assert(packet.type === "changes");
      assertEquals(packet.to, 1);
      assertEquals(packet.entries[0].path, null);
      assert(!JSON.stringify(packet).includes("queued-private-name"));
      queued.resolve({ ack: packet.token });
      await f.step();
      assertEquals(f.owner.load()?.seq, 1);
    } finally {
      follower.stop();
    }
  } finally {
    queued.resolve({});
    f.close();
  }
});
