// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import * as path from "@std/path";

export interface SecretDeclaration {
  key: string;
  label: string;
  description?: string;
}
export interface SecretStatus extends SecretDeclaration {
  set: boolean;
  updatedAt: string | null;
}

/** One vault's host-held keys. Only this owner reads values; public views expose
 * declared status fields. The existing state directory must already exist. */
export class DriverSecrets {
  readonly #db: DatabaseSync;
  readonly filename: string;
  constructor(statePath: string) {
    this.filename = path.join(
      Deno.realPathSync(statePath),
      "driver-secrets.sqlite",
    );
    try {
      const file = Deno.openSync(this.filename, {
        write: true,
        createNew: true,
        mode: 0o600,
      });
      file.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw new Error("Driver secret storage is unavailable");
      }
    }
    const stat = Deno.lstatSync(this.filename);
    if (
      !stat.isFile || stat.isSymlink ||
      stat.mode !== null && (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error("Driver secret storage must be a regular mode-0600 file");
    }
    const db = new DatabaseSync(this.filename);
    try {
      db.exec("PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE;");
      const version = db.prepare("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 1) {
        throw new Error("Unsupported driver secret schema");
      }
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS secrets(peer TEXT NOT NULL, key TEXT NOT NULL,
          value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(peer,key));
        PRAGMA user_version=1; COMMIT;`);
      this.#db = db;
    } catch {
      db.close();
      throw new Error("Driver secret storage is unavailable");
    }
  }
  get(peer: string, key: string): string | null {
    return this.#db.prepare("SELECT value FROM secrets WHERE peer=? AND key=?")
      .get(peer, key)?.value as string ?? null;
  }
  /** Host redaction input only. Never include this array in any public view. */
  values(peer: string): string[] {
    return this.#db.prepare("SELECT value FROM secrets WHERE peer=?").all(peer)
      .map((row) => row.value as string);
  }
  status(
    peer: string,
    declarations: readonly SecretDeclaration[],
  ): SecretStatus[] {
    const rows = new Map(
      this.#db.prepare("SELECT key,updated_at FROM secrets WHERE peer=?").all(
        peer,
      ).map((row) => [row.key, row.updated_at as string]),
    );
    return declarations.map((declaration) => ({
      ...declaration,
      set: rows.has(declaration.key),
      updatedAt: rows.get(declaration.key) ?? null,
    }));
  }
  set(peer: string, key: string, value: string): void {
    if (
      typeof value !== "string" || !value ||
      new TextEncoder().encode(value).length > 64 * 1024 ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(key)
    ) {
      throw new TypeError("Invalid driver key");
    }
    this.#db.prepare("INSERT OR REPLACE INTO secrets VALUES(?,?,?,?)").run(
      peer,
      key,
      value,
      new Date().toISOString(),
    );
  }
  clear(peer: string, key: string): void {
    this.#db.prepare("DELETE FROM secrets WHERE peer=? AND key=?").run(
      peer,
      key,
    );
  }
  remove(peer: string): void {
    this.#db.prepare("DELETE FROM secrets WHERE peer=?").run(peer);
  }
  close(): void {
    this.#db.close();
  }
}
