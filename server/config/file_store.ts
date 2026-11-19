// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import { warnStoredDurability } from "./durability.ts";

interface ConfigNode {
  readonly location: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number | null;
    readonly mode: number | null;
    readonly uid: number | null;
    readonly gid: number | null;
    readonly kind: "file" | "directory" | "link";
    readonly link: string | null;
  } | null;
}
/** Host-only bytes and filesystem binding; never part of a public projection. */
export interface StoredConfigSnapshot {
  readonly raw: string | null;
  readonly binding: {
    readonly configured: string;
    readonly target: string;
    readonly nodes: readonly ConfigNode[];
  };
}
/** The bytes may already be visible and must not be rolled back in memory. */
export class StoredConfigDurabilityError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Stored configuration directory durability could not be confirmed.",
      options,
    );
  }
}
/** Flush one directory, or a newly created chain bottom-up through its bound
 * existing parent. All state writers share this durability boundary. */
export function syncStoredDirectory(
  directory: string,
  through = directory,
): void {
  let current = path.resolve(directory);
  const bound = path.resolve(through), relative = path.relative(bound, current);
  if (
    relative === ".." || relative.startsWith(`..${path.SEPARATOR}`) ||
    path.isAbsolute(relative)
  ) {
    throw new StoredConfigConflict();
  }
  try {
    while (true) {
      const handle = Deno.openSync(current, { read: true });
      try {
        if (!handle.statSync().isDirectory) throw new StoredConfigConflict();
        handle.syncSync();
      } finally {
        handle.close();
      }
      if (current === bound) return;
      current = path.dirname(current);
    }
  } catch (cause) {
    throw new StoredConfigDurabilityError({ cause });
  }
}
export class StoredConfigConflict extends Error {
  constructor() {
    super("Stored configuration changed before commit.");
  }
}
class ConfigBindingError extends Error {}
function configNode(location: string): ConfigNode {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(location);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return Object.freeze({ location, identity: null });
    }
    throw error;
  }
  if (!info.isFile && !info.isDirectory && !info.isSymlink) {
    throw new ConfigBindingError(
      "Stored configuration requires a regular file target.",
    );
  }
  return Object.freeze({
    location,
    identity: Object.freeze({
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      uid: info.uid,
      gid: info.gid,
      kind: info.isSymlink ? "link" : info.isDirectory ? "directory" : "file",
      link: info.isSymlink ? Deno.readLinkSync(location) : null,
    }),
  });
}
/** Resolve components without erasing a consulted link or following it unboundedly.
 * Missing ordinary parents are recorded; link targets must have existing parents. */
function configBinding(configured: string): StoredConfigSnapshot["binding"] {
  const parts = (value: string) => value.split(path.SEPARATOR).filter(Boolean);
  const root = path.parse(configured).root;
  let current = root, links = 0, steps = 0;
  let pending = parts(configured.slice(root.length)).map((segment) => ({
    segment,
    required: false,
  }));
  const nodes = new Map<string, ConfigNode>();
  nodes.set(root, configNode(root));
  while (pending.length) {
    if (++steps > 4096) {
      throw new ConfigBindingError("Stored configuration path is too complex.");
    }
    const item = pending.shift()!;
    if (item.segment === ".") continue;
    if (item.segment === "..") {
      current = path.dirname(current);
      continue;
    }
    const location = path.join(current, item.segment),
      node = configNode(location);
    nodes.set(location, node);
    if (node.identity?.kind === "link") {
      if (++links > 40) {
        throw new ConfigBindingError(
          "Stored configuration link cycle or excessive chain.",
        );
      }
      const target = node.identity.link!;
      const targetRoot = path.parse(target).root;
      if (targetRoot) {
        current = targetRoot;
        nodes.set(current, configNode(current));
      }
      const targetParts = parts(target.slice(targetRoot.length));
      const remaining = pending.length;
      pending = [
        ...targetParts.map((segment, i) => ({
          segment,
          required: remaining > 0 || i < targetParts.length - 1 ||
            item.required,
        })),
        ...pending,
      ];
      continue;
    }
    if (!node.identity && item.required) {
      throw new Deno.errors.NotFound(
        "Stored configuration link target parent is absent.",
      );
    }
    if (pending.length && node.identity && node.identity.kind !== "directory") {
      throw new ConfigBindingError(
        "Stored configuration parent is not a directory.",
      );
    }
    current = location;
  }
  const target = nodes.get(current) ?? configNode(current);
  if (target.identity && target.identity.kind !== "file") {
    throw new ConfigBindingError(
      "Stored configuration requires a regular file target.",
    );
  }
  return Object.freeze({
    configured,
    target: current,
    nodes: Object.freeze([...nodes.values()]),
  });
}

/** Main's bound-file persistence, independent of serialization and config policy.
 * The owning service serializes writes and publishes its state only on success. */
export class BoundFileStore {
  // Ownership bindings only, never durability credit. A failed preparation can
  // retry our own mkdir effects without accepting any foreign replacement.
  readonly #parents = new WeakMap<StoredConfigSnapshot, StoredConfigSnapshot>();
  #bound(snapshot: StoredConfigSnapshot): StoredConfigSnapshot {
    while (this.#parents.has(snapshot)) snapshot = this.#parents.get(snapshot)!;
    return snapshot;
  }
  constructor(readonly filename: string) {}

  capture(): StoredConfigSnapshot {
    const binding = configBinding(path.resolve(this.filename));
    const target = binding.nodes.find((node) =>
      node.location === binding.target
    );
    const raw = target?.identity ? Deno.readTextFileSync(binding.target) : null;
    return Object.freeze({ raw, binding });
  }

  assertUnchanged(snapshot: StoredConfigSnapshot): void {
    snapshot = this.#bound(snapshot);
    let current: StoredConfigSnapshot;
    try {
      current = this.capture();
    } catch (error) {
      if (
        error instanceof ConfigBindingError ||
        error instanceof Deno.errors.NotFound
      ) throw new StoredConfigConflict();
      throw error;
    }
    if (
      current.raw !== snapshot.raw ||
      JSON.stringify(current.binding) !== JSON.stringify(snapshot.binding)
    ) throw new StoredConfigConflict();
  }

  /** The only metadata-parent creator. No file bytes are written or recaptured. */
  prepareParents(expected = this.capture()): StoredConfigSnapshot {
    expected = this.#bound(expected);
    this.assertUnchanged(expected);
    let prepared = expected;
    for (const node of expected.binding.nodes) {
      if (node.identity || node.location === expected.binding.target) continue;
      try {
        Deno.mkdirSync(node.location);
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new StoredConfigConflict();
        }
        throw error;
      }
      const created = configNode(node.location);
      const next = Object.freeze({
        raw: prepared.raw,
        binding: Object.freeze({
          ...prepared.binding,
          nodes: Object.freeze(
            prepared.binding.nodes.map((n) =>
              n.location === created.location ? created : n
            ),
          ),
        }),
      });
      this.#parents.set(prepared, next);
      prepared = next;
    }
    this.assertUnchanged(prepared);
    syncStoredDirectory(
      path.dirname(prepared.binding.target),
      path.parse(prepared.binding.target).root,
    );
    return prepared;
  }

  /** Sync and replace the resolved target, retaining configured file/directory links.
   * Publish prepared bytes/binding at rename, without rereading the committed file. */
  replace(
    raw: string,
    expected = this.capture(),
    committed?: (snapshot: StoredConfigSnapshot) => void,
  ): void {
    const prepared = this.prepareParents(expected);
    const target = expected.binding.target;
    const identity = expected.binding.nodes.find((node) =>
      node.location === target
    )?.identity;
    // Replacement authority on the directory must not bypass target write access.
    if (identity) Deno.openSync(target, { write: true }).close();
    const temporary = Deno.makeTempFileSync({
      dir: path.dirname(target),
      prefix: ".config-",
    });
    let failed = false, failure: unknown, published = false;
    try {
      Deno.writeTextFileSync(temporary, raw);
      if (identity) {
        const temporaryInfo = Deno.statSync(temporary);
        if (
          identity.uid !== temporaryInfo.uid ||
          identity.gid !== temporaryInfo.gid
        ) {
          Deno.chownSync(temporary, identity.uid, identity.gid);
        }
        if (identity.mode !== null) {
          Deno.chmodSync(temporary, identity.mode & 0o7777);
        }
      }
      const handle = Deno.openSync(temporary, { write: true });
      try {
        handle.syncSync();
      } finally {
        handle.close();
      }
      // Rename preserves the prepared file's identity. Build the committed
      // binding before effects so publication cannot fail on a later disk read.
      const replacement = Object.freeze({
        location: target,
        identity: configNode(temporary).identity,
      });
      const snapshot: StoredConfigSnapshot = Object.freeze({
        raw,
        binding: Object.freeze({
          ...prepared.binding,
          nodes: Object.freeze(
            prepared.binding.nodes.map((node) =>
              node.location === target ? replacement : node
            ),
          ),
        }),
      });
      if (identity) Deno.openSync(target, { write: true }).close();
      this.assertUnchanged(prepared);
      if (identity) {
        Deno.renameSync(temporary, target);
      } else {
        // An absence check cannot reserve a pathname. Publish the complete
        // candidate without replacing an inode created by a competing writer.
        Deno.linkSync(temporary, target);
      }
      published = true;
      // Preserve the original publication point, even if later cleanup fails.
      committed?.(snapshot);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      Deno.removeSync(temporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        failure = failed
          ? new AggregateError(
            [failure, error],
            "Configuration persistence and temporary-file cleanup failed.",
          )
          : error;
        failed = true;
      }
    }
    if (published) {
      try {
        // Flush the final directory state after publication and candidate cleanup,
        // even when cleanup failed. The known snapshot was published above.
        syncStoredDirectory(path.dirname(target), path.parse(target).root);
      } catch (error) {
        failure = failed
          ? new StoredConfigDurabilityError({
            cause: new AggregateError([failure, error]),
          })
          : error;
        failed = true;
      }
    }
    if (published) {
      if (failed) warnStoredDurability();
      return;
    }
    if (failed) throw failure;
  }
}
