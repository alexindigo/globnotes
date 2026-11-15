// SPDX-License-Identifier: LGPL-3.0-only
/** Installed bytes/topology, shared by inventory and synchronous final fences. */
import { createHash } from "node:crypto";
import * as path from "@std/path";
import { PluginContractError } from "./contracts.ts";
import { type ManifestSource, pluginCodePath } from "./manifest.ts";

export const sourceDigest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export interface InstalledSource extends ManifestSource {
  root: string;
  fingerprint: string;
  identity: string;
}

export function installedSource(dir: string): InstalledSource {
  const root = Deno.realPathSync(dir);
  const rows: { path: string; hash: string; target?: string }[] = [];
  const files = new Set<string>(), directories = new Set<string>();
  const directoryLinks: { path: string; target: string }[] = [];
  const visited = new Set<string>();
  let manifestText: string | undefined;
  function visit(relative = "") {
    const directory = relative ? pluginCodePath(root, relative) : root;
    if (visited.has(directory)) {
      throw new PluginContractError(
        409,
        "permission_source_invalid",
        "plugin code contains a directory cycle",
      );
    }
    visited.add(directory);
    for (
      const entry of [...Deno.readDirSync(directory)].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    ) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = pluginCodePath(root, name), info = Deno.statSync(file);
      if (info.isDirectory) {
        directories.add(name);
        if (entry.isSymlink) {
          directoryLinks.push({
            path: name,
            target: Deno.readLinkSync(path.join(root, name)),
          });
        }
        visit(name);
      } else if (info.isFile) {
        const bytes = Deno.readFileSync(file);
        files.add(name);
        if (name === "manifest.json") {
          manifestText = new TextDecoder().decode(bytes);
        }
        rows.push({
          path: name,
          hash: sourceDigest(bytes),
          ...(entry.isSymlink
            ? { target: Deno.readLinkSync(path.join(root, name)) }
            : {}),
        });
      } else {
        throw new PluginContractError(
          409,
          "permission_source_invalid",
          "plugin code contains an unsupported entry",
        );
      }
    }
    visited.delete(directory);
  }
  visit();
  // Keep the published code digest compatible. Empty directories and the selected
  // canonical root additionally affect discovery, not the historical code hash.
  const fingerprint = sourceDigest(JSON.stringify(rows));
  return {
    root,
    fingerprint,
    files,
    directories,
    manifestText,
    identity: sourceDigest(
      JSON.stringify({
        root,
        fingerprint,
        directories: [...directories],
        directoryLinks,
      }),
    ),
  };
}

export function installedSettingsFingerprint(dir: string): string {
  return installedSource(dir).fingerprint;
}
