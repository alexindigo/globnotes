// SPDX-License-Identifier: LGPL-3.0-only
import { resolveReadableInRoot } from "../helpers.ts";
import { within } from "./paths.ts";
import type { ChangeEntry } from "./types.ts";

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
      const resolved = resolveReadableInRoot(root, name);
      return !within(stateRoot, resolved);
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
