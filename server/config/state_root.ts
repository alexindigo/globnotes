// SPDX-License-Identifier: LGPL-3.0-only
import { basename, dirname, join, resolve } from "@std/path";

export class StateRootError extends Error {
  constructor(directory: string, action: string, options?: ErrorOptions) {
    super(
      `Cannot ${action}: directory "${directory}" must grant the server user read and search (r+x) permission and support directory fsync.`,
      options,
    );
  }
}
/** Resolve directory aliases without requiring read access to their ancestors. */
export function physicalStateRoot(root: string): string {
  let current = resolve(root);
  const tail: string[] = [];
  while (true) {
    try {
      return join(Deno.realPathSync(current), ...tail);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}
export function openStateDirectory(directory: string): Deno.FsFile {
  try {
    const handle = Deno.openSync(directory, { read: true });
    if (!handle.statSync().isDirectory) {
      handle.close();
      throw new Error("Not a directory");
    }
    return handle;
  } catch (cause) {
    throw new StateRootError(directory, "initialize state storage", { cause });
  }
}
export function preflightStateRoot(root: string): void {
  const handle = openStateDirectory(root);
  try {
    handle.syncSync();
  } catch (cause) {
    throw new StateRootError(root, "confirm state-root durability", { cause });
  } finally {
    handle.close();
  }
}
