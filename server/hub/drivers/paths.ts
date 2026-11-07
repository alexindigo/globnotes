// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import { isStagingName } from "../effects.ts";
import { pathKey, within } from "../paths.ts";
import type { VaultHub } from "../hub.ts";

/** Drivers see all regular vault files, including dotfiles, but never host state. */
export function driverTarget(hub: VaultHub, name: string): string {
  const parts = name.split("/");
  if (
    !name || new TextEncoder().encode(name).length > 4096 ||
    name.includes("\\") || name.includes("\0") ||
    parts.some((part) =>
      !part || part === "." || part === ".." || isStagingName(part)
    )
  ) throw new TypeError("invalid_path");
  const full = path.join(hub.root, ...parts);
  if (!within(hub.root, full) || within(hub.stateRoot, full)) {
    throw new TypeError("invalid_path");
  }
  let directory = hub.root;
  for (let i = 0; i < parts.length; i++) {
    try {
      for (const entry of Deno.readDirSync(directory)) {
        if (
          pathKey(entry.name) === pathKey(parts[i]) && entry.name !== parts[i]
        ) throw new TypeError("name_collision");
      }
      directory = path.join(directory, parts[i]);
      const info = Deno.lstatSync(directory);
      if (
        info.isSymlink ||
        (i === parts.length - 1 ? !info.isFile : !info.isDirectory)
      ) throw new TypeError("invalid_kind");
      if (within(hub.stateRoot, Deno.realPathSync(directory))) {
        throw new TypeError("invalid_path");
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) break;
      throw error;
    }
  }
  return full;
}
