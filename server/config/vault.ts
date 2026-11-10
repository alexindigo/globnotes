// SPDX-License-Identifier: LGPL-3.0-only
import { parse, stringify } from "@std/toml";
import {
  BoundFileStore,
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "./file_store.ts";
import {
  applyEnvironment,
  applyLayer,
  ConfigError,
  freeze,
  get,
  isTree,
  leaves,
  type LoadResult,
  loadVaultConfig,
  type PartialConfig,
} from "./loader.ts";
import { escapeVaultName } from "./paths.ts";
import { type Tree, VAULT_SCHEMA, type VaultConfig } from "./schema.ts";

/** Host-only snapshot. Routes project settings/provenance, never these bytes or paths. */
export interface VaultConfigSnapshot {
  readonly saved: Tree;
  readonly resolved: LoadResult<VaultConfig>;
  readonly persistence: StoredConfigSnapshot;
}
export class ConfigWriteError extends Error {}

/** One saved TOML owner; the composition owner supplies its short commit gate/guard. */
export class VaultConfigStore {
  readonly #file: BoundFileStore;
  readonly #base: LoadResult<VaultConfig>;
  readonly #env: Record<string, string>;
  #snapshot: VaultConfigSnapshot;

  constructor(
    readonly name: string,
    readonly filename: string,
    options: { env?: Record<string, string>; defaultsPath?: string } = {},
  ) {
    this.#file = new BoundFileStore(filename);
    this.#env = Object.freeze({ ...options.env });
    this.#base = loadVaultConfig(name, null, {}, options.defaultsPath);
    const persistence = this.#file.capture();
    let saved: Tree = {};
    if (persistence.raw !== null) {
      try {
        saved = parse(persistence.raw) as Tree;
      } catch {
        throw new ConfigError([
          `config: ${filename}: invalid TOML (values withheld)`,
        ]);
      }
    }
    this.#snapshot = this.#resolve(saved, persistence);
  }

  get settings(): VaultConfig {
    return this.#snapshot.resolved.config;
  }
  get provenance() {
    return this.#snapshot.resolved.provenance;
  }
  capture(): VaultConfigSnapshot {
    return this.#snapshot;
  }

  #spelling = (key: string) =>
    `GLOBNOTES_${escapeVaultName(this.name)}_${
      key.replaceAll(".", "_").toUpperCase()
    }`;

  #resolve(
    saved: Tree,
    persistence: StoredConfigSnapshot,
  ): VaultConfigSnapshot {
    const resolved = structuredClone(this.#base) as unknown as LoadResult<Tree>;
    const problems: string[] = [];
    applyLayer(
      saved,
      VAULT_SCHEMA,
      resolved.config,
      resolved.provenance,
      this.filename,
      "toml",
      problems,
      this.#spelling,
    );
    applyEnvironment(
      resolved,
      VAULT_SCHEMA,
      this.#env,
      problems,
      this.#spelling,
    );
    if (problems.length) throw new ConfigError(problems);
    if (persistence.raw !== null) resolved.loaded.push(this.filename);
    return freeze({
      saved: structuredClone(saved),
      resolved: resolved as unknown as LoadResult<VaultConfig>,
      persistence,
    });
  }

  /** Omission leaves a saved leaf alone; an explicit empty string clears it. */
  save(
    changes: PartialConfig<VaultConfig>,
    expected = this.capture(),
    guard: () => void = () => {},
  ): VaultConfig {
    guard();
    if (expected !== this.#snapshot) throw new StoredConfigConflict();
    this.#file.assertUnchanged(expected.persistence);
    if (!isTree(changes)) {
      throw new ConfigWriteError("Vault settings require an object.");
    }
    const next = structuredClone(expected.saved);
    const problems: string[] = [];
    applyLayer(
      changes as Tree,
      VAULT_SCHEMA,
      next,
      {},
      "settings update",
      "toml",
      problems,
      this.#spelling,
    );
    if (problems.length) throw new ConfigError(problems);
    for (const [key] of leaves(VAULT_SCHEMA)) {
      if (get(changes as Tree, key) === undefined) continue;
      if (this.provenance[key]?.layer === "env") {
        throw new ConfigWriteError(
          `${key} is pinned by environment configuration.`,
        );
      }
      if (key.startsWith("plugins.")) {
        throw new ConfigWriteError(
          `${key} belongs to the plugin policy/settings owner, not vault settings writes.`,
        );
      }
    }
    const raw = stringify(next);
    // Validate the full prospective snapshot before effects, not just the patch.
    const prepared = this.#resolve(next, expected.persistence);
    guard();
    this.#file.replace(raw, expected.persistence, () => {
      const persistence = this.#file.capture();
      if (persistence.raw !== raw) throw new StoredConfigConflict();
      this.#snapshot = freeze({
        ...prepared,
        resolved: {
          ...prepared.resolved,
          loaded: [...new Set([...prepared.resolved.loaded, this.filename])],
        },
        persistence,
      });
    });
    return this.settings;
  }
}
