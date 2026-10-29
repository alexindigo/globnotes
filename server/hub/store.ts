// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import * as path from "@std/path";
import { anonymousPath, pathKey } from "./paths.ts";
import type {
  ChangeEntry,
  FileState,
  Mutation,
  Peer,
  Vector,
} from "./types.ts";

export const CHANGE_LIMIT = 100_000;

/** Metadata only. Plaintext deletion scrubbing and version updates commit together. */
export class HubStore {
  readonly db: DatabaseSync;
  readonly secret: string;
  constructor(statePath: string) {
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
    if (version && version.value !== "1") {
      throw new Error("Unsupported hub schema");
    }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema_version','1')")
      .run();
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
  ): ChangeEntry[] {
    const entries: ChangeEntry[] = [];
    let scrubbed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
      this.db.exec(`DELETE FROM changes WHERE seq <=
        (SELECT seq FROM changes ORDER BY seq DESC LIMIT 1 OFFSET ${CHANGE_LIMIT})`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (scrubbed) this.checkpoint();
    return entries;
  }
  changesSince(cursor: number): { gap: boolean; entries: ChangeEntry[] } {
    const oldest = this.db.prepare("SELECT MIN(seq) AS seq FROM changes").get()!
      .seq as number | null;
    if (oldest !== null && cursor < oldest - 1) {
      return { gap: true, entries: [] };
    }
    return {
      gap: false,
      entries: this.db.prepare("SELECT * FROM changes WHERE seq>? ORDER BY seq")
        .all(cursor).map((r) => ({
          seq: r.seq as number,
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
        })),
    };
  }
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.db.close();
  }
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
