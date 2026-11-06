// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The only owner of filesystem mutations on vault folders and on plugin-granted
 * external roots (docs/hub.md "Write gate"). A target inside a vault needs a
 * live gate pass naming it; only the hub gate opens passes (server/hub/gate.ts),
 * and only for the synchronous effect of a checked write. Every effect is
 * journaled for the hub's record. Staging files carry a reserved name the
 * scanner never reports.
 */

import * as path from "@std/path";
import { createUuid } from "../../shared/uuid.ts";
import { within } from "./paths.ts";

export interface StorageEffect {
  kind: "write" | "rename" | "remove" | "mkdir";
  path: string;
  oldPath?: string;
}

export interface Displacement {
  kind: "replace" | "delete" | "move";
  file: string;
  destination?: string;
}

/** Reserved basename prefix of gate staging files (hub/scanner.ts skips it). */
export const STAGING_PREFIX = ".globnotes-staging-";
export const isStagingName = (name: string): boolean =>
  path.basename(name).startsWith(STAGING_PREFIX);

/** A vault effect was attempted outside the hub gate. */
export class UngatedVaultWrite extends Error {
  constructor(readonly target: string) {
    super(`Vault write outside the hub gate: '${target}'`);
    this.name = "UngatedVaultWrite";
  }
}

interface Pass {
  roots: string[];
  journal: StorageEffect[];
  capture?: (displacements: Displacement[]) => () => void;
}
let active: Pass | null = null;

/** Real path of the nearest existing ancestor plus the missing rest. */
export function canonicalLoose(target: string): string {
  const resolved = path.resolve(target);
  try {
    return Deno.realPathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonicalLoose(parent), path.basename(resolved));
  }
}

/** Whether a gate pass is open (test fixtures that write raw storage). */
export function gatePassActive(): boolean {
  return active !== null;
}

/** Open a pass for `paths` (and everything below them) for the duration of
 * the synchronous `effect`. Owner: server/hub/gate.ts (contract rule
 * `single-vault-writer`). Effects are appended to `journal`. */
export function withGatePass<T>(
  paths: readonly string[],
  journal: StorageEffect[],
  effect: () => T,
  capture?: Pass["capture"],
): T {
  if (active) throw new Error("Nested hub gate pass");
  active = { roots: paths.map(canonicalLoose), journal, capture };
  try {
    const result = effect();
    if (result instanceof Promise) {
      throw new Error("Hub gate effects must be synchronous");
    }
    return result;
  } finally {
    active = null;
  }
}

/** Filesystem effects for one vault root. Targets outside the vault (granted
 * external roots) need no pass; targets inside it need a live pass. */
export class VaultEffects {
  readonly #roots: string[];
  constructor(vaultRoot: string) {
    this.#roots = [
      ...new Set([path.resolve(vaultRoot), canonicalLoose(vaultRoot)]),
    ];
  }

  /** Whether `target` lies inside this vault (either root spelling). */
  inVault(target: string): boolean {
    const resolved = path.resolve(target), canonical = canonicalLoose(target);
    return this.#roots.some((root) =>
      within(root, resolved) || within(root, canonical)
    );
  }

  /** A directory effect is also admitted on the route to a covered path:
   * creating a covered file's missing parents, pruning its emptied ones. */
  #admit(target: string, directory = false): void {
    if (!this.inVault(target)) return;
    const canonical = canonicalLoose(target);
    if (
      !active?.roots.some((root) =>
        within(root, canonical) || (directory && within(canonical, root))
      )
    ) throw new UngatedVaultWrite(target);
  }
  #record(effect: StorageEffect): void {
    active?.journal.push(effect);
  }

  /** Create-exclusive write. */
  writeNew(file: string, data: string | Uint8Array): void {
    this.#admit(file);
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data;
    const handle = Deno.openSync(file, { write: true, createNew: true });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += handle.writeSync(bytes.subarray(offset));
      }
    } finally {
      handle.close();
      this.#record({ kind: "write", path: file });
    }
  }
  /** In-place replacement (the existing note and file-write mechanics). */
  replace(file: string, data: string | Uint8Array): void {
    this.#admit(file);
    const committed = active?.capture?.([{ kind: "replace", file }]);
    try {
      if (typeof data === "string") Deno.writeTextFileSync(file, data);
      else Deno.writeFileSync(file, data);
    } finally {
      this.#record({ kind: "write", path: file });
      committed?.(); // An in-place write may have partially displaced bytes.
    }
  }
  mkdir(directory: string): void {
    this.#admit(directory, true);
    Deno.mkdirSync(directory);
    this.#record({ kind: "mkdir", path: directory });
  }
  /** Create every missing parent of `file`, journaling each. */
  mkdirParents(file: string): void {
    const missing: string[] = [];
    let parent = path.dirname(file);
    while (true) {
      try {
        Deno.statSync(parent);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      missing.unshift(parent);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    for (const directory of missing) this.mkdir(directory);
  }
  /** Move without replacing: the destination must be absent. */
  move(from: string, to: string): void {
    this.#admit(from);
    this.#admit(to);
    let occupied = false;
    try {
      Deno.lstatSync(to);
      occupied = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (occupied) {
      throw new Deno.errors.AlreadyExists(`'${to}' already exists`);
    }
    const committed = active?.capture?.([{
      kind: "move",
      file: from,
      destination: to,
    }]);
    Deno.renameSync(from, to);
    this.#record({ kind: "rename", path: to, oldPath: from });
    committed?.();
  }
  /** Move that replaces an existing destination file the gate checked. */
  replaceByMove(from: string, to: string): void {
    this.#admit(from);
    this.#admit(to);
    const committed = active?.capture?.([
      { kind: "move", file: from, destination: to },
      { kind: "replace", file: to },
    ]);
    Deno.renameSync(from, to);
    this.#record({ kind: "rename", path: to, oldPath: from });
    committed?.();
  }
  remove(file: string): void {
    this.#admit(file);
    const committed = active?.capture?.([{ kind: "delete", file }]);
    Deno.removeSync(file);
    this.#record({ kind: "remove", path: file });
    committed?.();
  }
  /** Remove an empty directory (pruning). */
  removeEmptyDirectory(directory: string): void {
    this.#admit(directory, true);
    Deno.removeSync(directory);
    this.#record({ kind: "remove", path: directory });
  }
  /** A new staging file in `directory` (reserved name, mode 0600). Needs no
   * pass: staging is not vault content and is never reported. */
  async stage(directory: string): Promise<{ path: string; file: Deno.FsFile }> {
    const staging = path.join(directory, `${STAGING_PREFIX}${createUuid()}`);
    const file = await Deno.open(staging, {
      read: true,
      write: true,
      createNew: true,
      mode: 0o600,
    });
    return { path: staging, file };
  }
  /** Publish a staging file onto `target` (replacing it when present). */
  publish(staging: string, target: string): void {
    if (!isStagingName(staging)) throw new Error("not a staging file");
    this.#admit(target);
    const committed = active?.capture?.([{ kind: "replace", file: target }]);
    Deno.renameSync(staging, target);
    this.#record({ kind: "write", path: target });
    committed?.();
  }
  /** Remove a leftover staging file. */
  discard(staging: string): void {
    if (!isStagingName(staging)) throw new Error("not a staging file");
    Deno.removeSync(staging);
  }
}
