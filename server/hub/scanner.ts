// SPDX-License-Identifier: LGPL-3.0-only
import { createHash } from "node:crypto";
import * as path from "@std/path";
import { logger } from "../logger.ts";
import { pathKey, within } from "./paths.ts";
import type { HubStore } from "./store.ts";
import type { Collision, Mutation, Observation, ScanStats } from "./types.ts";

/** Check the whole relative route before opening a file or walking a target. */
function routeInfo(root: string, relative: string): Deno.FileInfo | null {
  let current = root;
  let info = Deno.lstatSync(root);
  for (const component of relative.split("/").filter(Boolean)) {
    current = path.join(current, component);
    info = Deno.lstatSync(current);
    if (info.isSymlink) return null;
  }
  return info;
}

/** Stream bytes; never keep note contents in hub state. No symlink traversal. */
export function observeFile(
  root: string,
  relative: string,
): Observation | null {
  const filename = path.join(root, relative);
  if (!routeInfo(root, relative)?.isFile) return null;
  const handle = Deno.openSync(filename, { read: true });
  try {
    const info = handle.statSync();
    if (!info.isFile) return null;
    const hash = createHash("sha256"), buffer = new Uint8Array(64 * 1024);
    let length;
    while ((length = handle.readSync(buffer)) !== null) {
      hash.update(buffer.subarray(0, length));
    }
    const after = handle.statSync();
    if (
      info.size !== after.size ||
      info.mtime?.getTime() !== after.mtime?.getTime()
    ) {
      throw new Error("File changed during hub observation");
    }
    return {
      key: pathKey(relative),
      diskPath: relative,
      hash: hash.digest("hex"),
      size: info.size,
      mtimeMs: info.mtime?.getTime() ?? 0,
    };
  } finally {
    handle.close();
  }
}

export class HubScanner {
  readonly #warned = new Set<string>();
  readonly #unknownWarnings = new Set<string>();
  #collisions: Collision[] = [];
  constructor(
    readonly root: string,
    readonly statePath: string,
    readonly store: HubStore,
    readonly expected: (name: string) => boolean,
  ) {}
  collisions(): Collision[] {
    return structuredClone(this.#collisions);
  }
  scan(targets = [""]): { mutations: Mutation[]; stats: ScanStats } {
    const known = this.store.files(), found = new Map<string, Observation>();
    const byKey = new Map(known.map((file) => [file.key, file]));
    const names = new Map<string, string[]>(), unreadable: string[] = [];
    const stats: ScanStats = {
      files: 0,
      hashed: 0,
      symlinks: 0,
      unknown: unreadable,
    };
    const excluded = (absolute: string) => within(this.statePath, absolute);
    const unknown = (relative: string, error: unknown) => {
      unreadable.push(relative);
      if (!this.#unknownWarnings.has(relative)) {
        this.#unknownWarnings.add(relative);
        logger.warning(`Hub scan could not read '${relative}': ${error}`);
      }
    };
    const addFile = (name: string) => {
      const key = pathKey(name);
      const matches = names.get(key) ?? [];
      matches.push(name);
      names.set(key, matches);
      stats.files++;
    };
    const walk = (relative: string) => {
      const absolute = path.join(this.root, relative);
      if (!within(this.root, absolute) || excluded(absolute)) return;
      try {
        const info = routeInfo(this.root, relative);
        if (!info) {
          stats.symlinks++;
          return;
        }
        if (info.isFile) {
          addFile(relative);
          return;
        }
        if (!info.isDirectory) return;
        const entries = [...Deno.readDirSync(absolute)].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        );
        for (const entry of entries) {
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (excluded(path.join(this.root, name))) continue;
          if (entry.isSymlink) {
            stats.symlinks++;
            continue;
          }
          if (entry.isDirectory) {
            walk(name);
            continue;
          }
          if (!entry.isFile) continue;
          addFile(name);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) unknown(relative, error);
      }
    };
    // Collapse overlapping scopes so watcher hints cannot double-observe a file.
    const scopes = [...new Set(targets)].filter((dir, i, all) =>
      !all.some((parent, j) =>
        j !== i && (parent === "" || dir.startsWith(parent + "/"))
      )
    );
    for (const dir of scopes) walk(dir);
    const inScope = (name: string) =>
      scopes.some((d) => !d || name === d || name.startsWith(d + "/"));
    // Choose one owner only after collecting the normalized namespace. Two
    // colliding parent directories must not let traversal order replace it.
    for (const [key, paths] of names) {
      const previous = byKey.get(key);
      if (paths.some((name) => this.expected(name))) continue;
      if (previous && !paths.includes(previous.diskPath)) {
        try {
          const owner = observeFile(this.root, previous.diskPath);
          if (owner) {
            paths.unshift(previous.diskPath);
            found.set(key, owner);
            stats.hashed++;
            continue;
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            unknown(previous.diskPath, error);
            continue;
          }
        }
      }
      const name = previous && paths.includes(previous.diskPath)
        ? previous.diskPath
        : paths[0];
      try {
        const info = Deno.lstatSync(path.join(this.root, name));
        if (
          previous?.diskPath === name && previous.size === info.size &&
          previous.mtimeMs === (info.mtime?.getTime() ?? 0)
        ) {
          found.set(key, previous);
        } else {
          const file = observeFile(this.root, name);
          stats.hashed++;
          if (file) found.set(key, file);
        }
      } catch (error) {
        unknown(name, error);
      }
    }
    this.#collisions = this.#collisions.filter((c) =>
      !names.has(c.key) && !c.paths.some(inScope)
    );
    for (const [key, paths] of names) {
      if (paths.length > 1) {
        this.#collisions.push({ key, paths });
        if (!this.#warned.has(key)) {
          this.#warned.add(key);
          logger.warning(`Hub NFC collision: ${JSON.stringify(paths)}`);
        }
      }
    }
    const missing = known.filter((f) =>
      inScope(f.diskPath) && !found.has(f.key) &&
      !this.expected(f.diskPath) && !unreadable.some((d) =>
        !d || f.diskPath === d || f.diskPath.startsWith(d + "/")
      )
    );
    const added = [...found.values()].filter((f) => !byKey.has(f.key));
    const mutations: Mutation[] = [];
    const moved = new Set<string>();
    const sourcesByHash = groupByHash(missing),
      targetsByHash = groupByHash(added);
    for (const file of added) {
      const sources = sourcesByHash.get(file.hash) ?? [];
      const targets = targetsByHash.get(file.hash)!;
      if (sources.length === 1 && targets.length === 1) {
        moved.add(sources[0].key);
        mutations.push({
          path: file.diskPath,
          oldPath: sources[0].diskPath,
          file,
        });
      } else mutations.push({ path: file.diskPath, file });
    }
    for (const file of found.values()) {
      const previous = byKey.get(file.key);
      if (!previous) continue;
      if (previous.diskPath !== file.diskPath) {
        mutations.push({
          path: file.diskPath,
          oldPath: previous.diskPath,
          file,
        });
      } else if (previous.hash !== file.hash) {
        mutations.push({ path: file.diskPath, file });
      } else {this.store.refresh({
          ...previous,
          size: file.size,
          mtimeMs: file.mtimeMs,
        });}
    }
    for (const file of missing) {
      if (!moved.has(file.key)) mutations.push({ path: file.diskPath });
    }
    return { mutations, stats };
  }
}

function groupByHash<T extends { hash: string }>(files: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const group = groups.get(file.hash) ?? [];
    group.push(file);
    groups.set(file.hash, group);
  }
  return groups;
}
