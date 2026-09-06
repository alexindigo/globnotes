// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin manifest parsing and capability → Deno Worker permission
 * mapping. Mirrors the plan's manifest contract:
 *
 *   <vault>/.globnotes/plugins/<id>/manifest.json
 *   { id, name, version, author, source, license, entry, capabilities }
 *
 * Capabilities map directly onto the Worker's permission envelope;
 * defaults are the tightest envelope that still lets a renderer work.
 */

import * as path from "@std/path";

export interface PluginCapabilities {
  /** Network access: false (default) or a list of hosts. */
  network: boolean | string[];
  /** Write paths (absolute or relative to vault). Default: none. */
  write: string[];
  /** Read paths. "vault" expands to the vault root. Default: ["vault"]. */
  read: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  source?: string;
  license?: string;
  entry: string;
  /** Editor-half entry filename (dual-mode contract). Overridable via
   * manifest.json `"client": { "entry": "..." }`; defaults to the
   * Obsidian-style `client.js`. The file's presence (stat) decides whether
   * the plugin is dual-mode — absence is the normal single-mode case. */
  clientEntry: string;
  capabilities: PluginCapabilities;
  /** Absolute path to the plugin directory. */
  dir: string;
}

const DEFAULT_CAPABILITIES: PluginCapabilities = {
  network: false,
  write: [],
  read: ["vault"],
};

/** Read + validate a manifest.json inside a plugin directory. Throws
 * Error with a human-readable message on any problem. */
export function readManifest(dir: string): PluginManifest {
  const manifestPath = path.join(dir, "manifest.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Deno.readTextFileSync(manifestPath));
  } catch (e) {
    throw new Error(`cannot read manifest at ${manifestPath}: ${e}`);
  }
  const dirName = path.basename(dir);
  const id = raw.id as string | undefined;
  if (!id || typeof id !== "string") {
    throw new Error(`manifest at ${manifestPath} has no valid "id"`);
  }
  if (id !== dirName) {
    throw new Error(
      `manifest id '${id}' does not match directory name '${dirName}'`,
    );
  }
  const entry = (raw.entry as string | undefined) ?? "main.js";
  // Dual-mode contract: the editor-half entry. Basename-only so a
  // vault-writable manifest cannot point the client endpoint outside the
  // plugin directory.
  const clientEntry = path.basename(
    ((raw.client as { entry?: string } | undefined)?.entry as string) ??
      "client.js",
  );
  const caps = (raw.capabilities ?? {}) as Partial<PluginCapabilities>;
  const capabilities: PluginCapabilities = {
    network: caps.network ?? DEFAULT_CAPABILITIES.network,
    write: caps.write ?? DEFAULT_CAPABILITIES.write,
    read: caps.read ?? DEFAULT_CAPABILITIES.read,
  };
  const entryPath = path.join(dir, entry);
  try {
    if (!Deno.statSync(entryPath).isFile) throw new Error("not a file");
  } catch {
    throw new Error(`entry '${entry}' not found in ${dir}`);
  }
  return {
    id,
    name: (raw.name as string | undefined) ?? id,
    version: (raw.version as string | undefined) ?? "0.0.0",
    author: raw.author as string | undefined,
    source: raw.source as string | undefined,
    license: raw.license as string | undefined,
    entry,
    clientEntry,
    capabilities,
    dir,
  };
}

/** Resolve "vault" and relative read/write paths against the vault root;
 * everything maps onto the Deno Worker permissions shape.
 *
 * `import` follows the network capability: Deno's import permission is
 * host-scoped (local file imports are always allowed — that's how the
 * plugin entry itself loads), so it only gates remote module fetching,
 * which is exactly the network capability's job. */
export function workerPermissions(
  manifest: PluginManifest,
  vaultPath: string,
): Deno.PermissionOptions {
  const resolvePaths = (paths: string[]): string[] =>
    paths.map((p) => p === "vault" ? vaultPath : path.resolve(vaultPath, p));
  const net = manifest.capabilities.network;
  // Dynamic import requires read access on the file when read is a
  // list — internal plugins (outside the vault) need their own dir
  // explicitly; vault plugins get it via "vault" but listing it is
  // harmless either way.
  const readPaths = [
    ...new Set([manifest.dir, ...resolvePaths(manifest.capabilities.read)]),
  ];
  return {
    net: net === false ? false : net === true ? true : net,
    import: net === false ? false : net === true ? true : net,
    read: readPaths,
    write: resolvePaths(manifest.capabilities.write),
    env: false,
    ffi: false,
    run: false,
    sys: false,
  } as unknown as Deno.PermissionOptions;
}

/** Enumerate plugin directories directly under the given root. */
export function discoverPluginDirs(root: string): string[] {
  try {
    const dirs: string[] = [];
    for (const entry of Deno.readDirSync(root)) {
      if (entry.isDirectory) dirs.push(path.join(root, entry.name));
    }
    return dirs.sort();
  } catch {
    return [];
  }
}
