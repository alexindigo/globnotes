// SPDX-License-Identifier: LGPL-3.0-only

import { AsyncLocalStorage } from "node:async_hooks";
import { AuthType, GlobalConfig } from "./config.ts";
import { LocalAuth } from "./auth/local.ts";
import { FileServing } from "./files/file_serving.ts";
import { FileSystemNotes } from "./notes/file_system.ts";
import { PluginManager } from "./plugins/manager.ts";
import { makePluginRpc } from "./plugins/rpc.ts";
import { Fts5Indexer } from "./search/fts5.ts";
import { logger } from "./logger.ts";
import type { VaultSpec } from "./vault_env.ts";

export class Vault {
  readonly slug: string;
  readonly root: string;
  readonly basePath: string;
  readonly config: GlobalConfig;
  auth: LocalAuth | null;
  readonly notes: FileSystemNotes;
  readonly indexer: Fts5Indexer;
  readonly files: FileServing;
  readonly plugins: PluginManager;

  constructor(
    spec: VaultSpec,
    instancePathPrefix: string,
    excludePrefixes: string[] = [],
  ) {
    this.slug = spec.slug;
    this.root = spec.root;
    this.basePath = instancePathPrefix + (spec.slug ? "/" + spec.slug : "");
    const envSuffix = spec.slug && spec.slug !== "globnotes"
      ? "_" + spec.slug
      : "";
    this.config = new GlobalConfig({
      notesPath: spec.root,
      envSuffix,
    });
    this.notes = new FileSystemNotes(spec.root, null, excludePrefixes);
    this.indexer = new Fts5Indexer(spec.root);
    this.notes.setIndexer(this.indexer);
    this.indexer.bindNotes(this.notes);
    this.files = new FileServing(spec.root);
    this.plugins = new PluginManager(
      spec.root,
      makePluginRpc({
        notes: this.notes,
        indexer: this.indexer,
        files: this.files,
        basePath: this.basePath,
      }),
    );
    this.indexer.bindPlugins(this.plugins);
    this.auth = this.config.authType === AuthType.PASSWORD ||
        this.config.authType === AuthType.TOTP
      ? new LocalAuth(this.config, spec.slug)
      : null;
  }
}

const als = new AsyncLocalStorage<Vault>();

export const registry = new Map<string, Vault>();

export function setRegistry(vaults: Vault[]): void {
  registry.clear();
  for (const v of vaults) registry.set(v.slug, v);
}

export function isNamespaced(): boolean {
  for (const slug of registry.keys()) {
    if (slug !== "") return true;
  }
  return false;
}

export function boundVault(): Vault | undefined {
  return als.getStore();
}

export function currentVault(): Vault {
  const v = als.getStore();
  if (!v) throw new Error("no vault bound");
  return v;
}

export function runWithVault<T>(vault: Vault, fn: () => T): T {
  return als.run(vault, fn);
}

export function tryCreateVault(
  spec: VaultSpec,
  instancePathPrefix: string,
  excludePrefixes: string[] = [],
): Vault | null {
  try {
    if (!Deno.statSync(spec.root).isDirectory) {
      logger.error(
        `Skipping vault '${spec.slug || "globnotes"}': not a directory: ${spec.root}`,
      );
      return null;
    }
  } catch {
    logger.error(
      `Skipping vault '${spec.slug || "globnotes"}': missing root ${spec.root}`,
    );
    return null;
  }
  return new Vault(spec, instancePathPrefix, excludePrefixes);
}
