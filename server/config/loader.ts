// SPDX-License-Identifier: LGPL-3.0-only
import { parse } from "@std/toml";
import { fromFileUrl } from "@std/path";
import { snapshotEnvironment } from "../environment.ts";
import {
  INSTANCE_SCHEMA,
  type InstanceConfig,
  type Leaf,
  type Schema,
  type Tree,
  type Value,
} from "./schema.ts";

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
export const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isLeaf = (node: Leaf | Schema): node is Leaf =>
  typeof node.type === "string";
export function envName(key: string): string {
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
      schema,
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
): LoadResult<InstanceConfig> {
  const problems: string[] = [];
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
  );
  applyEnvironment(result, INSTANCE_SCHEMA, sources.env, problems);
  if (problems.length) throw new ConfigError(problems);
  return freeze(result) as unknown as LoadResult<InstanceConfig>;
}
let memo: LoadResult<InstanceConfig> | undefined;
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
  });
}
export function resetConfigForTests(): void {
  memo = undefined;
}
