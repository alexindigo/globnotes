// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import * as path from "@std/path";
import { anonymousPath, pathKey } from "./paths.ts";
import type {
  ChangeEntry,
  Conflict,
  FileState,
  Mutation,
  Peer,
  Vector,
} from "./types.ts";

export const CHANGE_LIMIT = 100_000;
export interface PluginCursor {
  logId: string;
  seq: number;
  authorityKey: string;
}
export interface ReplayOptions {
  maxEntries: number;
  maxBytes: number;
}
export interface BatchPart {
  batch: number;
  /** One-based entry offset within the original batch, stable after compaction. */
  part: number;
  complete: boolean;
}
export interface ReplayPage {
  gap: boolean;
  entries: ChangeEntry[];
  batches?: BatchPart[];
}
export function validCursor(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError("cursor must be a nonnegative safe integer");
  }
}
/** Runs synchronously within the file metadata transaction, before publication. */
export type PeerAcknowledgement = (entries: readonly ChangeEntry[]) => void;

/** Metadata only. Plaintext deletion scrubbing and version updates commit together. */
export class HubStore {
  readonly db: DatabaseSync;
  readonly secret: string;
  readonly logId: string;
  constructor(
    statePath: string,
    private readonly options: { changeLimit?: number } = {},
  ) {
    if (
      !Number.isSafeInteger(options.changeLimit ?? CHANGE_LIMIT) ||
      (options.changeLimit ?? CHANGE_LIMIT) < 1
    ) {
      throw new TypeError("changeLimit must be a positive integer");
    }
    Deno.mkdirSync(statePath, { recursive: true });
    this.db = new DatabaseSync(path.join(statePath, "hub.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        label TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(key TEXT PRIMARY KEY, disk_path TEXT NOT NULL,
        hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
        vector TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT, path_key TEXT NOT NULL, kind TEXT NOT NULL, old_path TEXT,
        old_path_key TEXT, before_hash TEXT, after_hash TEXT, peer TEXT NOT NULL,
        origin TEXT, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_path_key ON changes(path_key);
      CREATE INDEX IF NOT EXISTS changes_old_path_key ON changes(old_path_key);
      CREATE TABLE IF NOT EXISTS tombstones(path_key TEXT PRIMARY KEY, vector TEXT NOT NULL,
        deleted_at TEXT NOT NULL, seq INTEGER NOT NULL);`);
    const version = this.db.prepare(
      "SELECT value FROM meta WHERE key='schema_version'",
    ).get();
    if (
      version && !["1", "2", "3", "4", "5"].includes(version.value as string)
    ) {
      throw new Error("Unsupported hub schema");
    }
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY, path TEXT,
        path_key TEXT NOT NULL, copy_path TEXT, copy_path_key TEXT NOT NULL,
        peer TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, resolved_at TEXT, revision INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS conflicts_path_key ON conflicts(path_key);
      CREATE INDEX IF NOT EXISTS conflicts_copy_path_key ON conflicts(copy_path_key);
      INSERT OR IGNORE INTO meta VALUES ('conflict_revision','0');`);
    if (
      !this.db.prepare("PRAGMA table_info(conflicts)").all().some((r) =>
        r.name === "revision"
      )
    ) {
      this.db.exec(
        "ALTER TABLE conflicts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      );
    }
    for (
      const [table, name, definition] of [
        ["peers", "plugin", "TEXT"],
        ["peers", "settings", "TEXT NOT NULL DEFAULT '{}'"],
        ["peers", "enabled", "INTEGER NOT NULL DEFAULT 0"],
        ["peers", "revision", "INTEGER NOT NULL DEFAULT 1"],
        ["changes", "batch", "INTEGER"],
      ]
    ) {
      if (
        !this.db.prepare(`PRAGMA table_info(${table})`).all().some((r) =>
          r.name === name
        )
      ) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peer_sync(peer TEXT PRIMARY KEY,
        endpoint_id TEXT, endpoint_epoch TEXT, scope TEXT, cursor TEXT,
        export_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_files(peer TEXT NOT NULL, path_key TEXT NOT NULL,
        version TEXT, revision TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(peer,path_key));
      CREATE TABLE IF NOT EXISTS plugin_cursors(plugin TEXT PRIMARY KEY,
        log_id TEXT NOT NULL, seq INTEGER NOT NULL, authority_key TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_batch ON changes(COALESCE(batch,seq),seq);
    `);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('log_id',?)").run(
      crypto.randomUUID(),
    );
    this.db.exec(
      "INSERT OR REPLACE INTO meta VALUES ('schema_version','5'); COMMIT;",
    );
    this.logId = this.db.prepare("SELECT value FROM meta WHERE key='log_id'")
      .get()!.value as string;
    const secret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((v) => v.toString(16).padStart(2, "0")).join("");
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('path_secret',?)").run(
      secret,
    );
    this.secret = this.db.prepare(
      "SELECT value FROM meta WHERE key='path_secret'",
    ).get()!.value as string;
    const seed = this.db.prepare(
      "INSERT OR IGNORE INTO peers(id,kind,label,created_at) VALUES(?,?,?,?)",
    );
    seed.run("local", "local", "Local folder", new Date().toISOString());
    seed.run("globnotes", "driver", "globnotes", new Date().toISOString());
  }
  fileState(name: string): FileState | null {
    const row = this.db.prepare("SELECT * FROM files WHERE key=?").get(
      pathKey(name),
    );
    return row ? decodeFile(row) : null;
  }
  files(): FileState[] {
    return this.db.prepare("SELECT * FROM files ORDER BY key").all().map(
      decodeFile,
    );
  }
  /** Refresh stat hints without inventing a content change. */
  refresh(file: FileState): void {
    this.db.prepare("UPDATE files SET size=?,mtime_ms=? WHERE key=?")
      .run(file.size, file.mtimeMs, file.key);
  }
  apply(
    mutations: Mutation[],
    peer: Peer,
    origin: string | null,
    ack?: PeerAcknowledgement,
  ): ChangeEntry[] {
    const entries: ChangeEntry[] = [];
    let scrubbed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Resolve all member transitions from the pre-batch identities. In
      // particular, a swap/chain must not retarget the same member twice.
      const renamed = new Map(
        mutations.filter((m) => m.oldPath).map(
          (m) => [pathKey(m.oldPath!), m.path],
        ),
      );
      const deleted = new Set(
        mutations.filter((m) => !m.file && !m.oldPath).map((m) =>
          pathKey(m.path)
        ),
      );
      for (const conflict of this.conflicts()) {
        if (!conflict.path || !conflict.copyPath) continue;
        if (
          [conflict.path, conflict.copyPath].some((name) =>
            deleted.has(pathKey(name))
          )
        ) {
          this.db.prepare(
            `UPDATE conflicts SET path=NULL,copy_path=NULL,state='resolved',
            resolved_at=COALESCE(resolved_at,?),revision=revision+1 WHERE id=?`,
          )
            .run(new Date().toISOString(), conflict.id);
          this.#bumpConflicts();
          scrubbed = true;
        } else {
          const original = renamed.get(pathKey(conflict.path)) ?? conflict.path;
          const copy = renamed.get(pathKey(conflict.copyPath)) ??
            conflict.copyPath;
          if (original === conflict.path && copy === conflict.copyPath) {
            continue;
          }
          this.db.prepare(
            `UPDATE conflicts SET path=?,path_key=?,copy_path=?,copy_path_key=?,
            revision=revision+1 WHERE id=?`,
          ).run(
            original,
            anonymousPath(this.secret, original),
            copy,
            anonymousPath(this.secret, copy),
            conflict.id,
          );
          this.#bumpConflicts();
        }
      }
      for (const mutation of mutations) {
        const key = pathKey(mutation.path),
          keyed = anonymousPath(this.secret, key);
        const before = this.fileState(mutation.oldPath ?? key);
        if (!mutation.file && !before) continue;
        const tombstone = this.db.prepare(
          "SELECT vector FROM tombstones WHERE path_key=?",
        ).get(keyed);
        const vector: Vector = {
          ...(tombstone ? JSON.parse(tombstone.vector as string) : {}),
        };
        for (const [id, counter] of Object.entries(before?.vector ?? {})) {
          vector[id] = Math.max(vector[id] ?? 0, counter);
        }
        vector[peer] = (vector[peer] ?? 0) + 1;
        const entry: ChangeEntry = {
          seq: 0,
          batch: 0,
          path: mutation.path,
          pathKey: keyed,
          kind: mutation.oldPath
            ? "renamed"
            : !mutation.file
            ? "deleted"
            : before
            ? "modified"
            : "created",
          oldPath: mutation.oldPath ?? null,
          oldPathKey: mutation.oldPath
            ? anonymousPath(this.secret, mutation.oldPath)
            : null,
          beforeHash: before?.hash ?? null,
          afterHash: mutation.file?.hash ?? null,
          peer,
          origin,
          at: new Date().toISOString(),
        };
        entry.seq = Number(
          this.db.prepare(`INSERT INTO changes
          (path,path_key,kind,old_path,old_path_key,before_hash,after_hash,peer,origin,at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
            entry.path,
            keyed,
            entry.kind,
            entry.oldPath,
            entry.oldPathKey,
            entry.beforeHash,
            entry.afterHash,
            peer,
            origin,
            entry.at,
          ).lastInsertRowid,
        );
        entry.batch = entries[0]?.batch ?? entry.seq;
        this.db.prepare("UPDATE changes SET batch=? WHERE seq=?").run(
          entry.batch,
          entry.seq,
        );
        if (mutation.oldPath) {
          this.db.prepare("DELETE FROM files WHERE key=?").run(
            pathKey(mutation.oldPath),
          );
        }
        if (mutation.file) {
          const file = mutation.file;
          this.db.prepare("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)")
            .run(
              key,
              file.diskPath,
              file.hash,
              file.size,
              file.mtimeMs,
              JSON.stringify(vector),
              entry.seq,
            );
          this.db.prepare("DELETE FROM tombstones WHERE path_key=?").run(keyed);
        } else {
          this.db.prepare("DELETE FROM files WHERE key=?").run(key);
          this.db.prepare("INSERT OR REPLACE INTO tombstones VALUES(?,?,?,?)")
            .run(keyed, JSON.stringify(vector), entry.at, entry.seq);
          this.db.prepare("UPDATE changes SET path=NULL WHERE path_key=?").run(
            keyed,
          );
          this.db.prepare(
            "UPDATE changes SET old_path=NULL WHERE old_path_key=?",
          ).run(keyed);
          scrubbed = true;
        }
        // Transient committed notifications retain deleted names; persisted history does not.
        entries.push(entry);
      }
      ack?.(entries);
      this.db.exec(`DELETE FROM changes WHERE seq <=
        (SELECT seq FROM changes ORDER BY seq DESC LIMIT 1 OFFSET ${
        this.options.changeLimit ?? CHANGE_LIMIT
      })`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (scrubbed) this.checkpoint();
    return entries;
  }
  changesSince(cursor: number, options?: ReplayOptions): ReplayPage {
    validCursor(cursor);
    const oldest = this.db.prepare("SELECT MIN(seq) AS seq FROM changes").get()!
      .seq as number | null;
    if (oldest !== null && cursor < oldest - 1) {
      return { gap: true, entries: [] };
    }
    if (!options) {
      return {
        gap: false,
        entries: this.db.prepare(
          "SELECT * FROM changes WHERE seq>? ORDER BY seq",
        )
          .all(cursor).map(decodeChange),
      };
    }
    if (
      !Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 ||
      options.maxEntries > 128 || !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 256 || options.maxBytes > 1024 * 1024
    ) throw new TypeError("invalid replay bounds");
    // Keyset SQL bounds row materialization, independently of log retention.
    const candidates = this.db.prepare(
      "SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?",
    ).all(cursor, options.maxEntries + 1).map(decodeChange);
    let entries: ChangeEntry[] = [];
    const batches: BatchPart[] = [];
    const fits = (rows: ChangeEntry[], parts: BatchPart[]) =>
      new TextEncoder().encode(
        JSON.stringify({ gap: false, entries: rows, batches: parts }),
      )
        .length <= options.maxBytes;
    for (let at = 0; at < candidates.length;) {
      const batch = candidates[at].batch;
      const end = Number(
        this.db.prepare(
          "SELECT MAX(seq) AS seq FROM changes WHERE COALESCE(batch,seq)=?",
        ).get(batch)!.seq,
      );
      let until = at + 1;
      while (until < candidates.length && candidates[until].batch === batch) {
        until++;
      }
      const group = candidates.slice(at, until);
      const part = {
        batch,
        part: group[0].seq - batch + 1,
        complete: group.at(-1)!.seq === end,
      };
      if (
        entries.length + group.length <= options.maxEntries &&
        fits([...entries, ...group], [...batches, part])
      ) {
        entries.push(...group);
        batches.push(part);
        at = until;
        continue;
      }
      // Never split a batch to fill the tail of a preceding packet.
      if (entries.length) break;
      const split: ChangeEntry[] = [];
      for (const entry of group) {
        const nextPart = { ...part, complete: entry.seq === end };
        if (
          split.length === options.maxEntries ||
          !fits([...split, entry], [nextPart])
        ) break;
        split.push(entry);
      }
      if (!split.length) {
        throw new RangeError("hub change exceeds replay byte bound");
      }
      entries = split;
      batches.push({ ...part, complete: split.at(-1)!.seq === end });
      break;
    }
    return { gap: false, entries, batches };
  }
  pluginCursor(plugin: string): PluginCursor | null {
    const row = this.db.prepare("SELECT * FROM plugin_cursors WHERE plugin=?")
      .get(plugin);
    return row
      ? {
        logId: row.log_id as string,
        seq: row.seq as number,
        authorityKey: row.authority_key as string,
      }
      : null;
  }
  /** Host-only CAS. Handler tokens and generation are checked by the follower. */
  advancePluginCursor(
    plugin: string,
    expected: PluginCursor | null,
    next: PluginCursor,
  ): boolean {
    validCursor(next.seq);
    if (next.logId !== this.logId || next.seq > this.sequence()) return false;
    if (
      expected?.logId === next.logId &&
      expected.authorityKey === next.authorityKey && next.seq < expected.seq
    ) return false;
    if (!expected) {
      return Number(
        this.db.prepare(
          "INSERT OR IGNORE INTO plugin_cursors VALUES(?,?,?,?,?)",
        ).run(
          plugin,
          next.logId,
          next.seq,
          next.authorityKey,
          new Date().toISOString(),
        ).changes,
      ) === 1;
    }
    return Number(
      this.db.prepare(
        `UPDATE plugin_cursors SET log_id=?,seq=?,authority_key=?,updated_at=?
       WHERE plugin=? AND log_id=? AND seq=? AND authority_key=?`,
      ).run(
        next.logId,
        next.seq,
        next.authorityKey,
        new Date().toISOString(),
        plugin,
        expected.logId,
        expected.seq,
        expected.authorityKey,
      ).changes,
    ) === 1;
  }
  removePluginCursor(plugin: string): void {
    this.db.prepare("DELETE FROM plugin_cursors WHERE plugin=?").run(plugin);
  }
  pluginCursorOwners(): string[] {
    return this.db.prepare("SELECT plugin FROM plugin_cursors").all().map(
      (row) => row.plugin as string,
    );
  }
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  sequence(): number {
    return Number(
      this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'")
        .get()?.seq ?? 0,
    );
  }
  #bumpConflicts(): void {
    this.db.exec(
      "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='conflict_revision'",
    );
  }
  conflictRevision(): number {
    return Number(
      this.db.prepare("SELECT value FROM meta WHERE key='conflict_revision'")
        .get()!.value,
    );
  }
  conflict(id: string): Conflict | null {
    const row = this.db.prepare("SELECT * FROM conflicts WHERE id=?").get(id);
    return row ? decodeConflict(row) : null;
  }
  /** Conditional metadata-only closure (Keep both). Deletion scrubbing stays in apply. */
  closeConflict(id: string, revision: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        `UPDATE conflicts SET state='resolved',resolved_at=?,
        revision=revision+1 WHERE id=? AND revision=? AND state='open'`,
      )
        .run(new Date().toISOString(), id, revision);
      if (result.changes) this.#bumpConflicts();
      this.db.exec("COMMIT");
      return Number(result.changes) !== 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recordConflict(conflict: Omit<Conflict, "revision">): void {
    if (!conflict.path || !conflict.copyPath) {
      throw new Error("Conflict paths required");
    }
    const live = this.fileState(conflict.path)?.diskPath === conflict.path &&
      this.fileState(conflict.copyPath)?.diskPath === conflict.copyPath;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO conflicts VALUES(?,?,?,?,?,?,?,?,?,?,1)")
        .run(
          conflict.id,
          live ? conflict.path : null,
          anonymousPath(this.secret, conflict.path),
          live ? conflict.copyPath : null,
          anonymousPath(this.secret, conflict.copyPath),
          conflict.peer,
          conflict.reason,
          live ? conflict.state : "resolved",
          conflict.createdAt,
          live ? conflict.resolvedAt : new Date().toISOString(),
        );
      this.#bumpConflicts();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  conflicts(): Conflict[] {
    return this.db.prepare("SELECT * FROM conflicts ORDER BY created_at,id")
      .all().map(decodeConflict);
  }
  close(): void {
    this.db.close();
  }
}
function decodeChange(r: Record<string, unknown>): ChangeEntry {
  return {
    seq: r.seq as number,
    batch: (r.batch ?? r.seq) as number,
    path: r.path as string | null,
    pathKey: r.path_key as string,
    kind: r.kind as ChangeEntry["kind"],
    oldPath: r.old_path as string | null,
    oldPathKey: r.old_path_key as string | null,
    beforeHash: r.before_hash as string | null,
    afterHash: r.after_hash as string | null,
    peer: r.peer as Peer,
    origin: r.origin as string | null,
    at: r.at as string,
  };
}
function decodeConflict(r: Record<string, unknown>): Conflict {
  return {
    id: r.id as string,
    revision: r.revision as number,
    path: r.path as string | null,
    copyPath: r.copy_path as string | null,
    peer: r.peer as Conflict["peer"],
    reason: r.reason as string,
    state: r.state as Conflict["state"],
    createdAt: r.created_at as string,
    resolvedAt: r.resolved_at as string | null,
  };
}
function decodeFile(row: Record<string, unknown>): FileState {
  return {
    key: row.key as string,
    diskPath: row.disk_path as string,
    hash: row.hash as string,
    size: row.size as number,
    mtimeMs: row.mtime_ms as number,
    vector: JSON.parse(row.vector as string),
    seq: row.seq as number,
  };
}
