// SPDX-License-Identifier: LGPL-3.0-only
import { anonymousPath } from "../paths.ts";
import type { HubStore } from "../store.ts";

export type PeerFileState =
  | "synced"
  | "pending"
  | "uncertain"
  | "excluded"
  | "unsupported"
  | "held"
  | "delete-pending";
export interface PeerFile {
  pathKey: string;
  version: string | null;
  revision: string | null;
  state: PeerFileState;
  attempts: number;
  nextAt: number;
}
export interface DriverInstance {
  id: string;
  label: string;
  plugin: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  revision: number;
}
export interface PeerSync {
  endpointId: string | null;
  endpointEpoch: string | null;
  scope: string | null;
  cursor: string | null;
  exportSeq: number;
}
export class PeerRevisionConflict extends Error {
  readonly status = 409;
  readonly code = "driver_stale";
  constructor() {
    super("The sync instance changed; read it again.");
  }
}

/** One vault's peer metadata. No method stores a plaintext file name or body. */
export class DriverPeers {
  constructor(readonly store: HubStore) {}
  /** Attention decisions cannot borrow a previous Worker/server generation's
   * numeric revision. This contains no paths, bodies or native identifiers. */
  nextAttentionRevision(): number {
    this.store.db.prepare(
      "INSERT INTO meta(key,value) VALUES('driver_attention_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
    ).run();
    return Number(
      this.store.db.prepare(
        "SELECT value FROM meta WHERE key='driver_attention_revision'",
      ).get()!.value,
    );
  }
  key(name: string): string {
    return anonymousPath(this.store.secret, name);
  }
  instances(): DriverInstance[] {
    return this.store.db.prepare(
      "SELECT * FROM peers WHERE plugin IS NOT NULL AND state!='retired' ORDER BY created_at,id",
    )
      .all().map(decodeInstance);
  }
  instance(id: string): DriverInstance | null {
    const row = this.store.db.prepare(
      "SELECT * FROM peers WHERE id=? AND plugin IS NOT NULL AND state!='retired'",
    ).get(id);
    return row ? decodeInstance(row) : null;
  }
  create(
    plugin: string,
    label: string,
    settings: Record<string, unknown> = {},
  ): DriverInstance {
    if (!label.trim() || label.length > 128) {
      throw new TypeError("Invalid instance label");
    }
    const slug =
      label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
        /^-|-$/g,
        "",
      ).slice(0, 24) || "sync";
    let id = slug;
    for (
      let n = 2;
      this.store.db.prepare("SELECT id FROM peers WHERE id=?").get(id);
      n++
    ) id = `${slug}-${n}`;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      throw new TypeError("Instance id exhausted");
    }
    this.store.db.prepare(
      "INSERT INTO peers(id,kind,label,state,created_at,plugin,settings,enabled,revision) VALUES(?,'driver',?,'active',?,?,?,0,1)",
    )
      .run(
        id,
        label,
        new Date().toISOString(),
        plugin,
        JSON.stringify(settings),
      );
    return this.instance(id)!;
  }
  update(
    id: string,
    revision: number,
    values: Pick<DriverInstance, "label" | "settings" | "enabled">,
  ): DriverInstance {
    if (!values.label.trim() || values.label.length > 128) {
      throw new TypeError("Invalid instance label");
    }
    const result = this.store.db.prepare(
      "UPDATE peers SET label=?,settings=?,enabled=?,revision=revision+1 WHERE id=? AND revision=? AND plugin IS NOT NULL AND state!='retired'",
    )
      .run(
        values.label,
        JSON.stringify(values.settings),
        values.enabled ? 1 : 0,
        id,
        revision,
      );
    if (!result.changes) throw new PeerRevisionConflict();
    return this.instance(id)!;
  }
  retire(id: string, revision: number): void {
    const result = this.store.db.prepare(
      "UPDATE peers SET state='retired',settings='{}',enabled=0,revision=revision+1 WHERE id=? AND revision=? AND plugin IS NOT NULL AND state!='retired'",
    )
      .run(id, revision);
    if (!result.changes) throw new PeerRevisionConflict();
    this.reset(id);
    this.store.checkpoint();
  }
  files(peer: string): PeerFile[] {
    return this.store.db.prepare(
      "SELECT * FROM peer_files WHERE peer=? ORDER BY path_key",
    ).all(peer).map(decodeFile);
  }
  file(peer: string, name: string): PeerFile | null {
    return this.fileByKey(peer, this.key(name));
  }
  fileByKey(peer: string, key: string): PeerFile | null {
    const row = this.store.db.prepare(
      "SELECT * FROM peer_files WHERE peer=? AND path_key=?",
    ).get(peer, key);
    return row ? decodeFile(row) : null;
  }
  setFile(peer: string, file: PeerFile): void {
    this.store.db.prepare(
      "INSERT OR REPLACE INTO peer_files(peer,path_key,version,revision,state,attempts,next_at) VALUES(?,?,?,?,?,?,?)",
    )
      .run(
        peer,
        file.pathKey,
        file.version,
        file.revision,
        file.state,
        file.attempts,
        file.nextAt,
      );
  }
  acknowledge(
    peer: string,
    name: string,
    version: string | null,
    revision: string | null,
    state: PeerFileState = "synced",
  ): void {
    this.setFile(peer, {
      pathKey: this.key(name),
      version,
      revision,
      state,
      attempts: 0,
      nextAt: 0,
    });
  }
  drop(peer: string, key: string): void {
    this.store.db.prepare("DELETE FROM peer_files WHERE peer=? AND path_key=?")
      .run(peer, key);
  }
  deleted(name: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM tombstones WHERE path_key=?")
      .get(this.key(name));
  }
  sync(peer: string): PeerSync {
    const row = this.store.db.prepare("SELECT * FROM peer_sync WHERE peer=?")
      .get(peer);
    return row
      ? {
        endpointId: row.endpoint_id as string | null,
        endpointEpoch: row.endpoint_epoch as string | null,
        scope: row.scope as string | null,
        cursor: row.cursor as string | null,
        exportSeq: row.export_seq as number,
      }
      : {
        endpointId: null,
        endpointEpoch: null,
        scope: null,
        cursor: null,
        exportSeq: 0,
      };
  }
  setSync(peer: string, sync: PeerSync): void {
    this.store.db.prepare(
      "INSERT OR REPLACE INTO peer_sync VALUES(?,?,?,?,?,?,?)",
    )
      .run(
        peer,
        sync.endpointId,
        sync.endpointEpoch,
        sync.scope,
        sync.cursor,
        sync.exportSeq,
        new Date().toISOString(),
      );
  }
  reset(peer: string): void {
    this.store.db.prepare("DELETE FROM peer_files WHERE peer=?").run(peer);
    this.store.db.prepare("DELETE FROM peer_sync WHERE peer=?").run(peer);
  }
  /** Identity replacement never compares omissions against the old endpoint. */
  bind(
    peer: string,
    endpoint: { id: string; epoch: string },
    scope: string,
  ): { rebootstrap: boolean; scopeChanged: boolean } {
    const previous = this.sync(peer);
    const rebootstrap = previous.endpointId !== endpoint.id ||
      previous.endpointEpoch !== endpoint.epoch;
    const scopeChanged = previous.scope !== scope;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (rebootstrap) this.reset(peer);
      else if (scopeChanged) {
        this.store.db.prepare(
          "DELETE FROM peer_files WHERE peer=? AND state='excluded'",
        ).run(peer);
      }
      this.setSync(peer, {
        ...(rebootstrap ? this.sync(peer) : previous),
        endpointId: endpoint.id,
        endpointEpoch: endpoint.epoch,
        scope,
        cursor: rebootstrap || scopeChanged ? null : previous.cursor,
      });
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return { rebootstrap, scopeChanged };
  }
}
function decodeInstance(row: Record<string, unknown>): DriverInstance {
  return {
    id: row.id as string,
    label: row.label as string,
    plugin: row.plugin as string,
    settings: JSON.parse(row.settings as string),
    enabled: row.enabled === 1,
    revision: row.revision as number,
  };
}
function decodeFile(row: Record<string, unknown>): PeerFile {
  return {
    pathKey: row.path_key as string,
    version: row.version as string | null,
    revision: row.revision as string | null,
    state: row.state as PeerFileState,
    attempts: row.attempts as number,
    nextAt: row.next_at as number,
  };
}
