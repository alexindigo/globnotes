// SPDX-License-Identifier: LGPL-3.0-only
import { resolveReadableInRoot } from "../helpers.ts";
import * as path from "@std/path";
import { within } from "./paths.ts";
import type { ChangeEntry } from "./types.ts";

/** The shared browser read namespace, including missing event targets. A
 * configured root alias is allowed; no descendant symlink is a readable member. */
export function readableVaultPath(
  root: string,
  stateRoot: string,
  name: string | null,
): string | null {
  if (!name) return null;
  let resolved: string;
  try {
    resolved = resolveReadableInRoot(root, name);
  } catch {
    return null;
  }
  if (within(stateRoot, resolved)) return null;
  let current = Deno.realPathSync(root);
  const components = name.split("/");
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    try {
      const info = Deno.lstatSync(current);
      if (info.isSymlink || (index === components.length - 1 && !info.isFile)) {
        return null;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) break;
      throw error;
    }
  }
  return resolved;
}

/** Project the hub (which deliberately inventories hidden files) through the
 * ordinary notes/files read namespace. Never disclose state or anonymous keys.
 * Missing final paths are valid here: live deletion/rename notices need them. */
export function browserChange(
  entry: ChangeEntry,
  root: string,
  stateRoot: string,
) {
  const visible = (name: string | null) => {
    if (!name) return false;
    try {
      return readableVaultPath(root, stateRoot, name) !== null;
    } catch {
      return false;
    }
  };
  const pathVisible = visible(entry.path), oldVisible = visible(entry.oldPath);
  if (!pathVisible && !oldVisible) return null;
  return {
    seq: entry.seq,
    path: pathVisible ? entry.path! : entry.oldPath!,
    kind: !pathVisible
      ? "deleted"
      : entry.kind === "renamed" && !oldVisible
      ? "created"
      : entry.kind,
    ...(pathVisible && oldVisible ? { oldPath: entry.oldPath! } : {}),
    ...(pathVisible && entry.afterHash ? { hash: entry.afterHash } : {}),
    peer: entry.peer,
  };
}
