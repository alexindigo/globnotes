// SPDX-License-Identifier: LGPL-3.0-only
import { createHash } from "node:crypto";
import { readGrantCovers, resolveGrantedPath } from "../plugins/lifecycle.ts";
import type { PluginManifest } from "../plugins/manifest.ts";
import type { PluginHost } from "../plugins/host.ts";
import { type ObservedClock, processClock } from "../observed_time.ts";
import {
  metadataPath,
  type MetadataQuery,
  metadataQuery,
} from "./contracts.ts";
import type { MetadataProjection } from "./projection.ts";
import { getMetadata, queryMetadata } from "./query.ts";
import * as path from "@std/path";
import { within } from "../hub/paths.ts";

export function metadataRead(
  projection: MetadataProjection,
  manifest: PluginManifest,
  method: string,
  args: unknown[],
  current: () => boolean,
): unknown {
  if (!current()) throw new Error("metadata owner retired");
  if (args.length !== 1) throw new Error("metadata expects one argument");
  const currentGrant = (path: string) =>
    readGrantCovers(
      manifest,
      projection.hub.root,
      projection.hub.stateRoot,
      path,
    );
  if (method === "metadata.get") {
    const path = metadataPath(args[0]);
    if (!currentGrant(path)) {
      throw new Error("path is outside the plugin's declared read grants");
    }
    const record = getMetadata(projection, path);
    if (record && !currentGrant(record.path)) {
      throw new Error("path is outside the plugin's declared read grants");
    }
    return record;
  }
  // Pagination also expires when canonical read roots change without a source edit.
  const roots = manifest.capabilities.read.map((grant) => {
    try {
      return resolveGrantedPath(
        projection.hub.root,
        grant === "vault" ? projection.hub.root : grant,
        [grant],
      );
    } catch {
      return null;
    }
  });
  const fingerprint = createHash("sha256").update(JSON.stringify(roots)).digest(
    "hex",
  );
  // The projection's safe namespace is canonical and vault-contained. Resolve
  // grant roots once, then classify/count candidates without per-note realpaths.
  const eligible = (name: string) =>
    roots.some((root) =>
      root !== null && within(root, path.join(projection.hub.root, name))
    );
  return queryMetadata(
    projection,
    metadataQuery(args[0]),
    eligible,
    () => projection.revision + ":" + fingerprint,
    (record) => currentGrant(record.path),
  );
}

interface Watch {
  query: MetadataQuery;
  dirty: boolean;
  busy: boolean;
  retry: number;
  timer?: () => void;
}
/** Registry ownership, not a payload queue. Only queries and dirty bits survive waits. */
export class MetadataWatches {
  readonly #watches = new Map<string, Watch>();
  readonly #unsubscribe: () => void;
  #stopped = false;
  readonly #generation: string;
  constructor(
    private readonly options: {
      projection: MetadataProjection;
      manifest: PluginManifest;
      host: PluginHost;
      current(): boolean;
      failed(): void;
      clock?: ObservedClock;
    },
  ) {
    this.#generation = options.host.generation!;
    this.#unsubscribe = options.projection.subscribe(() => {
      for (const [id, watch] of this.#watches) {
        watch.dirty = true;
        this.#schedule(id, watch);
      }
    });
    this.sync();
  }
  #current(id: string): boolean {
    return !this.#stopped && this.options.current() &&
      this.options.host.available &&
      this.options.host.generation === this.#generation &&
      this.options.host.registrations.has(id);
  }
  sync(): void {
    for (const [id, watch] of this.#watches) {
      if (!this.options.host.registrations.has(id)) {
        watch.timer?.();
        this.#watches.delete(id);
      }
    }
    for (const [id, registration] of this.options.host.registrations) {
      if (registration.kind !== "metadata-watch" || this.#watches.has(id)) {
        continue;
      }
      const watch: Watch = {
        query: metadataQuery(registration.query),
        dirty: true,
        busy: false,
        retry: 5000,
      };
      this.#watches.set(id, watch);
      this.#schedule(id, watch);
    }
  }
  #schedule(id: string, watch: Watch, ms = 0): void {
    if (!this.#current(id) || watch.busy || watch.timer || !watch.dirty) return;
    watch.timer = (this.options.clock ?? processClock).deadline(ms, () => {
      watch.timer = undefined;
      void this.#deliver(id, watch);
    });
  }
  async #deliver(id: string, watch: Watch): Promise<void> {
    if (!this.#current(id)) return;
    watch.busy = true;
    watch.dirty = false;
    let retry = 0;
    try {
      await this.options.host.invoke(
        id,
        [],
        false,
        this.options.host.limits.serviceCallMs,
        {
          generation: this.#generation,
          prepareArgs: () => {
            // Changes during FIFO wait are included here, not in another retained result.
            watch.dirty = false;
            return [
              metadataRead(
                this.options.projection,
                this.options.manifest,
                "metadata.query",
                [watch.query],
                () => this.#current(id),
              ),
            ];
          },
        },
      );
      watch.retry = 5000;
    } catch {
      if (!this.#current(id)) return;
      this.options.failed();
      watch.dirty = true;
      retry = watch.retry;
      watch.retry = Math.min(watch.retry * 2, 300000);
    } finally {
      watch.busy = false;
      this.#schedule(id, watch, retry);
    }
  }
  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
    for (const watch of this.#watches.values()) watch.timer?.();
    this.#watches.clear();
  }
}
