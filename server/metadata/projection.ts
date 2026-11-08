// SPDX-License-Identifier: LGPL-3.0-only
import { LogFollower } from "../hub/follower.ts";
import type { VaultHub } from "../hub/hub.ts";
import { anonymousPath } from "../hub/paths.ts";
import type { PluginCursor } from "../hub/store.ts";
import { driverTarget } from "../hub/drivers/paths.ts";
import { versionOf } from "../hub/merge.ts";
import type { ChangePacket } from "../plugins/change_contract.ts";
import {
  boundedRecord,
  METADATA_LIMITS,
  type MetadataRecord,
} from "./contracts.ts";
import { type ParsedMetadata, parseMetadata } from "./parse.ts";
import type { ObservedClock } from "../observed_time.ts";

class ReplanMetadata extends Error {}

async function readCurrent(path: string): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const info = await file.stat();
    if (!info.isFile) throw new Error("not a file");
    if (info.size > METADATA_LIMITS.body) throw new RangeError("too_large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = new Uint8Array(65536);
      const n = await file.read(chunk);
      if (n === null) break;
      size += n;
      if (size > METADATA_LIMITS.body) throw new RangeError("too_large");
      chunks.push(chunk.subarray(0, n));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    file.close();
  }
}

/** A vault-owned, memory-only current projection. Publication invalidates synchronously;
 * the shared follower performs all reads/parsing later, outside the writer stack. */
export class MetadataProjection {
  readonly #follower: LogFollower;
  readonly #unsubscribe: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #records = new Map<string, MetadataRecord>();
  readonly #staged = new Map<string, MetadataRecord>();
  #cursor: PluginCursor | null = null;
  #stopped = false;
  #revision = 0;
  readonly #identity = crypto.randomUUID();
  #reset: string | null = null;
  constructor(
    readonly hub: VaultHub,
    private readonly adapters: {
      read?(path: string): Promise<Uint8Array>;
      parse?(text: string): ParsedMetadata | Promise<ParsedMetadata>;
      clock?: ObservedClock;
    } = {},
  ) {
    this.#unsubscribe = hub.subscribe((entries) => {
      for (const entry of entries) {
        this.#records.delete(entry.pathKey);
        this.#staged.delete(entry.pathKey);
        if (entry.oldPathKey) {
          this.#records.delete(entry.oldPathKey);
          this.#staged.delete(entry.oldPathKey);
        }
      }
      this.#changed();
    });
    this.#follower = new LogFollower({
      hub,
      authorityKey: "metadata-v1",
      current: () => !this.#stopped,
      clock: adapters.clock,
      cursor: {
        load: () => this.#cursor,
        commit: (expected, next) => {
          if (this.#stopped || expected !== this.#cursor) return false;
          this.#cursor = next;
          this.#changed();
          return true;
        },
      },
      deliver: (_packet, disclose) => this.#consume(disclose()),
      changed: () => {
        if (!this.#stopped) this.#changed();
      },
    });
  }
  get revision(): string {
    return `${this.#identity}:${this.#revision}`;
  }
  get cursor(): number | null {
    return this.#cursor?.seq ?? null;
  }
  get catchingUp(): boolean {
    return this.#reset !== null || this.cursor === null ||
      this.cursor < this.hub.sequence() ||
      this.#follower.status.reset !== null ||
      this.#follower.status.lastError !== null;
  }
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
  #changed(): void {
    this.#revision++;
    for (const fn of this.#listeners) fn();
  }
  stop(): void {
    this.#stopped = true;
    this.#follower.stop();
    this.#unsubscribe();
    this.#listeners.clear();
    this.#records.clear();
    this.#staged.clear();
    this.#reset = null;
  }
  #base(path: string): Omit<MetadataRecord, "status"> | null {
    const file = this.hub.fileState(path);
    return file
      ? {
        path: file.diskPath,
        pathKey: anonymousPath(this.hub.store.secret, file.key),
        version: file.hash,
        seq: file.seq,
      }
      : null;
  }
  /** Only current/safe rows can leave the owner, even during recovery. */
  records(): MetadataRecord[] {
    if (this.#stopped) throw new Error("metadata projection stopped");
    const out: MetadataRecord[] = [];
    for (const file of this.hub.store.files()) {
      if (!file.diskPath.endsWith(".md")) continue;
      try {
        driverTarget(this.hub, file.diskPath);
      } catch {
        continue;
      }
      const base = this.#base(file.diskPath)!;
      const cached = this.#records.get(base.pathKey);
      out.push(
        cached?.seq === base.seq && cached.version === base.version ? cached : {
          ...base,
          status: "unavailable",
          reason: "reading",
        },
      );
    }
    return out;
  }
  async #parse(path: string): Promise<MetadataRecord | null> {
    if (!path.endsWith(".md")) return null;
    const base = this.#base(path);
    if (!base) return null;
    let reason: Extract<MetadataRecord, { status: "unavailable" }>["reason"] =
      "read_failed";
    let parsed: ParsedMetadata | undefined;
    try {
      const target = driverTarget(this.hub, path);
      if (this.hub.fileState(path)!.size > METADATA_LIMITS.body) {
        throw new RangeError("too_large");
      }
      const bytes = await (this.adapters.read ?? readCurrent)(target);
      if (this.#stopped) return null;
      driverTarget(this.hub, path);
      if (bytes.length > METADATA_LIMITS.body) {
        throw new RangeError("too_large");
      }
      if (versionOf(bytes) !== base.version) {
        this.hub.scanNow([path]);
        throw new ReplanMetadata("metadata version changed; re-plan");
      }
      reason = "invalid_utf8";
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      reason = "parse_failed";
      parsed = await (this.adapters.parse ?? parseMetadata)(source);
    } catch (error) {
      if (this.#stopped) return null;
      if (error instanceof ReplanMetadata) throw error;
      if (error instanceof Deno.errors.NotFound) {
        this.hub.scanNow([path]);
        if (this.hub.fileState(path)?.seq === base.seq) {
          throw new ReplanMetadata("metadata absence changed; re-plan");
        }
        return null;
      }
      if (error instanceof RangeError && error.message === "too_large") {
        reason = "too_large";
      }
    }
    if (this.#stopped || this.hub.fileState(path)?.seq !== base.seq) {
      return null;
    }
    try {
      driverTarget(this.hub, path);
    } catch {
      return null;
    }
    return boundedRecord(
      parsed
        ? { ...base, status: "ready", ...parsed }
        : { ...base, status: "unavailable", reason },
    );
  }
  async #consume(packet: ChangePacket): Promise<unknown> {
    if (packet.type === "gap") {
      this.#records.clear();
      this.#staged.clear();
      this.#reset = packet.resetId;
      this.#changed();
    } else {
      const names = packet.entries.map((entry) => entry.path).filter((
        p,
      ): p is string => !!p);
      // Sequential reads bound transient byte memory independently of group size.
      for (const name of new Set(names)) {
        const result = await this.#parse(name);
        if (this.#stopped) return { ack: packet.token };
        if (result) this.#staged.set(result.pathKey, result);
      }
      if (packet.type === "snapshot" ? packet.complete : true) {
        if (packet.type === "snapshot") this.#reset = null;
        if (
          packet.type === "snapshot" || packet.batches.every((b) => b.complete)
        ) {
          // No await across publication: every ready member of the group swaps together.
          for (const [key, record] of this.#staged) {
            if (this.hub.fileState(record.path)?.seq === record.seq) {
              this.#records.set(key, record);
            }
          }
          this.#staged.clear();
          this.#changed();
        }
      }
    }
    return { ack: packet.token };
  }
}
