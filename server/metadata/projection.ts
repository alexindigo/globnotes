// SPDX-License-Identifier: LGPL-3.0-only
import { LogFollower } from "../hub/follower.ts";
import type { VaultHub } from "../hub/hub.ts";
import { anonymousPath } from "../hub/paths.ts";
import type { PluginCursor } from "../hub/store.ts";
import { DriverPathIndex } from "../hub/drivers/paths.ts";
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
  readonly #unsubscribeNamespace: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #records = new Map<string, MetadataRecord>();
  readonly #staged = new Map<string, MetadataRecord>();
  readonly #paths: DriverPathIndex;
  readonly #safe = new Map<string, { seq: number; safe: boolean }>();
  #catalog: readonly MetadataRecord[] | null = null;
  #cursor: PluginCursor | null = null;
  #stopped = false;
  #revision = 0;
  #namespaceEpoch = 0;
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
    this.#paths = new DriverPathIndex(hub);
    this.#unsubscribeNamespace = hub.subscribeNamespace(
      (_hasFileEntries, structureChanged) => {
        this.#invalidateNamespace();
        if (structureChanged) {
          this.#namespaceEpoch++;
          this.#follower.wake();
        }
        this.#changed();
      },
    );
    this.#unsubscribe = hub.subscribe((entries) => {
      for (const entry of entries) {
        this.#records.delete(entry.pathKey);
        this.#staged.delete(entry.pathKey);
        if (entry.oldPathKey) {
          this.#records.delete(entry.oldPathKey);
          this.#staged.delete(entry.oldPathKey);
        }
      }
    });
    const authorityKey = () => this.#authorityKey();
    this.#follower = new LogFollower({
      hub,
      get authorityKey() {
        return authorityKey();
      },
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
      this.#cursor?.authorityKey !== this.#authorityKey() ||
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
  #authorityKey(): string {
    return `metadata-v1:${this.#namespaceEpoch}`;
  }
  #invalidateNamespace(): void {
    // One owner clears all namespace-derived caches, including directory-only
    // observations that have no file-log entry to invalidate a key.
    this.#paths.clear();
    this.#safe.clear();
    this.#catalog = null;
  }
  stop(): void {
    this.#stopped = true;
    this.#follower.stop();
    this.#unsubscribe();
    this.#unsubscribeNamespace();
    this.#listeners.clear();
    this.#records.clear();
    this.#staged.clear();
    this.#invalidateNamespace();
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
  #candidate(base: Omit<MetadataRecord, "status">): MetadataRecord {
    const cached = this.#records.get(base.pathKey);
    return cached?.seq === base.seq && cached.version === base.version
      ? cached
      : { ...base, status: "unavailable", reason: "reading" };
  }
  #knownSafe(base: Omit<MetadataRecord, "status">): boolean {
    const cached = this.#safe.get(base.pathKey);
    if (cached?.seq === base.seq) return cached.safe;
    let safe = true;
    try {
      this.#paths.target(base.path);
    } catch {
      safe = false;
    }
    this.#safe.set(base.pathKey, { seq: base.seq, safe });
    return safe;
  }
  /** Direct current-key lookup. A get never constructs the vault catalogue. */
  record(path: string): MetadataRecord | null {
    if (this.#stopped) throw new Error("metadata projection stopped");
    const base = this.#base(path);
    if (!base || !base.path.endsWith(".md")) return null;
    const record = this.#candidate(base);
    return this.disclose(record) ? record : null;
  }
  /** Recheck only disclosed routes. Collision inventory belongs to the current
   * publication, but symlink/type/state/seq checks remain fresh at dispatch. */
  disclose(record: MetadataRecord): boolean {
    if (this.#stopped) return false;
    const current = this.hub.fileState(record.path);
    if (
      !current || current.seq !== record.seq || current.hash !== record.version
    ) return false;
    try {
      this.#paths.target(record.path);
      if (this.#safe.get(record.pathKey)?.safe === false) {
        this.#safe.set(record.pathKey, { seq: record.seq, safe: true });
        this.#catalog = null;
        this.#changed();
      }
      return true;
    } catch {
      const changed = this.#safe.get(record.pathKey)?.safe !== false;
      this.#safe.set(record.pathKey, { seq: record.seq, safe: false });
      this.#catalog = null;
      if (changed) this.#changed();
      return false;
    }
  }
  /** Binary-search the NFC-sorted observed namespace before grant/filter work. */
  #window(prefix?: string): readonly MetadataRecord[] {
    const rows = this.#catalog!;
    if (!prefix) return rows;
    const key = prefix.normalize("NFC");
    const lower = (target: string) => {
      let low = 0, high = rows.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (rows[mid].path.normalize("NFC") < target) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    const exact = lower(key), from = lower(key + "/");
    let end = from;
    while (
      end < rows.length && rows[end].path.normalize("NFC").startsWith(key + "/")
    ) end++;
    return [
      ...(rows[exact]?.path.normalize("NFC") === key ? [rows[exact]] : []),
      ...rows.slice(from, end),
    ];
  }
  /** Safety/count candidates are cached per publication/seq, not rescanned on warm reads. */
  records(prefix?: string): readonly MetadataRecord[] {
    if (this.#stopped) throw new Error("metadata projection stopped");
    if (this.#catalog) return this.#window(prefix);
    const out: MetadataRecord[] = [];
    for (const file of this.hub.store.files()) {
      if (!file.diskPath.endsWith(".md")) continue;
      const base = {
        path: file.diskPath,
        pathKey: anonymousPath(this.hub.store.secret, file.key),
        version: file.hash,
        seq: file.seq,
      };
      if (this.#knownSafe(base)) out.push(this.#candidate(base));
    }
    this.#catalog = Object.freeze(
      out.sort((a, b) =>
        a.path.normalize("NFC") < b.path.normalize("NFC")
          ? -1
          : a.path.normalize("NFC") > b.path.normalize("NFC")
          ? 1
          : 0
      ),
    );
    return this.#window(prefix);
  }
  async #parse(path: string): Promise<MetadataRecord | null> {
    if (!path.endsWith(".md")) return null;
    const base = this.#base(path);
    if (!base) return null;
    let reason: Extract<MetadataRecord, { status: "unavailable" }>["reason"] =
      "read_failed";
    let parsed: ParsedMetadata | undefined;
    try {
      const target = this.#paths.target(path);
      if (this.hub.fileState(path)!.size > METADATA_LIMITS.body) {
        throw new RangeError("too_large");
      }
      const bytes = await (this.adapters.read ?? readCurrent)(target);
      if (this.#stopped) return null;
      this.#paths.target(path);
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
      this.#paths.target(path);
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
    const epoch = this.#namespaceEpoch;
    if (packet.type === "gap") {
      this.#records.clear();
      this.#staged.clear();
      this.#invalidateNamespace();
      this.#reset = packet.resetId;
      this.#changed();
    } else {
      const names = packet.entries.map((entry) => entry.path).filter((
        p,
      ): p is string => !!p);
      // Sequential reads bound transient byte memory independently of group size.
      for (const name of new Set(names)) {
        const result = await this.#parse(name);
        if (this.#stopped || epoch !== this.#namespaceEpoch) {
          return { ack: packet.token };
        }
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
          this.#catalog = null;
          this.#changed();
        }
      }
    }
    return { ack: packet.token };
  }
}
