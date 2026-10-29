// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import { getEnv } from "../helpers.ts";
import { logger } from "../logger.ts";
import type { StorageEffect } from "../notes/file_system.ts";
import { pathKey, within } from "./paths.ts";
import { HubScanner, observeFile } from "./scanner.ts";
import { HubStore } from "./store.ts";
import type { ChangeEntry, Mutation, ScanStats } from "./types.ts";

export type Expectation = symbol;
export class VaultHub {
  readonly store: HubStore;
  readonly #scanner: HubScanner;
  readonly #expectations = new Map<Expectation, string[]>();
  readonly #subscribers = new Set<(entries: ChangeEntry[]) => void>();
  readonly #intervalMs: number;
  readonly #stateRoot: string;
  #timer?: ReturnType<typeof setInterval>;
  #debounce?: ReturnType<typeof setTimeout>;
  #watcher?: Deno.FsWatcher;
  #hints = new Set<string>();
  #started = false;
  #scanning = false;
  readonly root: string;
  constructor(notesPath: string, statePath: string) {
    this.root = Deno.realPathSync(notesPath);
    this.#intervalMs =
      Number(getEnv("GLOBNOTES_HUB_SCAN_INTERVAL", { default: "60" })) * 1000;
    if (!(this.#intervalMs > 0) || !Number.isFinite(this.#intervalMs)) {
      throw new Error("GLOBNOTES_HUB_SCAN_INTERVAL must be positive");
    }
    this.store = new HubStore(statePath);
    this.#stateRoot = Deno.realPathSync(statePath);
    this.#scanner = new HubScanner(
      this.root,
      this.#stateRoot,
      this.store,
      (name) =>
        [...this.#expectations.values()].some((paths) =>
          paths.some((p) =>
            p === "" || pathKey(name) === p || pathKey(name).startsWith(p + "/")
          )
        ),
    );
  }
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.scanNow();
    this.#timer = setInterval(() => this.#rescan(), this.#intervalMs);
    try {
      this.#watcher = Deno.watchFs(this.root, { recursive: true });
      this.#watch(this.#watcher);
    } catch (error) {
      logger.warning(`Hub watcher unavailable; periodic scans only: ${error}`);
    }
  }
  stop(): void {
    this.#started = false;
    clearInterval(this.#timer);
    clearTimeout(this.#debounce);
    this.#watcher?.close();
    this.#watcher = undefined;
    this.store.close();
  }
  async #watch(watcher: Deno.FsWatcher): Promise<void> {
    try {
      for await (const event of watcher) {
        if (!this.#started) break;
        if (event.kind === "access") continue;
        for (const absolute of event.paths) {
          if (
            !within(this.root, absolute) || within(this.#stateRoot, absolute)
          ) continue;
          const relative = path.relative(this.root, path.dirname(absolute));
          this.#hints.add(relative);
        }
        if (!this.#hints.size) continue;
        clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => {
          const scopes = [...this.#hints];
          this.#hints.clear();
          this.#rescan(scopes);
        }, 300);
      }
    } catch (error) {
      if (this.#started) {
        logger.warning(`Hub watcher failed; periodic scans only: ${error}`);
      }
    }
  }
  #rescan(directories?: string[]): void {
    try {
      this.scanNow(directories);
    } catch (error) {
      logger.error(`Hub scan failed: ${error}`);
    }
  }
  scanNow(targets?: string[]): ScanStats {
    if (this.#scanning) throw new Error("Hub scan already in progress");
    this.#scanning = true;
    try {
      const { mutations, stats } = this.#scanner.scan(targets);
      this.#publish(this.store.apply(mutations, "local", null));
      return stats;
    } finally {
      this.#scanning = false;
    }
  }
  expect(absolutePaths: readonly string[]): Expectation {
    const paths = absolutePaths.filter((p) => within(this.root, p))
      .map((p) => path.relative(this.root, p));
    // Folder observation has one owner. Ingest the actual file/directory targets
    // before reservation, preserving local versions and facts before our effect.
    if (paths.length) this.scanNow(paths);
    const token = Symbol("hub-write");
    this.#expectations.set(token, paths.map(pathKey));
    return token;
  }
  record(
    token: Expectation,
    effects: readonly StorageEffect[],
    origin: string,
  ): void {
    if (!this.#expectations.has(token)) {
      throw new Error("Unknown hub expectation");
    }
    let entries: ChangeEntry[];
    try {
      // Fold repeated writes and rename+write to one resulting file observation.
      const mutations = new Map<string, Mutation>();
      for (const effect of effects) {
        if (effect.kind === "mkdir" || !within(this.root, effect.path)) {
          continue;
        }
        const relative = path.relative(this.root, effect.path);
        const old = effect.oldPath && within(this.root, effect.oldPath)
          ? path.relative(this.root, effect.oldPath)
          : undefined;
        if (effect.kind === "rename" && old) {
          // Directory attachment moves are represented by a single storage effect.
          const descendants = this.store.files().filter((f) =>
            f.diskPath.startsWith(old + "/")
          );
          if (descendants.length) {
            for (const file of descendants) {
              const destination = relative + file.diskPath.slice(old.length);
              const observed = observeFile(this.root, destination);
              if (observed) {
                mutations.set(pathKey(destination), {
                  path: destination,
                  oldPath: file.diskPath,
                  file: observed,
                });
              }
            }
          }
          mutations.delete(pathKey(old));
        }
        let file;
        try {
          file = observeFile(this.root, relative);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        if (file) {
          const previous = this.store.fileState(relative);
          if (previous && previous.diskPath !== relative && !old) continue;
          mutations.set(pathKey(relative), {
            path: relative,
            file,
            oldPath: old ?? mutations.get(pathKey(relative))?.oldPath,
          });
        } else if (this.store.fileState(relative)) {
          mutations.set(pathKey(relative), { path: relative });
        }
      }
      entries = this.store.apply([...mutations.values()], "globnotes", origin);
    } finally {
      this.#expectations.delete(token);
    }
    this.#publish(entries!);
  }
  #publish(entries: ChangeEntry[]): void {
    if (!entries.length) return;
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(structuredClone(entries));
      } catch (error) {
        logger.error(`Hub subscriber failed: ${error}`);
      }
    }
  }
  subscribe(callback: (entries: ChangeEntry[]) => void): () => void {
    this.#subscribers.add(callback);
    return () => {
      this.#subscribers.delete(callback);
    };
  }
  changesSince(cursor: number) {
    return this.store.changesSince(cursor);
  }
  fileState(name: string) {
    return this.store.fileState(name);
  }
  collisions() {
    return this.#scanner.collisions();
  }
}
