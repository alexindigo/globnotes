// SPDX-License-Identifier: LGPL-3.0-only
import { parse } from "@std/toml";
import { fromFileUrl } from "@std/path";
import { snapshotEnvironment } from "../environment.ts";
import {
  DECLARATION_SCHEMA,
  INSTANCE_SCHEMA,
  type InstanceConfig,
  type Leaf,
  type Schema,
  type Tree,
  type Value,
  VAULT_SCHEMA,
  type VaultConfig,
} from "./schema.ts";
import {
  decodeVaultName,
  escapeVaultName,
  isVaultName,
  vaultConfigPath,
} from "./paths.ts";

export interface Provenance {
  layer: "defaults" | "toml" | "env";
  source: string;
  pinned: boolean;
}
export interface LoadResult<T> {
  config: T;
  provenance: Record<string, Provenance>;
  loaded: string[];
}
export interface Sources {
  defaultsPath?: string;
  overlayPath?: string | null;
  env: Record<string, string>;
  vaultDefaultsPath?: string;
  /** Scope bindings supplied by the registry/composition owner, not disk discovery. */
  vaults?: Record<string, { path: string; overlayPath?: string | null }>;
}
export interface InstanceLoadResult extends LoadResult<InstanceConfig> {
  vaults: Record<string, LoadResult<VaultConfig>>;
}
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration problems:\n${problems.join("\n")}`);
    this.name = "ConfigError";
  }
}
export const defaultsPath = fromFileUrl(
  new URL("../../defaults/globnotes.toml", import.meta.url),
);
export const overlayPath = fromFileUrl(
  new URL("../../config/globnotes.toml", import.meta.url),
);
export const vaultDefaultsPath = fromFileUrl(
  new URL("../../defaults/vault.toml", import.meta.url),
);
export const isTree = (value: unknown): value is Tree => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
export const isLeaf = (node: Leaf | Schema): node is Leaf =>
  typeof node.type === "string";
export function envName(key: string): string {
  const declaration = /^vaults\.entries\.([a-z][a-z0-9_]*)\.(path|admin)$/.exec(
    key,
  );
  if (declaration) {
    return `GLOBNOTES_${escapeVaultName(declaration[1])}_${
      declaration[2].toUpperCase()
    }`;
  }
  return key === "metadata.path"
    ? "GLOBNOTES_METADATA_PATH"
    : `GLOBNOTES__${key.replaceAll(".", "_").toUpperCase()}`;
}
export function leaves(schema: Schema, prefix = ""): [string, Leaf][] {
  return Object.entries(schema).flatMap(([key, node]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return isLeaf(node) ? [[full, node] as [string, Leaf]] : leaves(node, full);
  });
}
export function get(tree: Tree, key: string): Value | Tree | undefined {
  let current: Value | Tree | undefined = tree;
  for (const part of key.split(".")) {
    current = isTree(current) ? current[part] : undefined;
  }
  return current;
}
export function set(tree: Tree, key: string, value: Value): void {
  const parts = key.split(".");
  let current = tree;
  for (const part of parts.slice(0, -1)) {
    if (!isTree(current[part])) current[part] = {};
    current = current[part] as Tree;
  }
  current[parts.at(-1)!] = value;
}
export function valid(value: unknown, spec: Leaf): value is Value {
  const typed = spec.type === "list"
    ? Array.isArray(value) && value.every((v) => typeof v === "string")
    : spec.type === "integer"
    ? typeof value === "number" && Number.isSafeInteger(value)
    : spec.type === "number"
    ? typeof value === "number" && Number.isFinite(value)
    : spec.type === "string"
    ? typeof value === "string"
    : typeof value === "boolean";
  return typed && (!spec.valid || spec.valid(value as Value));
}
export function parseEnv(raw: string, spec: Leaf): Value | undefined {
  let value: unknown;
  switch (spec.type) {
    case "string":
      value = raw;
      break;
    case "boolean":
      value = raw === "true" ? true : raw === "false" ? false : undefined;
      break;
    case "integer":
      value = /^-?\d+$/.test(raw) ? Number(raw) : undefined;
      break;
    case "number":
      value = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
        ? Number(raw)
        : undefined;
      break;
    case "list":
      value = raw === "" ? [] : raw.split(",").map((v) => v.trim());
      break;
  }
  return valid(value, spec) ? value : undefined;
}
export function readLayer(
  file: string,
  optional: boolean,
  problems: string[],
): Tree | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(file);
  } catch (error) {
    if (!(optional && error instanceof Deno.errors.NotFound)) {
      problems.push(`config: ${file}: cannot read configuration file`);
    }
    return null;
  }
  try {
    return parse(text) as Tree;
  } catch {
    problems.push(`config: ${file}: invalid TOML (values withheld)`);
    return null;
  }
}
export function applyLayer(
  tree: Tree,
  schema: Schema,
  target: Tree,
  provenance: Record<string, Provenance>,
  source: string,
  layer: Provenance["layer"],
  problems: string[],
  name = envName,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const node = Object.hasOwn(schema, key) ? schema[key] : undefined;
    const issue = (message: string) =>
      problems.push(`config: ${source}: ${full} (${name(full)}): ${message}`);
    if (!node) {
      issue("unknown key");
      continue;
    }
    if (isLeaf(node)) {
      if (!valid(value, node)) {
        issue(`expected valid ${node.type} leaf`);
        continue;
      }
      set(target, full, value);
      provenance[full] = { layer, source, pinned: layer !== "defaults" };
    } else if (!isTree(value)) issue("expected section, not a value");
    else {applyLayer(
        value,
        node,
        target,
        provenance,
        source,
        layer,
        problems,
        name,
        full,
      );}
  }
}
export function loadLayers(
  schema: Schema,
  defaultsFile: string,
  overlayFile: string | null,
  explicit: boolean,
  problems: string[],
  name = envName,
  overlaySchema?: (tree: Tree) => Schema,
): LoadResult<Tree> {
  const config: Tree = {},
    provenance: Record<string, Provenance> = {},
    loaded: string[] = [];
  const base = readLayer(defaultsFile, false, problems);
  if (base) {
    loaded.push(defaultsFile);
    applyLayer(
      base,
      schema,
      config,
      provenance,
      defaultsFile,
      "defaults",
      problems,
      name,
    );
    for (const [key] of leaves(schema)) {
      if (get(base, key) === undefined) {
        problems.push(
          `config: ${defaultsFile}: ${key} (${
            name(key)
          }): missing default leaf`,
        );
      }
    }
  }
  const overlay = overlayFile === null
    ? null
    : readLayer(overlayFile, !explicit, problems);
  if (overlay && overlayFile !== null) {
    loaded.push(overlayFile);
    applyLayer(
      overlay,
      overlaySchema?.(overlay) ?? schema,
      config,
      provenance,
      overlayFile,
      "toml",
      problems,
      name,
    );
  }
  return { config, provenance, loaded };
}
export function applyEnvironment(
  result: LoadResult<Tree>,
  schema: Schema,
  env: Record<string, string>,
  problems: string[],
  name = envName,
): void {
  const byName = new Map(
    leaves(schema).map(([key, spec]) => [name(key), { key, spec }]),
  );
  for (const [variable, raw] of Object.entries(env)) {
    if (
      !variable.startsWith("GLOBNOTES_") ||
      ["GLOBNOTES_CONFIG", "GLOBNOTES_REVISION"].includes(variable)
    ) continue;
    const leaf = byName.get(variable);
    if (!leaf) {
      problems.push(
        `config: environment: ${variable}: unknown key or section (only leaves may be overridden)`,
      );
      continue;
    }
    const value = parseEnv(raw, leaf.spec);
    if (value === undefined) {
      problems.push(
        `config: environment: ${leaf.key} (${variable}): expected valid ${leaf.spec.type}`,
      );
      continue;
    }
    set(result.config, leaf.key, value);
    result.provenance[leaf.key] = {
      layer: "env",
      source: variable,
      pinned: true,
    };
  }
}
export function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function loadInstanceConfig(
  sources: Sources,
): InstanceLoadResult {
  const problems: string[] = [];
  const { instanceEnv, declarationNames, vaultEnv } = splitEnvironment(
    sources.env,
    problems,
  );
  const explicit = Object.hasOwn(sources.env, "GLOBNOTES_CONFIG");
  if (explicit && sources.env.GLOBNOTES_CONFIG.trim() === "") {
    problems.push("config: GLOBNOTES_CONFIG: expected nonempty file path");
  }
  const result = loadLayers(
    INSTANCE_SCHEMA,
    sources.defaultsPath ?? defaultsPath,
    explicit
      ? sources.env.GLOBNOTES_CONFIG
      : sources.overlayPath === undefined
      ? overlayPath
      : sources.overlayPath,
    explicit,
    problems,
    envName,
    (overlay) => declarationSchema(overlay, declarationNames, problems),
  );
  if (!isTree(result.config.vaults)) result.config.vaults = {};
  const vaultSection = result.config.vaults as Tree;
  if (!isTree(vaultSection.entries)) vaultSection.entries = {};
  const entries = vaultSection.entries as Tree;
  for (const name of declarationNames) {
    if (!Object.hasOwn(entries, name)) entries[name] = {};
  }
  const template = vaultSection.entrydefaults;
  for (const [name, entry] of Object.entries(entries)) {
    if (!isTree(entry)) continue;
    for (const [key] of leaves(DECLARATION_SCHEMA)) {
      if (
        !Object.hasOwn(entry, key) && isTree(template) &&
        Object.hasOwn(template, key)
      ) {
        set(
          result.config,
          `vaults.entries.${name}.${key}`,
          template[key] as Value,
        );
        result.provenance[`vaults.entries.${name}.${key}`] = {
          layer: "defaults",
          source: sources.defaultsPath ?? defaultsPath,
          pinned: false,
        };
      }
    }
  }
  applyEnvironment(
    result,
    declarationSchema({ vaults: { entries } }, declarationNames, problems),
    instanceEnv,
    problems,
  );
  for (const [name, entry] of Object.entries(entries)) {
    if (!isTree(entry) || !valid(entry.path, DECLARATION_SCHEMA.path as Leaf)) {
      problems.push(
        `config: vaults.entries.${name}.path (${
          envName(`vaults.entries.${name}.path`)
        }): declared vault requires a nonempty path`,
      );
    }
  }
  const base = loadLayers(
    VAULT_SCHEMA,
    sources.vaultDefaultsPath ?? vaultDefaultsPath,
    null,
    false,
    problems,
    (key) => `GLOBNOTES_<NAME>_${key.replaceAll(".", "_").toUpperCase()}`,
  );
  const vaults: Record<string, LoadResult<VaultConfig>> = {};
  const names = new Set([
    ...Object.keys(entries),
    ...Object.keys(sources.vaults ?? {}),
    ...Object.keys(vaultEnv),
  ]);
  for (const name of names) {
    if (!isVaultName(name)) {
      problems.push(`config: vaults.${name}: invalid or reserved vault name`);
      continue;
    }
    const declared = Object.hasOwn(entries, name) && isTree(entries[name])
      ? entries[name] as Tree
      : undefined;
    const binding = Object.hasOwn(sources.vaults ?? {}, name)
      ? sources.vaults![name]
      : undefined;
    const notes = typeof declared?.path === "string" && declared.path
      ? declared.path
      : binding?.path;
    if (!notes) {
      if (!declared) {
        problems.push(
          `config: vaults.${name} (GLOBNOTES_${
            escapeVaultName(name)
          }_PATH): vault env requires a declared or supplied scope`,
        );
      }
      resolveVaultConfig(name, null, vaultEnv[name] ?? {}, base, problems);
      continue;
    }
    const metadata = get(result.config, "metadata.path");
    const file = binding?.overlayPath === null ? null : binding?.overlayPath ??
      vaultConfigPath(
        notes,
        typeof metadata === "string" ? metadata : "",
        name,
      );
    vaults[name] = resolveVaultConfig(
      name,
      file,
      vaultEnv[name] ?? {},
      base,
      problems,
    ) as unknown as LoadResult<VaultConfig>;
  }
  if (problems.length) throw new ConfigError(problems);
  return freeze({ ...result, vaults }) as unknown as InstanceLoadResult;
}
let memo: InstanceLoadResult | undefined;
export function config(): InstanceConfig {
  return (memo ??= loadInstanceConfig({ env: snapshotEnvironment() })).config;
}
export type PartialConfig<T> = {
  [K in keyof T]?: T[K] extends object ? PartialConfig<T[K]>
    : T[K];
};
export function setConfigForTests(
  partial: PartialConfig<InstanceConfig>,
): void {
  const base = structuredClone(
    loadInstanceConfig({ env: {}, overlayPath: null }).config,
  ) as unknown as Tree;
  const problems: string[] = [], provenance: Record<string, Provenance> = {};
  applyLayer(
    partial as Tree,
    INSTANCE_SCHEMA,
    base,
    provenance,
    "test fixture",
    "toml",
    problems,
  );
  if (problems.length) throw new ConfigError(problems);
  memo = freeze({
    config: base as unknown as InstanceConfig,
    provenance,
    loaded: [],
    vaults: {},
  });
}
export function resetConfigForTests(): void {
  memo = undefined;
}

function declarationSchema(
  overlay: Tree,
  envNames: Set<string>,
  problems: string[],
): Schema {
  const entries = get(overlay, "vaults.entries");
  const names = new Set([
    ...envNames,
    ...isTree(entries) ? Object.keys(entries) : [],
  ]);
  const schema: Schema = {};
  for (const name of names) {
    if (!isVaultName(name)) {
      problems.push(
        `config: vaults.entries.${name}: invalid or reserved vault name`,
      );
      continue;
    }
    schema[name] = DECLARATION_SCHEMA;
    // An empty TOML table is still a declaration and must require a path.
    envNames.add(name);
  }
  const vaults = { ...INSTANCE_SCHEMA.vaults as Schema };
  delete vaults.entrydefaults;
  return { ...INSTANCE_SCHEMA, vaults: { ...vaults, entries: schema } };
}

export function splitEnvironment(
  env: Record<string, string>,
  problems: string[] = [],
) {
  const instanceEnv: Record<string, string> = {};
  const declarationNames = new Set<string>();
  const vaultEnv: Record<string, Record<string, string>> = Object.create(null);
  for (const [variable, raw] of Object.entries(env)) {
    const rest = variable.slice("GLOBNOTES_".length);
    if (
      !variable.startsWith("GLOBNOTES_") ||
      variable.startsWith("GLOBNOTES__") ||
      ["GLOBNOTES_CONFIG", "GLOBNOTES_REVISION", "GLOBNOTES_METADATA_PATH"]
        .includes(variable)
    ) {
      instanceEnv[variable] = raw;
      continue;
    }
    const declaration = /^(.+)_(PATH|ADMIN)$/.exec(rest);
    const leaf = /^(.+)_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(rest);
    const match = declaration ?? leaf;
    const name = match ? decodeVaultName(match[1]) : null;
    if (!name) {
      if (match) {
        problems.push(
          `config: ${variable}: invalid or reserved vault name: ${
            match[1].replaceAll("__", "_").toLowerCase()
          }`,
        );
      }
      instanceEnv[variable] = raw;
      continue;
    }
    if (declaration) {
      declarationNames.add(name);
      instanceEnv[variable] = raw;
    } else (vaultEnv[name] ??= {})[variable] = raw;
  }
  return { instanceEnv, declarationNames, vaultEnv };
}

function resolveVaultConfig(
  name: string,
  file: string | null,
  env: Record<string, string>,
  base: LoadResult<Tree>,
  problems: string[],
): LoadResult<Tree> {
  const result = structuredClone(base);
  const spelling = (key: string) =>
    `GLOBNOTES_${escapeVaultName(name)}_${
      key.replaceAll(".", "_").toUpperCase()
    }`;
  if (file !== null) {
    const overlay = readLayer(file, true, problems);
    if (overlay) {
      result.loaded.push(file);
      applyLayer(
        overlay,
        VAULT_SCHEMA,
        result.config,
        result.provenance,
        file,
        "toml",
        problems,
        spelling,
      );
    }
  }
  applyEnvironment(result, VAULT_SCHEMA, env, problems, spelling);
  return result;
}

/** Standalone factory for the current single-vault adapter and future registry. */
export function loadVaultConfig(
  name: string,
  file: string | null,
  env: Record<string, string>,
  defaultsFile = vaultDefaultsPath,
): LoadResult<VaultConfig> {
  if (!isVaultName(name)) {
    throw new ConfigError([`config: invalid or reserved vault name: ${name}`]);
  }
  const problems: string[] = [];
  const base = loadLayers(
    VAULT_SCHEMA,
    defaultsFile,
    null,
    false,
    problems,
    (key) =>
      `GLOBNOTES_${escapeVaultName(name)}_${
        key.replaceAll(".", "_").toUpperCase()
      }`,
  );
  const result = resolveVaultConfig(name, file, env, base, problems);
  if (problems.length) throw new ConfigError(problems);
  return freeze(result) as unknown as LoadResult<VaultConfig>;
}
