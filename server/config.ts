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
  auth_type?: string;
  username?: string;
  password_hash?: string;
  secret_key?: string;
  brand_name?: string;
  brand_accent?: string;
}

export class GlobalConfig {
  readonly notesPath: string;
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
    return path.join(this.notesPath, ".globnotes", "config.json");
  }

  #loadStoredConfig(): StoredConfig | null {
    /** Load the config written by the first-run setup wizard (if any). */
    try {
      return JSON.parse(Deno.readTextFileSync(this.configPath));
    } catch {
      return null;
    }
  }

  /** Persist the first-run setup choice. */
  saveStoredConfig(config: StoredConfig): void {
    Deno.mkdirSync(path.dirname(this.configPath), { recursive: true });
    Deno.writeTextFileSync(
      this.configPath,
      JSON.stringify(config, null, 2),
    );
    this.storedConfig = config;
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
