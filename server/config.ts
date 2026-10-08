// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Global configuration: environment variables win over the stored
 * first-run-setup config (<vault>/.globnotes/config.json). Ported from
 * the Python server's global_config.py with identical semantics.
 */

import * as path from "@std/path";
import { getEnv } from "./helpers.ts";
import { logger } from "./logger.ts";

export enum AuthType {
  NONE = "none",
  READ_ONLY = "read_only",
  PASSWORD = "password",
  TOTP = "totp",
}

export interface StoredConfig {
  [key: string]: unknown;
  auth_type?: string;
  username?: string;
  password_hash?: string;
  secret_key?: string;
  /** Wizard-enrolled TOTP key (raw text, same form as GLOBNOTES_TOTP_KEY). */
  totp_key?: string;
  brand_name?: string;
  brand_accent?: string;
  read_only_settings?: boolean;
  access_revision?: number;
  access_update_id?: string;
}

interface ConfigNode {
  readonly location: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number | null;
    readonly mode: number | null;
    readonly uid: number | null;
    readonly gid: number | null;
    readonly kind: "file" | "directory" | "link";
    readonly link: string | null;
  } | null;
}
/** Host-only bytes and filesystem binding; never part of a public projection. */
export interface StoredConfigSnapshot {
  readonly raw: string | null;
  readonly binding: {
    readonly configured: string;
    readonly target: string;
    readonly nodes: readonly ConfigNode[];
  };
}
export class StoredConfigConflict extends Error {
  constructor() {
    super("Stored configuration changed before commit.");
  }
}
class ConfigBindingError extends Error {}
function configNode(location: string): ConfigNode {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(location);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return Object.freeze({ location, identity: null });
    }
    throw error;
  }
  if (!info.isFile && !info.isDirectory && !info.isSymlink) {
    throw new ConfigBindingError(
      "Stored configuration requires a regular file target.",
    );
  }
  return Object.freeze({
    location,
    identity: Object.freeze({
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      uid: info.uid,
      gid: info.gid,
      kind: info.isSymlink ? "link" : info.isDirectory ? "directory" : "file",
      link: info.isSymlink ? Deno.readLinkSync(location) : null,
    }),
  });
}
/** Resolve components without erasing a consulted link or following it unboundedly.
 * Missing ordinary parents are recorded; link targets must have existing parents. */
function configBinding(configured: string): StoredConfigSnapshot["binding"] {
  const parts = (value: string) => value.split(path.SEPARATOR).filter(Boolean);
  const root = path.parse(configured).root;
  let current = root, links = 0, steps = 0;
  let pending = parts(configured.slice(root.length)).map((segment) => ({
    segment,
    required: false,
  }));
  const nodes = new Map<string, ConfigNode>();
  nodes.set(root, configNode(root));
  while (pending.length) {
    if (++steps > 4096) {
      throw new ConfigBindingError("Stored configuration path is too complex.");
    }
    const item = pending.shift()!;
    if (item.segment === ".") continue;
    if (item.segment === "..") {
      current = path.dirname(current);
      continue;
    }
    const location = path.join(current, item.segment),
      node = configNode(location);
    nodes.set(location, node);
    if (node.identity?.kind === "link") {
      if (++links > 40) {
        throw new ConfigBindingError(
          "Stored configuration link cycle or excessive chain.",
        );
      }
      const target = node.identity.link!;
      const targetRoot = path.parse(target).root;
      if (targetRoot) {
        current = targetRoot;
        nodes.set(current, configNode(current));
      }
      const targetParts = parts(target.slice(targetRoot.length));
      const remaining = pending.length;
      pending = [
        ...targetParts.map((segment, i) => ({
          segment,
          required: remaining > 0 || i < targetParts.length - 1 ||
            item.required,
        })),
        ...pending,
      ];
      continue;
    }
    if (!node.identity && item.required) {
      throw new Deno.errors.NotFound(
        "Stored configuration link target parent is absent.",
      );
    }
    if (pending.length && node.identity && node.identity.kind !== "directory") {
      throw new ConfigBindingError(
        "Stored configuration parent is not a directory.",
      );
    }
    current = location;
  }
  const target = nodes.get(current) ?? configNode(current);
  if (target.identity && target.identity.kind !== "file") {
    throw new ConfigBindingError(
      "Stored configuration requires a regular file target.",
    );
  }
  return Object.freeze({
    configured,
    target: current,
    nodes: Object.freeze([...nodes.values()]),
  });
}

export class GlobalConfig {
  readonly notesPath: string;
  /** State dir (index, config, brand, plugins). GLOBNOTES_INDEX_PATH IS
   * the dir (not a parent); unset ⇒ the vault's .globnotes. */
  readonly statePath: string;
  readonly pathPrefix: string;
  storedConfig: StoredConfig | null;
  authType: AuthType | null;
  setupRequired: boolean;
  readonly quickAccessHide: boolean;
  readonly quickAccessTitle: string;
  readonly quickAccessTerm: string;
  readonly quickAccessSort: string;
  readonly quickAccessLimit: number;
  readonly autoEnablePlugins: boolean;
  /** White-label branding: env wins over stored config, null when unset. */
  brandName: string | null;
  brandAccent: string | null;

  constructor() {
    logger.debug("Loading global config...");
    this.notesPath = getEnv("GLOBNOTES_PATH", { mandatory: true });
    // getEnv returns "" for unset vars — `||` treats that (and an
    // explicitly empty value) as absent, per the env-wins rule.
    this.statePath = getEnv("GLOBNOTES_INDEX_PATH") ||
      path.join(this.notesPath, ".globnotes");
    this.storedConfig = this.#loadStoredConfig();
    this.authType = this.#loadAuthType();
    this.setupRequired = this.authType === null;
    this.quickAccessHide = this.#quickAccessHide();
    this.quickAccessTitle = this.#quickAccessTitle();
    this.quickAccessTerm = this.#quickAccessTerm();
    this.quickAccessSort = this.#quickAccessSort();
    this.quickAccessLimit = this.#quickAccessLimit();
    this.autoEnablePlugins = getEnv("GLOBNOTES_AUTO_ENABLE_PLUGINS", {
      castBool: true,
      default: true,
    }) ===
      "true";
    this.pathPrefix = this.#loadPathPrefix();
    // getEnv returns "" for unset vars — `||` treats that (and an
    // explicitly empty value) as absent, per the env-wins rule.
    this.brandName = getEnv("GLOBNOTES_BRAND_NAME") ||
      this.storedConfig?.brand_name || null;
    this.brandAccent = getEnv("GLOBNOTES_BRAND_ACCENT") ||
      this.storedConfig?.brand_accent || null;
  }

  get configPath(): string {
    return path.join(this.statePath, "config.json");
  }

  #loadStoredConfig(): StoredConfig | null {
    /** Load the config written by the first-run setup wizard (if any). */
    try {
      return JSON.parse(Deno.readTextFileSync(this.configPath));
    } catch {
      return null;
    }
  }

  /** Public settings policy is independent of public note writability. */
  get readOnlySettings(): boolean {
    return getEnv("GLOBNOTES_READ_ONLY_SETTINGS")
      ? getEnv("GLOBNOTES_READ_ONLY_SETTINGS", { castBool: true }) === "true"
      : this.storedConfig?.read_only_settings === true;
  }

  get settingsWritable(): boolean {
    return !this.setupRequired && this.authType !== AuthType.READ_ONLY &&
      !(this.authType === AuthType.NONE && this.readOnlySettings);
  }

  storedConfigText(): string | null {
    return this.captureStoredConfig().raw;
  }

  captureStoredConfig(): StoredConfigSnapshot {
    const binding = configBinding(path.resolve(this.configPath));
    const target = binding.nodes.find((node) =>
      node.location === binding.target
    );
    const raw = target?.identity ? Deno.readTextFileSync(binding.target) : null;
    return Object.freeze({ raw, binding });
  }

  assertStoredConfigUnchanged(snapshot: StoredConfigSnapshot): void {
    let current: StoredConfigSnapshot;
    try {
      current = this.captureStoredConfig();
    } catch (error) {
      if (
        error instanceof ConfigBindingError ||
        error instanceof Deno.errors.NotFound
      ) throw new StoredConfigConflict();
      throw error;
    }
    if (
      current.raw !== snapshot.raw ||
      JSON.stringify(current.binding) !== JSON.stringify(snapshot.binding)
    ) {
      throw new StoredConfigConflict();
    }
  }

  /** Sync and replace the resolved target, retaining configured file/directory links. */
  saveStoredConfig(
    config: StoredConfig,
    expected = this.captureStoredConfig(),
  ): void {
    this.assertStoredConfigUnchanged(expected);
    const created = new Map<string, ConfigNode>();
    for (const node of expected.binding.nodes) {
      if (node.identity || node.location === expected.binding.target) continue;
      try {
        Deno.mkdirSync(node.location);
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new StoredConfigConflict();
        }
        throw error;
      }
      created.set(node.location, configNode(node.location));
    }
    const prepared = Object.freeze({
      raw: expected.raw,
      binding: Object.freeze({
        ...expected.binding,
        nodes: Object.freeze(
          expected.binding.nodes.map((node) =>
            created.get(node.location) ?? node
          ),
        ),
      }),
    });
    this.assertStoredConfigUnchanged(prepared);
    const target = expected.binding.target;
    const identity = expected.binding.nodes.find((node) =>
      node.location === target
    )?.identity;
    // Replacement authority on the directory must not bypass target write access.
    if (identity) Deno.openSync(target, { write: true }).close();
    const temporary = Deno.makeTempFileSync({
      dir: path.dirname(target),
      prefix: ".config-",
    });
    let failed = false, failure: unknown;
    try {
      Deno.writeTextFileSync(temporary, JSON.stringify(config, null, 2));
      if (identity) {
        const temporaryInfo = Deno.statSync(temporary);
        if (
          identity.uid !== temporaryInfo.uid ||
          identity.gid !== temporaryInfo.gid
        ) {
          Deno.chownSync(temporary, identity.uid, identity.gid);
        }
        if (identity.mode !== null) {
          Deno.chmodSync(temporary, identity.mode & 0o7777);
        }
      }
      const handle = Deno.openSync(temporary, { write: true });
      try {
        handle.syncSync();
      } finally {
        handle.close();
      }
      if (identity) Deno.openSync(target, { write: true }).close();
      this.assertStoredConfigUnchanged(prepared);
      Deno.renameSync(temporary, target);
      this.storedConfig = config;
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      Deno.removeSync(temporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        failure = failed
          ? new AggregateError(
            [failure, error],
            "Configuration persistence and temporary-file cleanup failed.",
          )
          : error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }

  #loadAuthType(): AuthType | null {
    const key = "GLOBNOTES_AUTH_TYPE";
    const value = getEnv(key);
    if (value) {
      const authType = Object.values(AuthType).find((t) =>
        t === value.toLowerCase()
      );
      if (!authType) {
        logger.error(
          `Invalid value '${value}' for ${key}. Must be one of: ` +
            Object.values(AuthType).join(", ") + ".",
        );
        Deno.exit(1);
      }
      return authType;
    }
    // Fall back to the stored first-run setup choice (env always wins)
    const storedAuthType = this.storedConfig?.auth_type;
    if (storedAuthType) {
      const authType = Object.values(AuthType).find((t) =>
        t === storedAuthType
      );
      if (!authType) {
        logger.error(
          `Invalid auth_type '${storedAuthType}' in ${this.configPath}.`,
        );
        Deno.exit(1);
      }
      return authType;
    }
    // No env and no stored choice: first-run setup is required
    return null;
  }

  #quickAccessHide(): boolean {
    const key = "GLOBNOTES_QUICK_ACCESS_HIDE";
    let value = getEnv(key, { castBool: true, default: false }) === "true";
    if (!value) {
      const deprecatedKey = "GLOBNOTES_HIDE_RECENTLY_MODIFIED";
      const deprecated = getEnv(deprecatedKey, {
        castBool: true,
        default: false,
      }) === "true";
      if (deprecated) {
        logger.warning(
          `${deprecatedKey} is deprecated. Please use ${key} instead.`,
        );
        value = true;
      }
    }
    return value;
  }

  #quickAccessTitle(): string {
    return getEnv("GLOBNOTES_QUICK_ACCESS_TITLE", {
      default: "RECENTLY MODIFIED",
    });
  }

  #quickAccessTerm(): string {
    return getEnv("GLOBNOTES_QUICK_ACCESS_TERM", { default: "*" });
  }

  #quickAccessSort(): string {
    const key = "GLOBNOTES_QUICK_ACCESS_SORT";
    const value = getEnv(key, { default: "lastModified" });
    const validValues = ["score", "title", "lastModified"];
    if (!validValues.includes(value)) {
      logger.error(
        `Invalid value '${value}' for ${key}. Must be one of: ` +
          validValues.join(", ") + ".",
      );
      Deno.exit(1);
    }
    return value;
  }

  #quickAccessLimit(): number {
    return Number(
      getEnv("GLOBNOTES_QUICK_ACCESS_LIMIT", { castInt: true, default: 4 }),
    );
  }

  #loadPathPrefix(): string {
    const key = "GLOBNOTES_PATH_PREFIX";
    const value = getEnv(key);
    if (value && (!value.startsWith("/") || value.endsWith("/"))) {
      logger.error(
        `Invalid value '${value}' for ${key}. Must start with '/' and not end with '/'.`,
      );
      Deno.exit(1);
    }
    return value;
  }
}
