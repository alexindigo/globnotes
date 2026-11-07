// SPDX-License-Identifier: LGPL-3.0-only
import { createUuid } from "../../../shared/uuid.ts";
import { processClock } from "../../observed_time.ts";
import { AsyncLock } from "../../plugins/lifecycle.ts";
import { OperationError } from "../../plugins/errors.ts";
import type { NoteOperations } from "../../notes/operations.ts";
import {
  type DiscoveryPage,
  type Driver,
  DRIVER_LIMITS,
  type DriverCapabilities,
  DriverContractError,
  type DriverError,
  type Entry,
  type ExportItem,
} from "../../plugins/driver_contract.ts";
import type { VaultHub } from "../hub.ts";
import { versionOf } from "../merge.ts";
import type { ChangeEntry } from "../types.ts";
import { exportUnits, planExport, type PlannedExport } from "./exporter.ts";
import { type DriverImport, snapshotAbsences } from "./importer.ts";
import { driverTarget } from "./paths.ts";
import {
  type DriverInstance,
  DriverPeers,
  type PeerFileState,
  PeerRevisionConflict,
} from "./peers.ts";

export interface DriverAttention {
  revision: number;
  held: { path: string }[];
  remoteEmpty: { files: { path: string; version: string }[] } | null;
  issues: { path?: string; code: string; reason: string }[];
  notices: string[];
}
export interface DriverSessionView {
  status: "starting" | "active" | "locked" | "failed" | "paused";
  reason: string | null;
  error: DriverError | null;
  lastSync: string | null;
  attention: DriverAttention;
}
export interface SessionAdapters {
  hub: VaultHub;
  operations: Pick<NoteOperations, "applyDriverImport">;
  driver: Driver;
  current(): boolean;
  writable(): boolean;
  redact(text: string): string;
  changed(): void;
}
export type DriverDecision = {
  instanceRevision: number;
  attentionRevision: number;
  action:
    | "held_restore"
    | "held_delete"
    | "remote_empty_delete"
    | "remote_empty_upload";
  paths?: string[];
};
class CycleFailure extends Error {
  constructor(readonly detail: DriverError) {
    super(detail.code);
  }
}

/** One instance's host-driven reconciliation. Metadata can survive the call;
 * bytes/base text cannot. The supervisor owns scheduling and Worker lifetimes. */
export class DriverSession {
  readonly peers: DriverPeers;
  readonly #names = new Map<string, { path: string; batch: number }>();
  readonly #issues = new Map<
    string,
    { path?: string; code: string; reason: string }
  >();
  readonly #notices = new Set<string>();
  readonly #blocked = new Set<string>();
  readonly #activity = new AsyncLock();
  #attentionStamp = "";
  #readLocked = false;
  #view: DriverSessionView = {
    status: "starting",
    reason: null,
    error: null,
    lastSync: null,
    attention: {
      revision: 0,
      held: [],
      remoteEmpty: null,
      issues: [],
      notices: [],
    },
  };
  #opened: Awaited<ReturnType<Driver["open"]>> | null = null;
  #snapshot = true;
  #running: Promise<void> | null = null;
  #full = false;
  #export = false;
  #retired = false;
  #empty: { path: string; version: string }[] | null = null;
  #sameIdentity = false;
  #sameScope = false;

  constructor(
    readonly instance: DriverInstance,
    readonly capabilities: DriverCapabilities,
    readonly adapters: SessionAdapters,
  ) {
    this.peers = new DriverPeers(adapters.hub.store);
    for (const file of adapters.hub.store.files()) {
      this.#names.set(this.peers.key(file.diskPath), {
        path: file.diskPath,
        batch: file.seq,
      });
    }
    // Persisted retry obligations survive restart, observed-clock coordinates do
    // not. A new generation re-observes them before trying any uncertain send.
    for (const row of this.peers.files(instance.id)) {
      if (row.nextAt) this.peers.setFile(instance.id, { ...row, nextAt: 0 });
    }
    this.#attention();
  }
  snapshot(): DriverSessionView {
    return structuredClone(this.#view);
  }
  retire(): void {
    this.#retired = true;
    this.#full = this.#export = false;
  }
  settle(): Promise<void> {
    return this.#activity.run(() => undefined);
  }
  observe(entries: readonly ChangeEntry[]): void {
    for (const entry of entries) {
      if (entry.path) {
        this.#names.set(entry.pathKey, {
          path: entry.path,
          batch: entry.batch,
        });
      }
      if (entry.oldPath && entry.oldPathKey) {
        this.#names.set(entry.oldPathKey, {
          path: entry.oldPath,
          batch: entry.batch,
        });
      }
    }
  }
  #assert = (): void => {
    if (
      this.#retired || !this.adapters.current() ||
      this.peers.instance(this.instance.id)?.revision !== this.instance.revision
    ) throw new PeerRevisionConflict();
    if (!this.adapters.writable()) throw new Error("read-only vault");
  };
  #set(
    status: DriverSessionView["status"],
    reason: string | null = null,
    error: DriverError | null = null,
  ): void {
    this.#view = { ...this.#view, status, reason, error };
    this.#attention();
    this.adapters.changed();
  }
  #attention(): void {
    const heldRows = this.peers.files(this.instance.id).filter((row) =>
      row.state === "held"
    );
    const held = heldRows.flatMap((row) => {
      const path = this.#names.get(row.pathKey)?.path;
      return path ? [{ path }] : [];
    }).sort((a, b) => a.path.localeCompare(b.path));
    const attention = {
      held,
      remoteEmpty: this.#empty ? { files: this.#empty } : null,
      issues: [...this.#issues.values()],
      notices: [...this.#notices],
    };
    const stamp = JSON.stringify({
      attention,
      heldRows,
      binding: this.peers.sync(this.instance.id).endpointEpoch,
    });
    if (stamp !== this.#attentionStamp) {
      this.#attentionStamp = stamp;
      this.#view.attention = {
        revision: this.peers.nextAttentionRevision(),
        ...attention,
      };
    }
  }
  #issue(path: string | undefined, code: string, reason = code): void {
    this.#issues.set(path ?? code, {
      ...(path ? { path } : {}),
      code,
      reason: this.adapters.redact(reason),
    });
  }
  #mark(
    path: string,
    state: PeerFileState,
    revision: string | null,
    version?: string | null,
  ): void {
    const old = this.peers.file(this.instance.id, path);
    this.peers.acknowledge(
      this.instance.id,
      path,
      version === undefined ? old?.version ?? null : version,
      revision,
      state,
    );
  }
  /** Coalesce simultaneous requests; full discovery dominates an export hint.
   * The returned promise accounts for every request admitted before it settles. */
  run(full = true): Promise<void> {
    if (this.#retired) return Promise.resolve();
    if (full) this.#full = true;
    else this.#export = true;
    if (this.#running) return this.#running;
    this.#running = this.#activity.run(async () => {
      try {
        while (!this.#retired && (this.#full || this.#export)) {
          const discover = this.#full;
          this.#full = this.#export = false;
          await this.#cycle(discover);
        }
      } finally {
        this.#running = null;
      }
    });
    return this.#running;
  }
  async #cycle(discover: boolean): Promise<void> {
    try {
      this.#assert();
      if (!this.#opened) {
        this.#set("starting");
        const opened = await this.adapters.driver.open();
        this.#assert();
        this.#opened = opened;
        if (opened.state === "ready") {
          const binding = this.peers.bind(
            this.instance.id,
            opened.endpoint,
            opened.scope,
          );
          this.#sameIdentity = !binding.rebootstrap;
          this.#sameScope = !binding.scopeChanged;
        }
      }
      if (this.#opened.state === "locked") {
        this.#set("locked", this.adapters.redact(this.#opened.reason));
        return;
      }
      if (this.#opened.state === "failed") {
        throw new CycleFailure(this.#opened.error);
      }
      const safe = discover || this.#snapshot ? await this.#discover() : true;
      if (!safe) return;
      await this.#send();
      this.#assert();
      this.#view.lastSync = new Date().toISOString();
      this.#set("active");
    } catch (error) {
      if (this.#retired || !this.adapters.current()) return;
      if (!this.adapters.writable()) this.#set("paused", "read-only vault");
      else {
        const detail: DriverError = error instanceof CycleFailure
          ? error.detail
          : {
            code: "internal",
            message: error instanceof DriverContractError
              ? "driver_contract_violation"
              : "driver_cycle_failed",
          };
        this.#set("failed", detail.code, {
          ...detail,
          ...(detail.message
            ? { message: this.adapters.redact(detail.message) }
            : {}),
        });
      }
    }
  }
  async #discover(): Promise<boolean> {
    this.#blocked.clear();
    this.#readLocked = false;
    const hub = this.adapters.hub, peer = this.instance.id;
    const rows = this.peers.files(peer);
    const mode = this.#snapshot || !this.capabilities.discovery.delta ||
        rows.some((row) =>
          row.state === "held" || row.state === "delete-pending"
        )
      ? "snapshot"
      : "delta";
    let cursor = mode === "delta"
      ? this.peers.sync(peer).cursor ?? undefined
      : undefined;
    const pages: DiscoveryPage[] = [],
      seen = new Set<string>(),
      known = new Set<string>(),
      cursors = new Set<string>();
    let uncertain = false, locked: string | null = null;
    for (;;) {
      const page = await this.adapters.driver.discover({
        mode,
        ...(cursor ? { cursor } : {}),
      });
      this.#assert();
      pages.push(page);
      // The real Worker validates every page. Keep cross-page consistency here.
      if (
        page.mode !== mode || this.#opened?.state !== "ready" ||
        page.endpoint.id !== this.#opened.endpoint.id ||
        page.endpoint.epoch !== this.#opened.endpoint.epoch ||
        page.scope !== this.#opened.scope
      ) throw new DriverContractError();
      for (const entry of page.entries) {
        if (entry.state === "unknown" || entry.state === "locked") {
          uncertain = true;
          if (entry.state === "locked") locked = entry.reason;
        }
        if (!entry.path) continue;
        const key = this.peers.key(entry.path);
        if (seen.has(key)) throw new DriverContractError();
        seen.add(key);
        this.#names.set(key, { path: entry.path, batch: hub.sequence() || 1 });
        if (entry.state === "known") known.add(key);
      }
      if (page.completion !== "more") break;
      if (!page.cursor || cursors.has(page.cursor)) {
        throw new DriverContractError();
      }
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
    // Discover all metadata before materialization: a later locked page cannot
    // turn earlier pages into permission to import/export or infer absence.
    if (locked) {
      this.#set("locked", this.adapters.redact(locked));
      return false;
    }
    const complete = pages.at(-1)!.completion === "complete";
    if (!complete) uncertain = true;
    let dispositionsComplete = true;
    for (const page of pages) {
      if (!await this.#importPage(page)) dispositionsComplete = false;
      if (this.#readLocked) return false;
      this.#assert();
    }
    uncertain ||= !dispositionsComplete;
    if (mode === "snapshot") {
      const absences = snapshotAbsences({
        complete,
        uncertain,
        sameIdentity: this.#sameIdentity,
        sameScope: this.#sameScope,
        seen,
        known,
      }, rows);
      if (absences.remoteEmpty) {
        this.#empty = rows.filter((row) => row.state === "synced").flatMap(
          (row) => {
            const file = hub.store.files().find((file) =>
              this.peers.key(file.diskPath) === row.pathKey
            );
            return file && file.hash === row.version
              ? [{ path: file.diskPath, version: file.hash }]
              : [];
          },
        );
        this.#set("active", "remote_empty");
        return false;
      }
      if (complete && !uncertain) this.#empty = null;
      const removals = absences.keys.flatMap((key) => {
        const name = this.#names.get(key)?.path;
        if (!name) {
          this.peers.drop(peer, key);
          return [];
        }
        return [{
          path: name,
          revision: null,
          expectedVersion: hub.fileState(name)?.hash ?? null,
        }];
      });
      for (
        let start = 0;
        start < removals.length;
        start += DRIVER_LIMITS.unitFiles
      ) {
        const result = await this.adapters.operations.applyDriverImport(
          peer,
          removals.slice(start, start + DRIVER_LIMITS.unitFiles),
          this.#assert,
        );
        if (result.some((item) => item.status === "replan")) uncertain = true;
      }
      // A confirmed missing uncertain object can be recreated, not blindly
      // replayed: the new create retains its endpoint-absent condition.
      if (complete && !uncertain) {
        for (const row of rows) {
          if (row.state === "uncertain" && !seen.has(row.pathKey)) {
            this.peers.drop(peer, row.pathKey);
          }
        }
      }
      this.#sameIdentity = this.#sameScope = true;
    }
    this.#snapshot = !complete || uncertain;
    if (uncertain) {
      this.#set("failed", "discovery_incomplete", {
        code: "offline",
        message: "Endpoint discovery is incomplete",
      });
      return false;
    }
    this.peers.setSync(peer, {
      ...this.peers.sync(peer),
      cursor: pages.at(-1)!.cursor ?? null,
    });
    return true;
  }
  async #importPage(page: DiscoveryPage): Promise<boolean> {
    const hub = this.adapters.hub, peer = this.instance.id;
    const candidates: Entry[] = [];
    let complete = true;
    for (const entry of page.entries) {
      if (entry.state === "unknown") {
        complete = false;
        this.#issue(entry.path, "unknown", entry.reason);
        continue;
      }
      if (entry.state === "locked") return false;
      try {
        driverTarget(hub, entry.path);
      } catch (error) {
        this.#blocked.add(this.peers.key(entry.path));
        this.#mark(
          entry.path,
          "unsupported",
          entry.state === "known" ? entry.revision : null,
        );
        this.#issue(
          entry.path,
          "invalid",
          error instanceof TypeError ? error.message : "invalid_path",
        );
        continue;
      }
      const mapping = this.peers.file(peer, entry.path);
      if (entry.state === "excluded") {
        this.#mark(entry.path, "excluded", mapping?.revision ?? null);
        continue;
      }
      if (entry.state === "known") {
        if ((entry.size ?? 0) > DRIVER_LIMITS.bodyBytes) {
          this.#blocked.add(this.peers.key(entry.path));
          this.#mark(entry.path, "unsupported", entry.revision);
          this.#issue(entry.path, "unsupported", "too_large");
          continue;
        }
        if (
          mapping?.revision === entry.revision &&
          mapping.state !== "uncertain" &&
          !(mapping.state === "held" && hub.fileState(entry.path))
        ) continue;
        if (mapping?.state === "unsupported" || mapping?.state === "excluded") {
          this.peers.drop(peer, mapping.pathKey);
        }
      }
      candidates.push(entry);
    }
    // A page is a native unit unless the documented file/byte bound splits it.
    // Any unknown observation in it leaves the entire unit unmaterialized.
    if (!complete) return false;
    let members: DriverImport[] = [], bytes = 0;
    const flush = async () => {
      if (!members.length) return;
      const result = await this.adapters.operations.applyDriverImport(
        peer,
        members,
        this.#assert,
      );
      this.#assert();
      for (const item of result) {
        if (item.status === "replan") complete = false;
        else if (
          !["unchanged", "adopt", "held", "drop", "write", "delete", "conflict"]
            .includes(item.status)
        ) this.#issue(item.path, "invalid", item.status);
      }
      members = [];
      bytes = 0;
    };
    for (const entry of candidates) {
      if (!entry.path) continue;
      if (members.length === DRIVER_LIMITS.unitFiles) {
        this.#notices.add("group_split");
        await flush();
      }
      const expectedVersion = hub.fileState(entry.path)?.hash ?? null;
      if (entry.state === "absent") {
        members.push({ path: entry.path, revision: null, expectedVersion });
        continue;
      }
      if (entry.state !== "known") continue;
      // Reserve room for the largest legal read before acquiring it; a driver
      // may not have advertised a size, or that size may already be stale.
      if (
        members.length &&
        bytes + DRIVER_LIMITS.bodyBytes > DRIVER_LIMITS.unitBytes
      ) {
        this.#notices.add("group_split");
        await flush();
      }
      const result = await this.adapters.driver.read({
        path: entry.path,
        revision: entry.revision,
      });
      this.#assert();
      if (result.state !== "known" || result.revision !== entry.revision) {
        if (result.state === "locked") {
          this.#readLocked = true;
          this.#set("locked", this.adapters.redact(result.reason));
        } else {this.#issue(
            entry.path,
            "unknown",
            result.state === "unknown" ? result.reason : "revision_changed",
          );}
        return false;
      }
      if (bytes + result.bytes.byteLength > DRIVER_LIMITS.unitBytes) {
        this.#notices.add("group_split");
        await flush();
      }
      const mapping = this.peers.file(peer, entry.path);
      if (mapping?.state === "uncertain") {
        const hash = versionOf(result.bytes);
        if (hash === mapping.version || entry.revision === mapping.revision) {
          this.peers.acknowledge(peer, entry.path, hash, entry.revision);
          continue;
        }
        // The sent version is not a proven remote base. Preserve divergence as
        // a conflict rather than treating an unconfirmed send as accepted.
        this.peers.setFile(peer, {
          ...mapping,
          version: null,
          state: "pending",
        });
      }
      this.#issues.delete(entry.path);
      members.push({
        path: entry.path,
        revision: entry.revision,
        bytes: result.bytes,
        baseText: result.baseText,
        expectedVersion,
      });
      bytes += result.bytes.byteLength;
    }
    await flush();
    return complete;
  }
  async #send(): Promise<void> {
    this.#assert();
    if (this.#empty) return;
    const peer = this.instance.id,
      hub = this.adapters.hub,
      sync = this.peers.sync(peer);
    const considered = hub.sequence();
    const changes = hub.changesSince(sync.exportSeq);
    this.observe(changes.entries);
    const files = hub.store.files(),
      live = new Map(
        files.map((file) => [this.peers.key(file.diskPath), file]),
      );
    const keys = new Map<string, number>();
    for (const change of changes.entries) {
      keys.set(change.pathKey, change.batch);
      if (change.oldPathKey) keys.set(change.oldPathKey, change.batch);
    }
    if (!sync.exportSeq || changes.gap) {
      for (const file of files) {
        keys.set(this.peers.key(file.diskPath), this.#batch(file.seq));
      }
    }
    for (const row of this.peers.files(peer)) {
      // Imports can acknowledge different endpoint bytes without changing the
      // original hub path (a conflict copy or uncertain-send read-back). Its
      // mismatch is still an obligation even if export_seq passed that path.
      if (
        !live.has(row.pathKey) || live.get(row.pathKey)?.hash !== row.version ||
        ["pending", "uncertain", "delete-pending"].includes(row.state)
      ) {
        keys.set(
          row.pathKey,
          keys.get(row.pathKey) ?? this.#names.get(row.pathKey)?.batch ??
            (hub.sequence() || 1),
        );
      }
      const file = live.get(row.pathKey);
      if (
        row.state === "unsupported" && file && row.version !== file.hash &&
        !this.#blocked.has(row.pathKey)
      ) this.peers.setFile(peer, { ...row, state: "pending", nextAt: 0 });
    }
    const planned: PlannedExport[] = [];
    for (const [key, batch] of keys) {
      if (this.#blocked.has(key)) continue;
      const file = live.get(key) ?? null,
        mapping = this.peers.fileByKey(peer, key);
      const result = planExport({
        pathKey: key,
        path: this.#names.get(key)?.path,
        file,
        mapping,
        batch,
        now: processClock.now(),
      });
      if (!file && mapping?.state === "pending" && !mapping.revision) {
        this.peers.drop(peer, key);
        continue;
      }
      if (result.kind === "delete-pending" && mapping) {
        this.peers.setFile(peer, { ...mapping, state: "delete-pending" });
        this.#snapshot = true;
      } else if (result.kind === "too_large" && file) {
        this.#mark(
          file.diskPath,
          "unsupported",
          mapping?.revision ?? null,
          file.hash,
        );
        this.#issue(file.diskPath, "unsupported", "too_large");
      } else if (result.kind === "send") planned.push(result.item);
    }
    let failure: DriverError | null = null;
    const batchSizes = new Map<number, number>();
    for (const item of planned) {
      batchSizes.set(item.batch, (batchSizes.get(item.batch) ?? 0) + 1);
    }
    if (
      [...batchSizes.values()].some((size) =>
        size > this.capabilities.limits.maxBatch
      )
    ) this.#notices.add("group_split");
    for (
      const unit of exportUnits(planned, this.capabilities.limits.maxBatch)
    ) {
      let packet: { planned: PlannedExport; wire: ExportItem }[] = [],
        total = 0;
      const flush = async () => {
        if (!packet.length) return;
        this.#assert();
        const captured = packet;
        packet = [];
        total = 0;
        // A crash after dispatch must re-observe, not blindly replay a send.
        for (const { planned, wire } of captured) {
          this.#mark(
            planned.path,
            "uncertain",
            "revision" in wire.base ? wire.base.revision : null,
            planned.version,
          );
        }
        const results = await this.adapters.driver.apply(
          captured.map(({ wire }) => wire),
        );
        this.#assert();
        for (const result of results) {
          const sent = captured.find(({ wire }) => wire.id === result.id)!;
          if (result.state === "settled") {
            this.#issues.delete(sent.planned.path);
            if (sent.wire.op === "delete") {
              this.peers.drop(
                peer,
                sent.planned.pathKey,
              );
            } else {this.peers.acknowledge(
                peer,
                sent.planned.path,
                sent.planned.version,
                result.revision!,
              );}
          } else if (result.state === "uncertain") this.#snapshot = true;
          else if (
            result.state === "excluded" || result.state === "unsupported"
          ) {
            this.#mark(
              sent.planned.path,
              result.state,
              "revision" in sent.wire.base ? sent.wire.base.revision : null,
              sent.planned.version,
            );
            if (result.state === "unsupported") {
              this.#issue(
                sent.planned.path,
                "unsupported",
                result.reason,
              );
            }
          } else {
            // Restore the pre-send mapping; only a settled receipt acknowledges
            // the sent version. Backoff is kept with the obligation.
            const old = prior.get(sent.planned.pathKey);
            const attempts = (old?.attempts ?? 0) + 1;
            const retry = result.state === "failed"
              ? result.error.retryAfterMs ?? 0
              : 0;
            this.peers.setFile(peer, {
              pathKey: sent.planned.pathKey,
              version: old?.version ?? null,
              revision: old?.revision ?? null,
              state: "pending",
              attempts,
              nextAt: result.state === "conflict" ? 0 : processClock.now() +
                Math.max(
                  Math.min(5000 * 2 ** (attempts - 1), 300_000),
                  retry,
                ),
            });
            this.#snapshot = true;
            if (result.state === "failed") {
              failure = result.error;
              this.#issue(
                sent.planned.path,
                result.error.code,
                result.error.message ?? result.error.code,
              );
            }
          }
        }
      };
      const prior = new Map(
        unit.map((
          item,
        ) => [item.pathKey, this.peers.fileByKey(peer, item.pathKey)]),
      );
      const deferred = new Set<number>();
      const defer = (item: PlannedExport, reason: string) => {
        deferred.add(item.batch);
        packet = packet.filter((entry) => entry.planned.batch !== item.batch);
        total = packet.reduce(
          (sum, entry) => sum + (entry.wire.bytes?.byteLength ?? 0),
          0,
        );
        for (
          const member of unit.filter((member) => member.batch === item.batch)
        ) {
          const old = prior.get(member.pathKey);
          this.#mark(
            member.path,
            "pending",
            old?.revision ?? null,
            old?.version ?? null,
          );
        }
        this.#issue(item.path, "unknown", reason);
      };
      for (const item of unit) {
        if (deferred.has(item.batch)) continue;
        let body: Uint8Array | undefined;
        if (item.op === "put") {
          try {
            body = Deno.readFileSync(driverTarget(hub, item.path));
          } catch {
            defer(item, "outgoing_file_unavailable");
            continue;
          }
          if (versionOf(body) !== item.version) {
            hub.scanNow([item.path]);
            defer(item, "outgoing_file_changed");
            continue;
          }
        }
        if (total + (body?.byteLength ?? 0) > DRIVER_LIMITS.bodyBytes) {
          this.#notices.add("group_split");
          await flush();
        }
        packet.push({
          planned: item,
          wire: {
            id: createUuid(),
            op: item.op,
            path: item.path,
            batch: item.batch,
            base: item.base,
            ...(body ? { bytes: body } : {}),
          },
        });
        total += body?.byteLength ?? 0;
      }
      await flush();
    }
    this.peers.setSync(peer, {
      ...this.peers.sync(peer),
      exportSeq: considered,
    });
    if (failure) throw new CycleFailure(failure);
  }
  #batch(seq: number): number {
    const row = this.adapters.hub.store.db.prepare(
      "SELECT COALESCE(batch,seq) AS batch FROM changes WHERE seq=?",
    ).get(seq);
    return (row?.batch as number | undefined) ??
      (this.adapters.hub.sequence() || 1);
  }
  decide(
    input: DriverDecision,
    assertAuthority: () => void = () => {},
  ): Promise<void> {
    const captured = structuredClone(input);
    return this.#activity.run(() => this.#decide(captured, assertAuthority));
  }
  async #decide(
    input: DriverDecision,
    assertAuthority: () => void,
  ): Promise<void> {
    this.#assert();
    const assertDecision = () => {
      assertAuthority();
      this.#assert();
      if (
        input.instanceRevision !== this.instance.revision ||
        input.attentionRevision !== this.#view.attention.revision
      ) throw new PeerRevisionConflict();
    };
    assertDecision();
    // Decisions use fresh endpoint observations, never a cached empty listing
    // or bytes from a previous cycle. Stable attention retains its revision.
    this.#snapshot = true;
    await this.#cycle(true);
    if (this.#view.status !== "active") throw new PeerRevisionConflict();
    assertDecision();
    const peer = this.instance.id, hub = this.adapters.hub;
    const completed: string[] = [];
    const apply = async (members: DriverImport[]) => {
      const results = await this.adapters.operations.applyDriverImport(
        peer,
        members,
        assertDecision,
      );
      completed.push(
        ...results.flatMap((item) =>
          item.status === "conflict"
            ? [item.copyPath!]
            : ["write", "delete"].includes(item.status)
            ? [item.path]
            : []
        ),
      );
      if (results.some((item) => item.status === "replan")) {
        throw new PeerRevisionConflict();
      }
    };
    try {
      if (input.action.startsWith("remote_empty")) {
        if (!this.#empty || input.paths !== undefined) {
          throw new PeerRevisionConflict();
        }
        const members = this.#empty.map((file) => ({
          path: file.path,
          revision: null,
          expectedVersion: file.version,
        }));
        if (input.action === "remote_empty_upload") {
          for (const member of members) {
            this.peers.drop(peer, this.peers.key(member.path));
          }
        } else {for (
            let start = 0;
            start < members.length;
            start += DRIVER_LIMITS.unitFiles
          ) {
            await apply(members.slice(start, start + DRIVER_LIMITS.unitFiles));
          }}
        // The fresh complete pass proved every old remote mapping absent. Locally
        // modified files survive the deletion choice and are recreated remotely.
        for (const row of this.peers.files(peer)) {
          if (row.state === "synced") this.peers.drop(peer, row.pathKey);
        }
        this.peers.setSync(peer, { ...this.peers.sync(peer), exportSeq: 0 });
        this.#empty = null;
      } else {
        const held = this.#view.attention.held.map(({ path }) => path);
        const selected = input.paths ?? held;
        if (
          !selected.length || new Set(selected).size !== selected.length ||
          selected.some((path) => !held.includes(path))
        ) throw new PeerRevisionConflict();
        if (input.action === "held_delete") {
          for (const path of selected) {
            const row = this.peers.file(peer, path)!;
            this.peers.setFile(peer, {
              ...row,
              state: "delete-pending",
              nextAt: 0,
            });
          }
        } else {
          let unit: DriverImport[] = [], bytes = 0;
          for (const path of selected) {
            if (
              unit.length &&
              (unit.length === DRIVER_LIMITS.unitFiles ||
                bytes + DRIVER_LIMITS.bodyBytes > DRIVER_LIMITS.unitBytes)
            ) {
              this.#notices.add("group_split");
              await apply(unit);
              unit = [];
              bytes = 0;
            }
            const row = this.peers.file(peer, path)!;
            const result = await this.adapters.driver.read({
              path,
              revision: row.revision!,
            });
            assertDecision();
            if (result.state !== "known" || result.revision !== row.revision) {
              throw new PeerRevisionConflict();
            }
            unit.push({
              path,
              revision: result.revision,
              bytes: result.bytes,
              expectedVersion: hub.fileState(path)?.hash ?? null,
              restore: true,
            });
            bytes += result.bytes.byteLength;
          }
          if (unit.length) await apply(unit);
        }
      }
    } catch (error) {
      this.#attention();
      this.adapters.changed();
      if (completed.length) {
        throw new OperationError(
          500,
          "operation_partial",
          "The sync decision completed only some files; read current state before another choice.",
          {
            partial: {
              completedPaths: [
                ...completed,
                ...(error instanceof OperationError
                  ? error.partial?.completedPaths ?? []
                  : []),
              ],
            },
          },
        );
      }
      throw error;
    }
    this.#attention();
    this.adapters.changed();
    await this.#cycle(false);
  }
}
