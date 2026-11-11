// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";

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
    this.assertUnchanged(expected);
    const created = new Map<string, ConfigNode>();
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
      created.set(node.location, configNode(node.location));
    }
    const prepared = Object.freeze({
      raw: expected.raw,
      binding: Object.freeze({
        ...expected.binding,
        nodes: Object.freeze(
          expected.binding.nodes.map((node) =>
            created.get(node.location) ?? node
          ),
        ),
      }),
    });
    this.assertUnchanged(prepared);
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
    let failed = false, failure: unknown;
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
      Deno.renameSync(temporary, target);
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
    if (failed) throw failure;
  }
}
