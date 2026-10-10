// SPDX-License-Identifier: LGPL-3.0-only
/** Completion IO for auxiliary files. No actions, notes, hooks or feature policy. */
import { createHash } from "node:crypto";
import * as path from "@std/path";
import {
  FS_LIMITS,
  type FsEffect,
  FsError,
  type FsExpect,
  type FsStat,
  type JsonValues,
} from "./contracts.ts";
import type { RpcAuthority } from "./host.ts";
import { AsyncLock } from "./lifecycle.ts";
import type { FilesystemGrant, PluginManifest } from "./manifest.ts";
import { sourceDigest } from "./settings_environment.ts";

export interface FsSettingsLease {
  sourceKey?: string;
  codeFingerprint?: string;
  values: Record<string, JsonValues>;
  assertCurrent(): void;
}
export interface AuxiliaryFsAdapters {
  vaultPath: string;
  statePath: string;
  operational(): boolean;
  writable(): boolean;
  settings(manifest: PluginManifest): FsSettingsLease;
  commit<T>(effect: () => T | Promise<T>): Promise<T>;
  /** Host-only preparation seam; production has no extra task/authority surface. */
  prepare?(): Promise<void>;
}
interface NodeIdentity {
  location: string;
  dev?: number;
  ino?: number | null;
  mode?: number | null;
  kind: string;
  link?: string;
}
interface Binding {
  canonical: string;
  nodes: NodeIdentity[];
  invalidTraversal: boolean;
  directoryRequired: boolean;
}
interface Observation {
  stat: FsStat | null;
  binding: Binding;
}
const mutations = new Set(["writeFile", "rename", "remove", "mkdir"]);
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.SEPARATOR}`) &&
      !path.isAbsolute(relative));
}
function validPath(value: unknown): string {
  if (
    typeof value !== "string" || !value || value.length > FS_LIMITS.pathBytes ||
    value.includes("\0")
  ) throw new FsError("fs_invalid_path");
  const bytes = new TextEncoder().encode(value);
  if (
    bytes.length > FS_LIMITS.pathBytes ||
    new TextDecoder().decode(bytes) !== value
  ) throw new FsError("fs_invalid_path");
  return value;
}
/** A terminal separator is a directory traversal, including inside link targets. */
function traversalParts(input: string): string[] {
  const parts = input.split("/").filter(Boolean);
  if (input.endsWith("/")) parts.push(".");
  return parts;
}
/** Preserve link traversal and its .. semantics; NotFound alone is absence. */
function resolveBinding(input: string): Binding {
  const root = path.parse(input).root;
  if (!root) throw new FsError("fs_invalid_path");
  let current = root,
    links = 0,
    steps = 0,
    missing = false,
    invalidTraversal = false,
    directoryRequired = input.endsWith("/");
  let remaining = traversalParts(input.slice(root.length));
  const nodes = new Map<string, NodeIdentity>();
  while (remaining.length) {
    if (++steps > FS_LIMITS.pathBytes) throw new FsError("fs_invalid_path");
    const component = remaining.shift()!;
    if (component === ".") {
      if (!remaining.length) directoryRequired = true;
      continue;
    }
    if (component === "..") {
      if (missing) invalidTraversal = true;
      if (!remaining.length) directoryRequired = true;
      current = path.dirname(current);
      continue;
    }
    const location = path.join(current, component);
    let info: Deno.FileInfo | null;
    try {
      info = Deno.lstatSync(location);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      info = null;
    }
    if (!info) missing = true;
    const node: NodeIdentity = info
      ? {
        location,
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        kind: info.isSymlink
          ? "link"
          : info.isDirectory
          ? "directory"
          : info.isFile
          ? "file"
          : "unsupported",
        ...(info.isSymlink ? { link: Deno.readLinkSync(location) } : {}),
      }
      : { location, kind: "absent" };
    nodes.set(location, node);
    if (node.kind === "unsupported") throw new FsError("fs_denied");
    if (node.kind === "link") {
      if (++links > 40) throw new FsError("fs_denied");
      const link = node.link!, linkRoot = path.parse(link).root;
      if (linkRoot) current = linkRoot;
      remaining = [
        ...traversalParts(link.slice(linkRoot.length)),
        ...remaining,
      ];
    } else {
      if (remaining.length && info && !info.isDirectory) {
        throw new FsError("fs_denied");
      }
      current = location;
    }
  }
  // Root arguments have no components; capture their directory identity too.
  if (!nodes.has(current)) {
    const info = Deno.statSync(current);
    nodes.set(current, {
      location: current,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      kind: info.isDirectory
        ? "directory"
        : info.isFile
        ? "file"
        : "unsupported",
    });
  }
  return {
    canonical: current,
    nodes: [...nodes.values()],
    invalidTraversal,
    directoryRequired,
  };
}
function fileHash(file: string, deadline: number): string {
  const digest = createHash("sha256"),
    handle = Deno.openSync(file, { read: true }),
    chunk = new Uint8Array(64 * 1024);
  try {
    let count;
    while (true) {
      if (Date.now() >= deadline) throw new FsError("fs_deadline");
      count = handle.readSync(chunk);
      if (count === null) break;
      digest.update(chunk.subarray(0, count));
    }
  } finally {
    handle.close();
  }
  return digest.digest("hex");
}
function ownedHandleHash(handle: Deno.FsFile, deadline: number): string {
  handle.seekSync(0, Deno.SeekMode.Start);
  const digest = createHash("sha256"), chunk = new Uint8Array(64 * 1024);
  let total = 0;
  while (true) {
    if (Date.now() >= deadline) throw new FsError("fs_deadline");
    const count = handle.readSync(chunk);
    if (count === null) break;
    total += count;
    if (total > FS_LIMITS.bodyBytes) throw new FsError("fs_conflict");
    digest.update(chunk.subarray(0, count));
  }
  return digest.digest("hex");
}
function sameTemporary(info: Deno.FileInfo, owned: Deno.FileInfo): boolean {
  return info.isFile && !info.isSymlink && owned.ino !== null &&
    info.ino === owned.ino && info.dev === owned.dev;
}
function options(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FsError("fs_invalid_path");
  }
  const result = { ...value } as Record<string, unknown>;
  if (
    Object.keys(result).some((key) =>
      !["sourceKey", ...allowed].includes(key)
    ) ||
    (result.sourceKey !== undefined && typeof result.sourceKey !== "string")
  ) throw new FsError("fs_invalid_path");
  return result;
}
function expect(value: unknown, exactOnly = false): FsExpect {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FsError("fs_conflict");
  }
  const raw = value as Record<string, unknown>;
  if (!exactOnly && raw.kind === "absent" && Object.keys(raw).length === 1) {
    return { kind: "absent" };
  }
  if (
    raw.kind === "exact" && typeof raw.token === "string" &&
    raw.token.length === 64 && Object.keys(raw).length === 2
  ) return { kind: "exact", token: raw.token };
  throw new FsError("fs_conflict");
}
function token(value: unknown): string {
  const parsed = expect({ kind: "exact", token: value }, true);
  if (parsed.kind !== "exact") throw new FsError("fs_conflict");
  return parsed.token;
}
function condition(stat: FsStat | null, expected: FsExpect): void {
  if (
    expected.kind === "absent" ? stat !== null : stat?.token !== expected.token
  ) throw new FsError("fs_conflict");
}
export class AuxiliaryFilesystem {
  readonly #writer = new AsyncLock();
  readonly #generations = new WeakMap<
    Promise<void>,
    { jobs: Set<() => void>; retired: boolean }
  >();
  constructor(private readonly adapters: AuxiliaryFsAdapters) {}

  rpc(
    manifest: PluginManifest,
    method: string,
    input: unknown[],
    authority: RpcAuthority,
  ): Promise<unknown> {
    const operation = method.slice(3), mutating = mutations.has(operation);
    if (
      !new Set(["stat", "realPath", "readFile", ...mutations]).has(operation)
    ) return Promise.reject(new FsError("fs_denied"));
    let generation = this.#generations.get(authority.generationRetired);
    if (!generation) {
      generation = { jobs: new Set(), retired: false };
      this.#generations.set(authority.generationRetired, generation);
      const captured = generation;
      authority.generationRetired.then(() => {
        captured.retired = true;
        for (const abort of [...captured.jobs]) abort();
      });
    }
    if (generation.jobs.size >= FS_LIMITS.outstanding) {
      return Promise.reject(new FsError("fs_busy"));
    }
    if (generation.retired || !authority.current()) {
      return Promise.reject(new FsError("fs_generation_revoked"));
    }
    let effect: FsEffect = "none", expired = false;
    const deadline = Date.now() + FS_LIMITS.deadlineMs;
    const stopped = Promise.withResolvers<never>();
    const abort = () =>
      stopped.reject(new FsError("fs_generation_revoked", effect));
    generation.jobs.add(abort);
    const timer = setTimeout(() => {
      expired = true;
      stopped.reject(new FsError("fs_deadline", effect));
    }, FS_LIMITS.deadlineMs);
    let args: unknown[],
      lease: FsSettingsLease,
      configured: Record<string, unknown>;
    try {
      // Copy arguments and bytes before any await, including shared backing memory.
      validPath(input[0]);
      if (operation === "writeFile") {
        if (
          !(input[1] instanceof Uint8Array) ||
          input[1].byteLength > FS_LIMITS.bodyBytes
        ) throw new FsError("fs_too_large");
        args = [input[0], new Uint8Array(input[1])];
        configured = options(input[2], ["expect"]);
        configured.expect = expect(configured.expect);
      } else if (operation === "rename") {
        validPath(input[1]);
        args = [input[0], input[1]];
        configured = options(input[2], ["sourceToken", "destination"]);
        configured.sourceToken = token(configured.sourceToken);
        configured.destination = expect(configured.destination);
      } else {
        args = [input[0]];
        configured = options(
          input[1],
          operation === "stat"
            ? []
            : operation === "remove"
            ? ["token"]
            : operation === "mkdir"
            ? ["recursive", "expect"]
            : ["expect"],
        );
        if (operation === "remove") configured.token = token(configured.token);
        if (configured.expect !== undefined) {
          configured.expect = expect(configured.expect, operation !== "mkdir");
        }
        if (
          configured.recursive !== undefined &&
          typeof configured.recursive !== "boolean"
        ) throw new FsError("fs_invalid_path");
      }
      if (
        authority.role !== "service" || !this.adapters.operational() ||
        (mutating && (authority.pre || !this.adapters.writable()))
      ) throw new FsError("fs_denied");
      lease = this.adapters.settings(manifest);
      const selected = configured.sourceKey ?? authority.source?.key;
      if (
        !lease.sourceKey || selected !== lease.sourceKey ||
        !lease.codeFingerprint ||
        authority.source?.codeFingerprint !== lease.codeFingerprint
      ) throw new FsError("fs_source_changed");
    } catch (error) {
      clearTimeout(timer);
      generation.jobs.delete(abort);
      return Promise.reject(
        error instanceof FsError ? error : new FsError("fs_source_changed"),
      );
    }
    const assertCurrent = () => {
      if (expired || Date.now() >= deadline) {
        throw new FsError("fs_deadline", effect);
      }
      if (!authority.current() || generation!.retired) {
        throw new FsError("fs_generation_revoked", effect);
      }
      if (
        !this.adapters.operational() ||
        (mutating && (!this.adapters.writable() || authority.pre))
      ) throw new FsError("fs_denied", effect);
      try {
        lease.assertCurrent();
      } catch {
        throw new FsError("fs_source_changed", effect);
      }
    };
    let vault: Binding, state: Binding;
    try {
      vault = resolveBinding(path.resolve(this.adapters.vaultPath));
      state = resolveBinding(path.resolve(this.adapters.statePath));
    } catch {
      clearTimeout(timer);
      generation.jobs.delete(abort);
      return Promise.reject(new FsError("fs_denied"));
    }
    const rooted = (target: string) =>
      path.isAbsolute(target) ? target : vault.canonical + "/" + target;
    const grants = (kind: "read" | "write"): Binding[] =>
      (manifest.capabilities.filesystem?.[kind] ?? []).flatMap(
        (grant: FilesystemGrant) => {
          let value: string;
          if (typeof grant === "string") {
            value = grant === "vault" ? vault.canonical : grant;
          } else {
            const setting = lease.values[grant.settings.page]
              ?.[grant.settings.key];
            if (typeof setting !== "string") throw new FsError("fs_denied");
            if (setting === "") return [];
            value = setting;
          }
          const binding = resolveBinding(rooted(validPath(value)));
          if (binding.invalidTraversal) throw new FsError("fs_denied");
          if (binding.canonical === "/") throw new FsError("fs_denied");
          return [binding];
        },
      );
    let roots: Binding[];
    try {
      roots = grants(mutating ? "write" : "read");
    } catch (error) {
      clearTimeout(timer);
      generation.jobs.delete(abort);
      return Promise.reject(
        error instanceof FsError ? error : new FsError("fs_denied"),
      );
    }
    const witnesses = new Set<number>();
    const observe = (target: string): Observation => {
      const binding = resolveBinding(rooted(target));
      const candidates = roots.map((root, index) => ({ root, index })).filter((
        { root },
      ) => inside(root.canonical, binding.canonical)).sort((a, b) =>
        Number(b.root.canonical === vault.canonical) -
          Number(a.root.canonical === vault.canonical) ||
        a.root.nodes.length - b.root.nodes.length
      );
      if (!candidates.length || inside(state.canonical, binding.canonical)) {
        throw new FsError("fs_denied");
      }
      witnesses.add(candidates[0].index);
      // The selected grant's root spelling can itself require a directory;
      // addressing its canonical name cannot erase that root constraint.
      const root = candidates[0].root;
      const directoryRequired = binding.directoryRequired ||
        (binding.canonical === root.canonical && root.directoryRequired);
      if (binding.invalidTraversal) {
        if (mutating) throw new FsError("fs_not_found");
        return { stat: null, binding };
      }
      if (mutating && operation !== "mkdir" && directoryRequired) {
        throw new FsError("fs_invalid_path");
      }
      if (
        mutating && inside(vault.canonical, binding.canonical) &&
        binding.canonical.endsWith(".md")
      ) throw new FsError("fs_denied");
      let info;
      try {
        info = Deno.statSync(binding.canonical);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return { stat: null, binding };
      }
      if (!info.isFile && !info.isDirectory) throw new FsError("fs_denied");
      if (directoryRequired && !info.isDirectory) {
        throw new FsError("fs_io_error");
      }
      if (operation === "readFile" && info.size > FS_LIMITS.bodyBytes) {
        throw new FsError("fs_too_large");
      }
      // A conditional observation describes filesystem identity, not alternative
      // authority grants. Grant/root witnesses are separately fenced by namespace().
      const stat: FsStat = {
        kind: info.isFile ? "file" : "directory",
        size: info.size,
        token: sourceDigest(JSON.stringify({
          plugin: manifest.id,
          requested: target,
          binding,
          vault,
          state,
          identity: {
            dev: info.dev,
            ino: info.ino,
            kind: info.isFile ? "file" : "directory",
            ...(info.isFile
              ? { hash: fileHash(binding.canonical, deadline), size: info.size }
              : {}),
          },
        })),
      };
      return { stat, binding };
    };
    const namespace = () => {
      const currentRoots = grants(mutating ? "write" : "read");
      if (
        JSON.stringify(
            resolveBinding(path.resolve(this.adapters.vaultPath)),
          ) !== JSON.stringify(vault) ||
        JSON.stringify(
            resolveBinding(path.resolve(this.adapters.statePath)),
          ) !== JSON.stringify(state) ||
        [...witnesses].some((index) =>
          JSON.stringify(currentRoots[index]) !== JSON.stringify(roots[index])
        )
      ) throw new FsError("fs_conflict");
    };
    let first: Observation, second: Observation | undefined;
    try {
      first = observe(args[0] as string);
      if (operation === "rename") second = observe(args[1] as string);
      assertCurrent();
    } catch (error) {
      clearTimeout(timer);
      generation.jobs.delete(abort);
      return Promise.reject(
        error instanceof FsError ? error : new FsError(
          error instanceof Deno.errors.PermissionDenied
            ? "fs_denied"
            : "fs_io_error",
        ),
      );
    }
    const run = async () => {
      assertCurrent();
      namespace();
      const target = args[0] as string;
      const fresh = observe(target);
      if (JSON.stringify(fresh.binding) !== JSON.stringify(first.binding)) {
        throw new FsError("fs_conflict");
      }
      if (!mutating) {
        if (configured.expect) {
          condition(fresh.stat, configured.expect as FsExpect);
        }
        if (fresh.stat?.token !== first.stat?.token) {
          throw new FsError("fs_conflict");
        }
        if (operation === "stat") {
          namespace();
          assertCurrent();
          return fresh.stat;
        }
        if (!fresh.stat) throw new FsError("fs_not_found");
        if (operation === "realPath") {
          namespace();
          assertCurrent();
          return fresh.binding.canonical;
        }
        if (fresh.stat.kind !== "file") throw new FsError("fs_denied");
        if (fresh.stat.size > FS_LIMITS.bodyBytes) {
          throw new FsError("fs_too_large");
        }
        const handle = Deno.openSync(fresh.binding.canonical, { read: true }),
          bytes = new Uint8Array(fresh.stat.size),
          extra = new Uint8Array(1);
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const count = handle.readSync(bytes.subarray(offset));
            if (count === null) throw new FsError("fs_conflict");
            offset += count;
          }
          if (handle.readSync(extra) !== null) throw new FsError("fs_conflict");
        } finally {
          handle.close();
        }
        condition(observe(target).stat, {
          kind: "exact",
          token: fresh.stat.token,
        });
        namespace();
        assertCurrent();
        return bytes;
      }
      let temporary: string | undefined;
      let temporaryHandle: Deno.FsFile | undefined,
        temporaryOwner: Deno.FileInfo | undefined,
        preparedHash: string | undefined;
      let result: unknown, failed = false, failure: unknown;
      try {
        if (operation === "writeFile") {
          condition(first.stat, configured.expect as FsExpect);
          if (first.stat?.kind === "directory") throw new FsError("fs_denied");
          const parent = path.dirname(first.binding.canonical);
          if (!Deno.statSync(parent).isDirectory) {
            throw new FsError("fs_denied");
          }
          temporary = path.join(parent, `.auxiliary-${crypto.randomUUID()}`);
          temporaryHandle = await Deno.open(temporary, {
            read: true,
            write: true,
            createNew: true,
            mode: 0o600,
          });
          temporaryOwner = temporaryHandle.statSync();
          if (!temporaryOwner.isFile || temporaryOwner.ino === null) {
            throw new FsError("fs_denied");
          }
          const bytes = args[1] as Uint8Array;
          preparedHash = sourceDigest(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            assertCurrent();
            const count = await temporaryHandle.write(bytes.subarray(offset));
            if (count <= 0) throw new FsError("fs_io_error");
            offset += count;
          }
          await temporaryHandle.sync();
        }
        result = await this.adapters.commit(() => {
          namespace();
          const current = observe(target);
          if (
            JSON.stringify(current.binding) !== JSON.stringify(first.binding)
          ) throw new FsError("fs_conflict");
          if (operation === "writeFile") {
            condition(current.stat, configured.expect as FsExpect);
            if (
              !sameTemporary(Deno.lstatSync(temporary!), temporaryOwner!) ||
              !sameTemporary(temporaryHandle!.statSync(), temporaryOwner!) ||
              ownedHandleHash(temporaryHandle!, deadline) !== preparedHash ||
              !sameTemporary(Deno.lstatSync(temporary!), temporaryOwner!)
            ) throw new FsError("fs_conflict");
            assertCurrent();
            effect = "unknown";
            Deno.renameSync(temporary!, current.binding.canonical);
            effect = "committed";
          } else if (operation === "rename") {
            const destination = args[1] as string,
              currentDestination = observe(destination);
            if (
              JSON.stringify(currentDestination.binding) !==
                JSON.stringify(second!.binding)
            ) throw new FsError("fs_conflict");
            condition(current.stat, {
              kind: "exact",
              token: configured.sourceToken as string,
            });
            condition(
              currentDestination.stat,
              configured.destination as FsExpect,
            );
            if (
              current.stat?.kind !== "file" ||
              currentDestination.stat?.kind === "directory"
            ) throw new FsError("fs_denied");
            assertCurrent();
            effect = "unknown";
            Deno.renameSync(
              current.binding.canonical,
              currentDestination.binding.canonical,
            );
            effect = "committed";
            return { token: observe(destination).stat!.token };
          } else if (operation === "remove") {
            condition(current.stat, {
              kind: "exact",
              token: configured.token as string,
            });
            if (current.stat?.kind !== "file") throw new FsError("fs_denied");
            assertCurrent();
            effect = "unknown";
            Deno.removeSync(current.binding.canonical);
            effect = "committed";
            return;
          } else {
            if (configured.expect) {
              condition(current.stat, configured.expect as FsExpect);
            }
            if (current.stat && current.stat.kind !== "directory") {
              throw new FsError("fs_denied");
            }
            if (!current.stat) {
              const missing: string[] = [];
              let parent = current.binding.canonical;
              while (true) {
                let info;
                try {
                  info = Deno.statSync(parent);
                } catch (error) {
                  if (!(error instanceof Deno.errors.NotFound)) throw error;
                }
                if (info) {
                  if (!info.isDirectory) throw new FsError("fs_denied");
                  break;
                }
                missing.unshift(parent);
                parent = path.dirname(parent);
              }
              if (!configured.recursive && missing.length > 1) {
                throw new FsError("fs_not_found");
              }
              for (const component of missing) observe(component); // All required mkdir effects authorized before first effect.
              for (const component of missing) {
                namespace();
                const prepared = observe(component);
                if (prepared.stat) throw new FsError("fs_conflict", effect);
                assertCurrent();
                effect = "unknown";
                Deno.mkdirSync(prepared.binding.canonical);
                effect = "committed";
                // Account for our own previously absent grant-root components.
                roots = grants("write");
              }
            }
            return observe(target).stat!;
          }
          return { token: observe(target).stat!.token };
        });
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (temporary && temporaryOwner) {
        try {
          if (!sameTemporary(Deno.lstatSync(temporary), temporaryOwner)) {
            throw new FsError("fs_conflict", effect);
          }
          Deno.removeSync(temporary);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            const combined = failed
              ? new AggregateError(
                [failure, error],
                "Auxiliary preparation and cleanup failed",
              )
              : error;
            failure = failure instanceof FsError
              ? Object.assign(new FsError(failure.code, effect), {
                cause: combined,
              })
              : combined;
            failed = true;
          }
        }
      }
      temporaryHandle?.close();
      if (failed) throw failure;
      return result;
    };
    const prepared = async () => {
      await this.adapters.prepare?.();
      return await run();
    };
    const running = (mutating ? this.#writer.run(prepared) : prepared()).catch(
      (error) => {
        if (error instanceof FsError) {
          throw new FsError(
            error.code,
            effect === "none" ? error.effect : effect,
          );
        }
        throw new FsError(
          error instanceof Deno.errors.PermissionDenied
            ? "fs_denied"
            : error instanceof Deno.errors.NotFound
            ? "fs_not_found"
            : "fs_io_error",
          effect,
        );
      },
    ).finally(() => {
      clearTimeout(timer);
      generation!.jobs.delete(abort);
    });
    return Promise.race([running, stopped.promise]);
  }
}
