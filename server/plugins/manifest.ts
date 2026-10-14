// SPDX-License-Identifier: LGPL-3.0-only

/** Strict manifest discovery. Entries are optional contributions of one plugin. */
import * as path from "@std/path";
import {
  HOOK_NAMES,
  type HookName,
  pluginId,
  record,
  type SettingsPage,
  text,
  uniqueStrings,
} from "./contracts.ts";
import { validateSettingsPages } from "./settings.ts";
import {
  canonicalScopes,
  type PermissionDeclaration,
} from "./network_contracts.ts";
import { delegableScopes, denoScopes } from "./network_permissions.ts";

export interface PluginCapabilities {
  filesystem?: { read: FilesystemGrant[]; write: FilesystemGrant[] };
  network: boolean | string[];
  /** Omission preserves legacy network-derived import intent, never consent. */
  imports?: boolean | string[];
  write: string[];
  read: string[];
}
export type FilesystemGrant = string | {
  settings: { page: string; key: string };
};
function filesystemGrants(
  value: unknown,
  settings: SettingsPage[],
): FilesystemGrant[] {
  if (!Array.isArray(value)) {
    throw new Error("filesystem grants must be an array");
  }
  return value.map((grant) => {
    if (typeof grant === "string") {
      if (!grant || grant.includes("\0") || grant === "/") {
        throw new Error("invalid filesystem root");
      }
      return grant;
    }
    const reference = record(grant, "filesystem settings reference");
    if (
      Object.keys(reference).length !== 1 ||
      !Object.hasOwn(reference, "settings")
    ) throw new Error("invalid filesystem settings reference");
    const field = record(reference.settings, "filesystem settings field");
    if (
      Object.keys(field).length !== 2 || typeof field.page !== "string" ||
      typeof field.key !== "string" || !Object.hasOwn(field, "page") ||
      !Object.hasOwn(field, "key")
    ) throw new Error("invalid filesystem settings field");
    const declaration = settings.find((page) => page.id === field.page)?.fields
      .find((candidate) => candidate.key === field.key);
    if (!declaration || declaration.type !== "folder") {
      throw new Error(
        "filesystem settings roots require the owning declared folder field",
      );
    }
    return { settings: { page: field.page, key: field.key } };
  });
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  source?: string;
  license?: string;
  /** Absent when no legacy rendering entry exists. */
  entry?: string;
  clientEntry: string;
  hasClient: boolean;
  runtime: { server?: string; client?: string };
  hooks: HookName[];
  settings: SettingsPage[];
  hasEndpoints: boolean;
  capabilities: PluginCapabilities;
  dir: string;
}

/** Resolve existing code below the plugin directory, including symlinks. */
export function pluginCodePath(dir: string, relative: string): string {
  const root = Deno.realPathSync(dir);
  const result = Deno.realPathSync(path.join(root, relative));
  const rel = path.relative(root, result);
  if (
    path.isAbsolute(rel) || rel === ".." ||
    rel.startsWith(`..${path.SEPARATOR}`)
  ) {
    throw new Error(`plugin code '${relative}' resolves outside its directory`);
  }
  return result;
}
function basename(value: unknown, label: string): string {
  const name = text(value, label);
  if (
    name === "." || name === ".." || name.startsWith(".") ||
    name.includes("/") || name.includes("\\") || name.includes("\0")
  ) {
    throw new Error(`${label} must be a basename module filename`);
  }
  if (!/\.(?:js|mjs|ts)$/.test(name)) {
    throw new Error(`${label} must be a module filename`);
  }
  return name;
}
function entryExists(dir: string, name: string, required: boolean): boolean {
  try {
    const file = pluginCodePath(dir, name);
    if (!Deno.statSync(file).isFile) {
      throw new Error(`entry '${name}' is not a file`);
    }
    return true;
  } catch (error) {
    if (!required && error instanceof Deno.errors.NotFound) return false;
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`entry '${name}' not found in ${dir}`);
    }
    throw error;
  }
}
function metadata(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  if (raw[key] === undefined) return undefined;
  return text(raw[key], key);
}

export function readManifest(dir: string): PluginManifest {
  const manifestPath = pluginCodePath(dir, "manifest.json");
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(Deno.readTextFileSync(manifestPath)), "manifest");
  } catch (error) {
    throw new Error(
      `cannot read manifest at ${manifestPath}: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }
  const id = pluginId(raw.id);
  const dirName = path.basename(dir);
  if (id !== dirName) {
    throw new Error(
      `manifest id '${id}' does not match directory name '${dirName}'`,
    );
  }
  const renderName = basename(
    raw.entry === undefined ? "main.js" : raw.entry,
    "entry",
  );
  const entry = entryExists(dir, renderName, raw.entry !== undefined)
    ? renderName
    : undefined;
  const client = raw.client === undefined ? {} : record(raw.client, "client");
  if (Object.keys(client).some((key) => key !== "entry")) {
    throw new Error("unsupported client manifest property");
  }
  const clientEntry = basename(
    client.entry === undefined ? "client.js" : client.entry,
    "client entry",
  );
  const hasClient = entryExists(dir, clientEntry, client.entry !== undefined);
  const runtimeInput = raw.runtime === undefined
    ? {}
    : record(raw.runtime, "runtime");
  if (
    Object.keys(runtimeInput).some((key) =>
      key !== "server" && key !== "client"
    )
  ) throw new Error("unsupported runtime manifest property");
  const runtime: PluginManifest["runtime"] = {};
  for (const role of ["server", "client"] as const) {
    if (runtimeInput[role] !== undefined) {
      const name = basename(runtimeInput[role], `runtime.${role}`);
      entryExists(dir, name, true);
      runtime[role] = name;
    }
  }
  if (runtime.server && runtime.server === entry) {
    throw new Error("server runtime and rendering entries must be distinct");
  }
  if (runtime.client && hasClient && runtime.client === clientEntry) {
    throw new Error("browser runtime and editor entries must be distinct");
  }
  const hooks = uniqueStrings(
    raw.hooks === undefined ? [] : raw.hooks,
    "hooks",
  );
  if (hooks.some((name) => !HOOK_NAMES.includes(name as HookName))) {
    throw new Error("unsupported server hook name");
  }
  if (hooks.length && !runtime.server) {
    throw new Error("declared server hooks require runtime.server");
  }
  const settings = validateSettingsPages(raw.settings);
  const caps = raw.capabilities === undefined
    ? {}
    : record(raw.capabilities, "capabilities");
  if (
    Object.keys(caps).some((key) =>
      !["network", "imports", "read", "write", "filesystem"].includes(key)
    )
  ) throw new Error("unsupported capability");
  const network = caps.network === undefined ? false : caps.network;
  if (typeof network !== "boolean") {
    uniqueStrings(network, "network capability");
  }
  const requestedNetwork = canonicalScopes(network);
  if (caps.imports !== undefined && typeof caps.imports !== "boolean") {
    uniqueStrings(caps.imports, "imports capability");
  }
  const requestedImports = caps.imports === undefined
    ? undefined
    : canonicalScopes(caps.imports);
  const capabilities: PluginCapabilities = {
    network: typeof network === "boolean"
      ? network
      : requestedNetwork.flatMap((scope) =>
        scope.type === "host" ? [scope.authority] : []
      ),
    ...(requestedImports === undefined ? {} : {
      imports: typeof caps.imports === "boolean"
        ? caps.imports
        : requestedImports.flatMap((scope) =>
          scope.type === "host" ? [scope.authority] : []
        ),
    }),
    read: uniqueStrings(
      caps.read === undefined ? ["vault"] : caps.read,
      "read capability",
    ),
    write: uniqueStrings(
      caps.write === undefined ? [] : caps.write,
      "write capability",
    ),
  };
  if (caps.filesystem !== undefined) {
    const filesystem = record(caps.filesystem, "filesystem capability");
    if (
      Object.keys(filesystem).some((key) => key !== "read" && key !== "write")
    ) throw new Error("unsupported filesystem capability");
    capabilities.filesystem = {
      read: filesystemGrants(filesystem.read ?? [], settings),
      write: filesystemGrants(filesystem.write ?? [], settings),
    };
  }
  let hasEndpoints = false;
  try {
    const endpointDir = pluginCodePath(dir, "endpoints");
    if (!Deno.statSync(endpointDir).isDirectory) {
      throw new Error("endpoints must be a directory");
    }
    hasEndpoints = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (
    !entry && !hasClient && !runtime.server && !runtime.client &&
    !settings.length && !hasEndpoints
  ) {
    throw new Error(
      "plugin has no contributions (no default entry or optional contribution)",
    );
  }
  return {
    id,
    name: metadata(raw, "name") ?? id,
    version: metadata(raw, "version") ?? "0.0.0",
    author: metadata(raw, "author"),
    source: metadata(raw, "source"),
    license: metadata(raw, "license"),
    entry,
    clientEntry,
    hasClient,
    runtime,
    hooks: hooks as HookName[],
    settings,
    hasEndpoints,
    capabilities,
    dir,
  };
}

function existingSharedDir(shared: string): string | null {
  try {
    if (Deno.statSync(shared).isDirectory) return Deno.realPathSync(shared);
  } catch { /* No shared code directory for this plugin. */ }
  return null;
}

/** Legacy direct reads/writes remain compatibility authority; services use RPC. */
export function workerPermissions(
  manifest: PluginManifest,
  vaultPath: string,
  options: {
    role?: "render" | "service";
    writable?: boolean;
    effective?: PermissionDeclaration;
  } = {},
): Deno.PermissionOptions {
  const resolvePaths = (values: string[]) =>
    values.map((p) => p === "vault" ? vaultPath : path.resolve(vaultPath, p));
  const service = options.role === "service";
  const shared = service
    ? existingSharedDir(
      path.resolve(
        path.dirname(path.fromFileUrl(import.meta.url)),
        "../../shared",
      ),
    )
    : existingSharedDir(path.resolve(manifest.dir, "../../shared"));
  return {
    // No host approval service means no delegated network or import authority.
    // Query again at actual construction; stale/unavailable parent rights never escalate.
    net: denoScopes(
      delegableScopes("network", options.effective?.network ?? []),
    ),
    import: denoScopes(
      delegableScopes("imports", options.effective?.imports ?? []),
    ),
    read: [
      ...new Set([
        manifest.dir,
        ...(service ? [] : resolvePaths(manifest.capabilities.read)),
        ...(shared ? [shared] : []),
      ]),
    ],
    write: service || options.writable === false
      ? false
      : resolvePaths(manifest.capabilities.write),
    env: false,
    ffi: false,
    run: false,
    sys: false,
  } as unknown as Deno.PermissionOptions;
}

export function discoverPluginDirs(root: string): string[] {
  try {
    const dirs: string[] = [];
    for (const entry of Deno.readDirSync(root)) {
      if (entry.isDirectory) dirs.push(path.join(root, entry.name));
    }
    return dirs.sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}
