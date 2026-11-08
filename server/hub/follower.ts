// SPDX-License-Identifier: LGPL-3.0-only
import { type ObservedClock, processClock } from "../observed_time.ts";
import {
  acknowledge,
  CHANGE_LIMITS,
  type ChangePacket,
  checkPacket,
  encodedBytes,
  type GapReason,
  type SnapshotEntry,
} from "../plugins/change_contract.ts";
import { anonymousPath } from "./paths.ts";
import { driverTarget } from "./drivers/paths.ts";
import type { VaultHub } from "./hub.ts";
import type { PluginCursor } from "./store.ts";

export interface CursorOwner {
  load(): PluginCursor | null;
  commit(expected: PluginCursor | null, next: PluginCursor): boolean;
  reset?(expected: PluginCursor | null, next: PluginCursor): boolean;
}
export interface FollowerStatus {
  cursor: number | null;
  lag: number;
  reset: string | null;
  lastError: "changes_delivery_failed" | null;
}
export interface FollowerOptions {
  hub: VaultHub;
  cursor: CursorOwner;
  authorityKey: string;
  current(): boolean;
  /** Queued transports must call disclose immediately before sending to the owner. */
  deliver(packet: ChangePacket, disclose: () => ChangePacket): Promise<unknown>;
  changed?(status: FollowerStatus): void;
  clock?: ObservedClock;
}
interface Inventory {
  expected: PluginCursor | null;
  authorityKey: string;
  resetId: string;
  watermark: number;
  entries: SnapshotEntry[];
  offset: number;
  page: number;
  expires: number;
}

/** One dirty bit, one bounded delivery, one transient metadata inventory.
 * SQLite is always the replay source, never the live publication's names. */
export class LogFollower {
  readonly #clock: ObservedClock;
  readonly #unsubscribe: () => void;
  #timer?: () => void;
  #expiry?: () => void;
  #stopped = false;
  #busy = false;
  #dirty = true;
  #retry: number = CHANGE_LIMITS.retryMs;
  #error: FollowerStatus["lastError"] = null;
  #inventory: Inventory | null = null;
  #gap: { reason: GapReason; resetId: string } | null = null;

  constructor(private readonly options: FollowerOptions) {
    this.#clock = options.clock ?? processClock;
    // Subscribe before the first cursor/inventory read.
    this.#unsubscribe = options.hub.subscribe(() => this.wake());
    this.#schedule(0);
  }
  get status(): FollowerStatus {
    const seq = this.options.cursor.load()?.seq ?? null;
    return {
      cursor: seq,
      lag: Math.max(0, this.options.hub.sequence() - (seq ?? 0)),
      reset: this.#gap?.resetId ?? this.#inventory?.resetId ?? null,
      lastError: this.#error,
    };
  }
  wake(): void {
    if (this.#stopped) return;
    this.#dirty = true;
    if (!this.#busy && !this.#timer) this.#schedule(0);
  }
  stop(): void {
    this.#stopped = true;
    this.#timer?.();
    this.#expiry?.();
    this.#timer = this.#expiry = undefined;
    this.#inventory = null;
    this.#gap = null;
    this.#unsubscribe();
  }
  #current(): boolean {
    return !this.#stopped && this.options.current();
  }
  #schedule(ms: number): void {
    if (!this.#current()) return;
    this.#timer?.();
    this.#timer = this.#clock.deadline(ms, () => {
      this.#timer = undefined;
      void this.#step();
    });
  }
  #reset(reason: GapReason): void {
    this.#expiry?.();
    this.#expiry = undefined;
    this.#inventory = null;
    this.#gap = { reason, resetId: crypto.randomUUID() };
  }
  #reason(cursor: PluginCursor | null): GapReason | null {
    if (!cursor) return "first_subscription";
    if (cursor.logId !== this.options.hub.store.logId) return "log_replaced";
    if (cursor.authorityKey !== this.options.authorityKey) {
      return "authority_changed";
    }
    if (cursor.seq > this.options.hub.sequence()) return "future_cursor";
    if (
      this.options.hub.changesSince(cursor.seq, {
        maxEntries: 1,
        maxBytes: CHANGE_LIMITS.bytes,
      }).gap
    ) return "retention";
    return null;
  }
  #snapshot(
    resetId: string,
    expected: PluginCursor | null,
    authorityKey: string,
  ): void {
    const { hub } = this.options;
    // No await: the metadata inventory and watermark are one observation.
    const entries = hub.store.files().map((file) => ({
      path: file.diskPath,
      pathKey: anonymousPath(hub.store.secret, file.key),
      hash: file.hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      vector: file.vector,
      seq: file.seq,
    }));
    const watermark = hub.sequence();
    this.#inventory = {
      expected,
      authorityKey,
      resetId,
      watermark,
      entries,
      offset: 0,
      page: 0,
      expires: this.#clock.now() + CHANGE_LIMITS.snapshotMs,
    };
    this.#gap = null;
    this.#expiry = this.#clock.deadline(CHANGE_LIMITS.snapshotMs, () => {
      if (!this.#current() || this.#inventory?.resetId !== resetId) return;
      this.#reset("snapshot_expired");
      this.wake();
    });
  }
  #safe(name: string): boolean {
    try {
      driverTarget(this.options.hub, name);
      return true;
    } catch {
      return false;
    }
  }
  #authorityKey(): string {
    try {
      return this.options.authorityKey;
    } catch (error) {
      // Unavailable/narrow canonical grants cannot keep an obsolete inventory
      // alive until their next successful delivery or expiry.
      this.#reset("authority_changed");
      throw error;
    }
  }
  #disclose(packet: ChangePacket, authorityKey: string): ChangePacket {
    if (!this.#current()) throw new Error("follower retired");
    if (this.#authorityKey() !== authorityKey) {
      this.#reset("authority_changed");
      throw new Error("follower read authority changed while queued");
    }
    const { hub } = this.options;
    if (packet.type === "gap") return checkPacket(packet);
    if (packet.type === "snapshot") {
      if (
        this.#inventory?.resetId !== packet.resetId ||
        this.#clock.now() >= this.#inventory.expires ||
        hub.changesSince(packet.watermark, {
          maxEntries: 1,
          maxBytes: CHANGE_LIMITS.bytes,
        }).gap
      ) {
        throw new Error("snapshot no longer current");
      }
      return checkPacket({
        ...packet,
        entries: packet.entries.filter((entry) =>
          this.#safe(entry.path) && hub.fileState(entry.path)?.seq === entry.seq
        ),
      });
    }
    // Ordinary host FIFO wait is part of delivery. A delete while queued must
    // scrub even earlier creates before the Worker can observe their names.
    const replay = hub.changesSince(packet.from, {
      maxEntries: CHANGE_LIMITS.entries,
      maxBytes: CHANGE_LIMITS.bytes - 2048,
    });
    if (replay.gap) throw new Error("replay no longer retained");
    return checkPacket({
      ...packet,
      entries: replay.entries.filter((entry) =>
        entry.seq <= packet.to && (!entry.path || this.#safe(entry.path)) &&
        (!entry.oldPath || this.#safe(entry.oldPath))
      ),
    });
  }
  async #step(): Promise<void> {
    if (this.#busy || !this.#current()) return;
    this.#busy = true;
    this.#dirty = false;
    const { hub, cursor: owner } = this.options;
    const expected = this.#inventory ? this.#inventory.expected : owner.load();
    try {
      // authorityKey can be an owner getter: canonical grant roots may change
      // without a manifest edit. One delivery/reset never borrows new rights.
      const authorityKey = this.#authorityKey();
      if (this.#inventory) {
        if (this.#inventory.authorityKey !== authorityKey) {
          this.#reset("authority_changed");
        } else if (this.#clock.now() >= this.#inventory.expires) {
          this.#reset("snapshot_expired");
        } else if (
          hub.changesSince(this.#inventory.watermark, {
            maxEntries: 1,
            maxBytes: CHANGE_LIMITS.bytes,
          }).gap
        ) this.#reset("retention");
      } else if (!this.#gap) {
        const reason = this.#reason(expected);
        if (reason) this.#reset(reason);
      }
      let packet: ChangePacket;
      let snapshotOffset = 0;
      const token = crypto.randomUUID();
      const inventory = this.#inventory;
      const gap = this.#gap;
      if (gap) {
        packet = {
          type: "gap",
          gap: true,
          reason: gap.reason,
          resetId: gap.resetId,
          logId: hub.store.logId,
          next: hub.sequence(),
          token,
        };
      } else if (inventory) {
        const entries: SnapshotEntry[] = [];
        snapshotOffset = inventory.offset;
        while (
          snapshotOffset < inventory.entries.length &&
          entries.length < CHANGE_LIMITS.entries
        ) {
          const candidate = inventory.entries[snapshotOffset];
          // A later delete must not leak a captured plaintext name. Renames and
          // replacements are recovered through replay after the watermark.
          if (
            !this.#safe(candidate.path) ||
            hub.fileState(candidate.path)?.seq !== candidate.seq
          ) {
            snapshotOffset++;
            continue;
          }
          if (
            encodedBytes([...entries, candidate]) > CHANGE_LIMITS.bytes - 2048
          ) break;
          entries.push(candidate);
          snapshotOffset++;
        }
        if (!entries.length && snapshotOffset < inventory.entries.length) {
          throw new RangeError("snapshot member exceeds bound");
        }
        packet = {
          type: "snapshot",
          resetId: inventory.resetId,
          watermark: inventory.watermark,
          entries,
          page: inventory.page,
          complete: snapshotOffset === inventory.entries.length,
          token,
        };
      } else {
        const page = hub.changesSince(expected!.seq, {
          maxEntries: CHANGE_LIMITS.entries,
          maxBytes: CHANGE_LIMITS.bytes - 2048,
        });
        if (page.gap) {
          this.#reset("retention");
          this.#dirty = true;
          return;
        }
        if (!page.entries.length) return;
        const entries = page.entries.filter((entry) =>
          (!entry.path || this.#safe(entry.path)) &&
          (!entry.oldPath || this.#safe(entry.oldPath))
        );
        packet = {
          type: "changes",
          logId: hub.store.logId,
          from: expected!.seq,
          to: page.entries.at(-1)!.seq,
          entries,
          batches: page.batches!,
          token,
        };
      }
      const result = await this.options.deliver(
        checkPacket(packet),
        () => this.#disclose(packet, authorityKey),
      );
      // Retirement/expiry cannot borrow the replacement's cursor or inventory.
      if (
        !this.#current() || (inventory && this.#inventory !== inventory) ||
        (gap && this.#gap !== gap)
      ) return;
      if (this.#authorityKey() !== authorityKey) {
        this.#reset("authority_changed");
        this.#dirty = true;
        return;
      }
      if (!acknowledge(result, token)) {
        throw new Error("invalid acknowledgement");
      }
      if (
        inventory &&
        hub.changesSince(inventory.watermark, {
          maxEntries: 1,
          maxBytes: CHANGE_LIMITS.bytes,
        }).gap
      ) {
        this.#reset("retention");
        this.#dirty = true;
        return;
      }
      if (packet.type === "gap") {
        this.#snapshot(packet.resetId, expected, authorityKey);
      } else if (packet.type === "snapshot" && !packet.complete) {
        inventory!.offset = snapshotOffset;
        inventory!.page++;
      } else {
        const next: PluginCursor = {
          logId: hub.store.logId,
          authorityKey,
          seq: packet.type === "snapshot" ? packet.watermark : packet.to,
        };
        const committed = packet.type === "snapshot" && owner.reset
          ? owner.reset(expected, next)
          : owner.commit(expected, next);
        if (!committed) {
          throw new Error("cursor compare-and-swap failed");
        }
        if (packet.type === "snapshot") {
          this.#expiry?.();
          this.#expiry = undefined;
          this.#inventory = null;
        }
      }
      this.#retry = CHANGE_LIMITS.retryMs;
      this.#error = null;
      this.#dirty = true;
    } catch {
      if (!this.#current()) return;
      this.#error = "changes_delivery_failed";
      this.#schedule(this.#retry);
      this.#retry = Math.min(CHANGE_LIMITS.maxRetryMs, this.#retry * 2);
    } finally {
      this.#busy = false;
      if (this.#current()) {
        this.options.changed?.(this.status);
        if (this.#dirty && !this.#timer) this.#schedule(0);
      }
    }
  }
}
