// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import { warnStoredDurability } from "./durability.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import { bindGuardedSink } from "../internal/guarded_sink.ts";
import { createUuid } from "../../shared/uuid.ts";
import {
  type RecordedCandidate,
  type RecordedCandidateData,
  registerPublicationWriter,
  registerRecordedWriter,
} from "./internal/publication_port.ts";
import {
  type PublicationOutcome,
  PublicationRecoveryRequired,
  PublicationSetUnavailable,
  StoredConfigConflict,
} from "./publication_outcome.ts";
export {
  type PublicationOutcome,
  PublicationRecoveryRequired,
  StoredConfigConflict,
} from "./publication_outcome.ts";
import {
  openStateDirectory,
  physicalStateRoot,
  preflightStateRoot,
  StateRootError,
} from "./state_root.ts";

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
export interface PreparedStoredPublication {
  publish(): PublicationOutcome;
  discard(): void;
}
interface StoredCandidate {
  readonly temporary: string;
  readonly identity: ConfigNode["identity"];
  readonly custody: CandidateCustody;
  readonly expected: StoredConfigSnapshot;
  readonly snapshot: StoredConfigSnapshot;
  readonly replace: boolean;
  phase: "prepared" | "publishing" | "published" | "discarded";
}
/** Cleanup responsibility is independent of single-use publication authority. */
interface CandidateCustody {
  readonly temporary: string;
  handle: Deno.FsFile | undefined;
  identity: ConfigNode["identity"];
  requested: boolean;
  unlinked: boolean;
}
function synchronous(callback: (...args: never[]) => unknown): void {
  if (
    typeof callback !== "function" ||
    Object.prototype.toString.call(callback) === "[object AsyncFunction]"
  ) {
    throw new TypeError("Publication installation must be synchronous.");
  }
}
const below = (root: string, location: string): boolean => {
  const relative = path.relative(root, location);
  return relative !== ".." && !relative.startsWith(`..${path.SEPARATOR}`) &&
    !path.isAbsolute(relative);
};
/** Sync only owned directories. An external file-link target has an existing,
 * deployment-provided parent, which is synced without walking above it. */
export function syncOwnedStoredDirectory(
  directory: string,
  root: string,
): void {
  const owned = physicalStateRoot(root), target = path.resolve(directory);
  if (below(owned, target)) syncStoredDirectory(target, owned);
  else {
    syncStoredDirectory(target);
    syncStoredDirectory(owned);
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

// A destination can have several bound writer instances (including symlink
// aliases). Track each live custody hold independently of those instances.
const reservedTargets = new Map<string, Set<symbol>>();
function reserveTarget(target: string): () => void {
  const hold = Symbol();
  let claims = reservedTargets.get(target);
  if (!claims) reservedTargets.set(target, claims = new Set());
  claims.add(hold);
  return () => {
    if (claims.delete(hold) && !claims.size) reservedTargets.delete(target);
  };
}

/** Main's bound-file persistence, independent of serialization and config policy.
 * The owning service serializes writes. Publication is the commit point; later
 * durability warnings cannot roll it back, and installation failure needs recovery. */
export class BoundFileStore {
  // Ownership bindings only, never durability credit. A failed preparation can
  // retry our own mkdir effects without accepting any foreign replacement.
  readonly #parents = new WeakMap<StoredConfigSnapshot, StoredConfigSnapshot>();
  readonly #candidates = new Set<CandidateCustody>();
  #bound(snapshot: StoredConfigSnapshot): StoredConfigSnapshot {
    while (this.#parents.has(snapshot)) snapshot = this.#parents.get(snapshot)!;
    return snapshot;
  }
  constructor(
    readonly filename: string,
    readonly root = path.dirname(path.resolve(filename)),
  ) {
    registerPublicationWriter(
      this,
      (...args) => this.#preparePublication(...args),
    );
    registerRecordedWriter(this, path.resolve(this.root), {
      reserveOrdinaryWrites: (expected) =>
        reserveTarget(expected.binding.target),
      prepare: (raw, expected, lease, setId, role) => {
        assertOperationLease(lease, "live");
        this.#recordIdentity(setId, role);
        const candidate = this.#prepare(raw, expected);
        try {
          syncOwnedStoredDirectory(
            path.dirname(candidate.temporary),
            this.root,
          );
          return this.#recordedCandidate(candidate, lease, setId, role);
        } catch (error) {
          candidate.phase = "discarded";
          try {
            this.#cleanupCandidate(candidate.custody);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "Recorded preparation and cleanup failed.",
              { cause: error },
            );
          }
          throw error;
        }
      },
      recover: (input, lease, setId, role) =>
        this.#recoverRecorded(input, lease, setId, role),
    });
  }

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
    const owned = physicalStateRoot(this.root);
    let rootExists = false;
    try {
      rootExists = Deno.statSync(owned).isDirectory;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (rootExists) preflightStateRoot(owned);
    let prepared = expected;
    for (const node of expected.binding.nodes) {
      if (node.identity || node.location === expected.binding.target) continue;
      let parent: Deno.FsFile | undefined;
      let created: ConfigNode;
      try {
        if (node.location === owned || !below(owned, node.location)) {
          parent = openStateDirectory(path.dirname(node.location));
        }
        Deno.mkdirSync(node.location);
        created = configNode(node.location);
        try {
          parent?.syncSync();
        } catch (cause) {
          const current = configNode(node.location);
          if (
            current.identity?.dev === created.identity?.dev &&
            current.identity?.ino === created.identity?.ino
          ) {
            Deno.removeSync(node.location);
          }
          throw new StateRootError(
            path.dirname(node.location),
            "confirm the new state-root entry",
            { cause },
          );
        }
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new StoredConfigConflict();
        }
        throw error;
      } finally {
        parent?.close();
      }
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
    if (!rootExists) preflightStateRoot(owned);
    syncOwnedStoredDirectory(path.dirname(prepared.binding.target), this.root);
    return prepared;
  }

  #prepare(raw: string, expected: StoredConfigSnapshot): StoredCandidate {
    // Previous failures were already reported to their caller. Retry cleanup,
    // never publication, without blocking unrelated mutations or active handles.
    for (const custody of this.#candidates) {
      if (!custody.requested) continue;
      try {
        this.#cleanupCandidate(custody);
      } catch {
        // Retain exact custody for the next attempt; do not repeat diagnostics.
      }
    }
    const prepared = this.prepareParents(expected);
    const target = expected.binding.target;
    const identity = expected.binding.nodes.find((node) =>
      node.location === target
    )?.identity;
    // Replacement authority on the directory must not bypass target write access.
    this.#assertWritable(target, !!identity);
    const custody = this.#createCandidate(path.dirname(target));
    const temporary = custody.temporary;
    try {
      const owned = this.#inspectCandidate(custody).identity;
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
      custody.handle!.syncSync();
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
      return {
        temporary,
        identity: owned,
        custody,
        expected: prepared,
        snapshot,
        replace: identity !== null,
        phase: "prepared",
      };
    } catch (error) {
      try {
        this.#cleanupCandidate(custody);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Stored preparation and cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  #createCandidate(directory: string): CandidateCustody {
    while (true) {
      const temporary = path.join(directory, `.config-${createUuid()}`);
      const custody: CandidateCustody = {
        temporary,
        handle: undefined,
        identity: null,
        requested: false,
        unlinked: false,
      };
      try {
        custody.handle = Deno.openSync(temporary, {
          read: true,
          write: true,
          createNew: true,
          mode: 0o600,
        });
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) continue;
        throw error;
      }
      // No filesystem inspection can throw between creation and store custody.
      this.#candidates.add(custody);
      return custody;
    }
  }

  #inspectCandidate(custody: CandidateCustody): {
    identity: ConfigNode["identity"];
    nlink: Deno.FileInfo["nlink"];
  } {
    // Cached dev/ino is authority only while the original descriptor pins that
    // inode. Recheck the descriptor itself before every cleanup attempt.
    if (!custody.handle) {
      custody.identity = null;
      throw new StoredConfigConflict();
    }
    let info: Deno.FileInfo;
    try {
      info = custody.handle.statSync();
    } catch (error) {
      if (error instanceof Deno.errors.BadResource) {
        // A lost descriptor cannot be reacquired by name without adopting a
        // possible replacement. Release custody without unlink authority.
        custody.handle = undefined;
        custody.identity = null;
        this.#candidates.delete(custody);
      }
      throw error;
    }
    if (!info.isFile || info.ino === null) throw new StoredConfigConflict();
    if (
      custody.identity && (custody.identity.dev !== info.dev ||
        custody.identity.ino !== info.ino)
    ) throw new StoredConfigConflict();
    if (!custody.identity) {
      // A pathname stat can observe a replacement. Only the original open file
      // establishes identity, including when its first stat must be retried.
      custody.identity = Object.freeze({
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        uid: info.uid,
        gid: info.gid,
        kind: "file",
        link: null,
      });
    }
    return { identity: custody.identity, nlink: info.nlink };
  }

  #cleanupCandidate(custody: CandidateCustody): void {
    custody.requested = true;
    // Keep a linked inode pinned across failed cleanup. A positive zero-link
    // observation means the owned file is gone, regardless of this pathname.
    if (!custody.unlinked) {
      const { identity, nlink } = this.#inspectCandidate(custody);
      if (nlink !== 0) this.#discardExact(custody.temporary, identity);
      custody.unlinked = true;
    }
    // Revoke pathname unlink authority before releasing the original inode.
    custody.identity = null;
    if (custody.handle) {
      custody.handle.close();
      custody.handle = undefined;
    }
    this.#candidates.delete(custody);
  }

  #discardExact(temporary: string, identity: ConfigNode["identity"]): void {
    const current = configNode(temporary).identity;
    if (!current) return;
    if (
      !identity || current.dev !== identity.dev || current.ino !== identity.ino
    ) {
      throw new StoredConfigConflict();
    }
    Deno.removeSync(temporary);
  }

  #recordIdentity(setId: string, role: string): void {
    if (
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(setId) ||
      !/^[a-z][a-z0-9-]*$/.test(role)
    ) throw new StoredConfigConflict();
  }

  #assertWritable(target: string, identity: boolean): void {
    if (identity) Deno.openSync(target, { write: true }).close();
  }

  #deliverCandidate(candidate: StoredCandidate, ordinary: boolean): void {
    const temporary = candidate.temporary,
      target = candidate.snapshot.binding.target,
      replace = candidate.replace;
    // All authority witnesses and storage validation have returned. Only the
    // native link/rename may follow this final, non-reentrant reservation check.
    if (ordinary && reservedTargets.has(target)) {
      throw new PublicationSetUnavailable();
    }
    if (replace) {
      Deno.renameSync(temporary, target);
    } else {
      Deno.linkSync(temporary, target);
    }
  }

  #recordedCandidate(
    candidate: StoredCandidate,
    lease: OperationLease<"live"> | OperationLease<"recovery">,
    setId: string,
    role: string,
  ): RecordedCandidate {
    const record: RecordedCandidateData = Object.freeze({
      version: 1,
      setId,
      role,
      root: path.resolve(this.root),
      before: candidate.expected,
      after: candidate.snapshot,
      candidate: path.basename(candidate.temporary),
    });
    const validateStorage = () => {
      if (candidate.phase === "discarded" || candidate.phase === "publishing") {
        throw new StoredConfigConflict();
      }
      if (candidate.phase === "published") {
        this.assertUnchanged(candidate.snapshot);
        return;
      }
      const original = this.#inspectCandidate(candidate.custody).identity;
      const current = configNode(candidate.temporary).identity;
      const after =
        candidate.snapshot.binding.nodes.find((node) =>
          node.location === candidate.snapshot.binding.target
        )!.identity;
      if (
        original?.dev !== after?.dev || original?.ino !== after?.ino ||
        JSON.stringify(current) !== JSON.stringify(after) ||
        Deno.readTextFileSync(candidate.temporary) !== candidate.snapshot.raw
      ) throw new StoredConfigConflict();
      this.assertUnchanged(candidate.expected);
      this.#assertWritable(
        candidate.snapshot.binding.target,
        candidate.replace,
      );
    };
    const operation = createOperationLease(lease.mode, [() => {
      validateStorage();
      return undefined;
    }], [lease]);
    const validate = () => assertOperationLease(operation.lease, lease.mode);
    let busy = false;
    let cleaning = false;
    const deliver = bindGuardedSink(
      operation.lease,
      lease.mode,
      () => ({ value: undefined }),
      () => {
        this.#deliverCandidate(candidate, false);
        return undefined;
      },
    );
    return Object.freeze({
      record,
      authority: lease,
      validateStorage,
      validate,
      detach: () => {
        candidate.phase = "discarded";
        operation.retire();
        candidate.custody.requested = true;
        // A rejected reconstruction releases only its descriptor. Even a failed
        // close retry must never turn into deletion of a decided candidate.
        candidate.custody.unlinked = true;
        candidate.custody.identity = null;
        candidate.custody.handle?.close();
        candidate.custody.handle = undefined;
        this.#candidates.delete(candidate.custody);
      },
      apply: () => {
        if (busy) throw new StoredConfigConflict();
        busy = true;
        try {
          // Successful replay is idempotent, but only while its exact after state
          // remains current. Never reapply a stale retired journal over a new edit.
          if (candidate.phase !== "published") {
            validate();
            deliver(undefined);
            candidate.phase = "published";
          } else validate();
          let warning = false;
          try {
            this.#cleanupCandidate(candidate.custody);
          } catch {
            warning = true;
          }
          try {
            syncOwnedStoredDirectory(
              path.dirname(candidate.snapshot.binding.target),
              this.root,
            );
          } catch {
            warning = true;
          }
          return Object.freeze({ snapshot: candidate.snapshot, warning });
        } finally {
          busy = false;
        }
      },
      discard: () => {
        // A decided participant is never passed to ordinary discard by its set
        // owner. Published state itself is irreversible; only alias cleanup runs.
        if (candidate.phase !== "published") candidate.phase = "discarded";
        operation.retire();
        if (cleaning) return;
        cleaning = true;
        try {
          this.#cleanupCandidate(candidate.custody);
        } finally {
          cleaning = false;
        }
      },
    });
  }

  #recoverRecorded(
    input: unknown,
    lease: OperationLease<"recovery">,
    setId: string,
    role: string,
  ): RecordedCandidate {
    assertOperationLease(lease, "recovery");
    this.#recordIdentity(setId, role);
    // Round-trip first: capture getters once before any final authority fence.
    const data = JSON.parse(JSON.stringify(input)) as RecordedCandidateData;
    const keys = (value: object, names: string[]) =>
      Object.keys(value).sort().join() === names.sort().join();
    if (
      !data ||
      !keys(data, [
        "version",
        "setId",
        "role",
        "root",
        "before",
        "after",
        "candidate",
      ]) ||
      data.version !== 1 || data.setId !== setId || data.role !== role ||
      data.root !== path.resolve(this.root) ||
      typeof data.candidate !== "string" ||
      !/^\.config-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
        data.candidate,
      )
    ) throw new StoredConfigConflict();
    // Schema-check every serialized node; neither roots nor destinations can be
    // selected by journal bytes. Compare the entire binding to the actual store.
    for (const snapshot of [data.before, data.after]) {
      if (
        !snapshot || !keys(snapshot, ["raw", "binding"]) ||
        !(snapshot.raw === null || typeof snapshot.raw === "string") ||
        !snapshot.binding ||
        !keys(snapshot.binding, ["configured", "target", "nodes"]) ||
        snapshot.binding.configured !== path.resolve(this.filename) ||
        !Array.isArray(snapshot.binding.nodes)
      ) throw new StoredConfigConflict();
      for (const node of snapshot.binding.nodes) {
        if (
          !node || !keys(node, ["location", "identity"]) ||
          typeof node.location !== "string"
        ) {
          throw new StoredConfigConflict();
        }
        const identity = node.identity;
        if (
          identity !== null && (
            !identity ||
            !keys(identity, [
              "dev",
              "ino",
              "mode",
              "uid",
              "gid",
              "kind",
              "link",
            ]) ||
            ![
              identity.dev,
              identity.ino,
              identity.mode,
              identity.uid,
              identity.gid,
            ].every((n) => n === null || Number.isSafeInteger(n) && n >= 0) ||
            !["file", "directory", "link"].includes(identity.kind) ||
            !(identity.link === null || typeof identity.link === "string")
          )
        ) throw new StoredConfigConflict();
      }
    }
    if (typeof data.after.raw !== "string") throw new StoredConfigConflict();
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(data);
    const target = data.before.binding.target;
    const afterIdentity = data.after.binding.nodes.find((node) =>
      node.location === target
    )?.identity;
    const expectedAfter = {
      ...data.before.binding,
      nodes: data.before.binding.nodes.map((node) =>
        node.location === target
          ? { location: target, identity: afterIdentity }
          : node
      ),
    };
    if (
      !afterIdentity || afterIdentity.kind !== "file" ||
      afterIdentity.ino === null ||
      JSON.stringify(data.after.binding) !== JSON.stringify(expectedAfter)
    ) {
      throw new StoredConfigConflict();
    }
    const current = this.capture();
    const published = JSON.stringify(current) === JSON.stringify(data.after);
    if (!published && JSON.stringify(current) !== JSON.stringify(data.before)) {
      throw new StoredConfigConflict();
    }
    const temporary = path.join(path.dirname(target), data.candidate);
    const custody: CandidateCustody = {
      temporary,
      handle: undefined,
      identity: null,
      requested: false,
      unlinked: published,
    };
    // Reopen without following a foreign symlink. A published rename may have
    // consumed the alias; no descriptor or deletion authority is then needed.
    const alias = configNode(temporary).identity;
    if (alias) {
      if (
        JSON.stringify(alias) !== JSON.stringify(afterIdentity) ||
        Deno.readTextFileSync(temporary) !== data.after.raw
      ) throw new StoredConfigConflict();
      custody.handle = Deno.openSync(temporary, { read: true });
      this.#candidates.add(custody);
      custody.unlinked = false;
      try {
        const actual = this.#inspectCandidate(custody).identity;
        if (
          actual?.dev !== afterIdentity.dev || actual?.ino !== afterIdentity.ino
        ) {
          throw new StoredConfigConflict();
        }
      } catch (error) {
        // Failed admission owns the descriptor, but never adopts unlink rights.
        custody.handle.close();
        this.#candidates.delete(custody);
        throw error;
      }
    } else if (!published) throw new StoredConfigConflict();
    const candidate: StoredCandidate = {
      temporary,
      custody,
      identity: afterIdentity,
      expected: data.before,
      snapshot: data.after,
      replace: data.before.raw !== null,
      phase: published ? "published" : "prepared",
    };
    try {
      return this.#recordedCandidate(candidate, lease, setId, role);
    } catch (error) {
      custody.handle?.close();
      this.#candidates.delete(custody);
      throw error;
    }
  }

  /** Internal owner capability. Callers bind installation while preparing; the
   * returned single-use operation accepts no effect callback or replacement data.
   * P01 restricts the private module port to the bound publication owners. */
  #preparePublication(
    raw: string,
    expected: StoredConfigSnapshot,
    lease: OperationLease<"live">,
    install: (snapshot: StoredConfigSnapshot) => undefined,
  ): PreparedStoredPublication {
    synchronous(install);
    assertOperationLease(lease, "live");
    let staged: StoredCandidate | undefined;
    const publication = createOperationLease("live", [() => {
      const candidate = staged;
      if (!candidate) return;
      // Parent callbacks precede storage validation; all pure lifetime fences
      // follow it, so reentrant validation cannot authorize a stale write.
      const current = configNode(candidate.temporary).identity;
      if (
        !current || current.dev !== candidate.identity?.dev ||
        current.ino !== candidate.identity?.ino ||
        Deno.readTextFileSync(candidate.temporary) !== raw
      ) throw new StoredConfigConflict();
      const target = candidate.snapshot.binding.target,
        identity = candidate.replace;
      this.#assertWritable(target, identity);
      this.assertUnchanged(candidate.expected);
    }], [lease]);
    let deliver: () => void;
    // Bind before staging so the binder's provenance check does not introduce
    // an extra CAS between final validation and the no-clobber native write.
    const publish = bindGuardedSink(
      publication.lease,
      "live",
      () => ({ value: undefined }),
      () => {
        deliver();
        return undefined;
      },
    );
    let candidate: StoredCandidate;
    try {
      candidate = staged = this.#prepare(raw, expected);
    } catch (error) {
      publication.retire();
      throw error;
    }
    const isPublished = () => candidate.phase === "published";
    return Object.freeze({
      discard: () => {
        if (candidate.phase !== "published") candidate.phase = "discarded";
        publication.retire();
        this.#cleanupCandidate(candidate.custody);
      },
      publish: (): PublicationOutcome => {
        if (candidate.phase !== "prepared") throw new StoredConfigConflict();
        candidate.phase = "publishing";
        let failed = false,
          failure: unknown,
          installed = false,
          warning = false;
        try {
          // Bind and capture the native delivery inputs before any final checks.
          const snapshot = candidate.snapshot;
          deliver = () => this.#deliverCandidate(candidate, true);
          publish(undefined);
          // Delivery is complete. Installation/receipt handling cannot grant
          // another write and must survive this operation's self-revocation.
          candidate.phase = "published";
          try {
            installed = install(snapshot) === undefined;
          } catch {
            installed = false;
          }
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          publication.retire();
        }
        try {
          this.#cleanupCandidate(candidate.custody);
        } catch (error) {
          warning = true;
          failure = failed
            ? new AggregateError(
              [failure, error],
              "Stored publication and cleanup failed.",
              { cause: failure },
            )
            : error;
          failed = true;
        }
        if (!isPublished()) {
          candidate.phase = "discarded";
          if (failed) throw failure;
          throw new StoredConfigConflict();
        }
        try {
          // Directory confirmation is attempted even after failed candidate cleanup.
          syncOwnedStoredDirectory(
            path.dirname(candidate.snapshot.binding.target),
            this.root,
          );
        } catch {
          warning = true;
        }
        if (warning) warnStoredDurability();
        return Object.freeze({
          operation: lease.identity,
          committed: true,
          state: installed ? "committed" : "recovery-required",
          warning: warning ? "stored-durability-unconfirmed" : null,
          notificationFailed: false,
        });
      },
    });
  }

  /** Compatibility entry: same writer and commit point, explicit storage-only
   * lease. It does not fabricate request authority for legacy callers. */
  replace(
    raw: string,
    expected = this.capture(),
    committed?: (snapshot: StoredConfigSnapshot) => void,
  ): void {
    if (committed) synchronous(committed);
    // The legacy lane has no external authority witness. Candidate publication
    // still performs the existing exact CAS, then atomic no-clobber link. Do not
    // insert another capture between that CAS and link or change its error lane.
    const owner = createOperationLease("live", [() => undefined]);
    try {
      const outcome = this.#preparePublication(
        raw,
        expected,
        owner.lease,
        (snapshot) => {
          const result: unknown = committed?.(snapshot);
          if (
            result != null &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            throw new TypeError(
              "Publication installation must be synchronous.",
            );
          }
          return undefined;
        },
      ).publish();
      if (
        outcome.state === "recovery-required"
      ) throw new PublicationRecoveryRequired(outcome);
    } finally {
      owner.retire();
    }
  }
}
