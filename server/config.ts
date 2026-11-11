// SPDX-License-Identifier: LGPL-3.0-only
/** Resolved single-vault settings plus the temporary piece-2-owned auth record. */
import * as path from "@std/path";
import { parseAllowedHosts } from "./host_admission.ts";
import {
  BoundFileStore,
  type StoredConfigSnapshot,
} from "./config/file_store.ts";
import type { singleVaultSettings } from "./config/single_vault.ts";
export {
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "./config/file_store.ts";

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
  totp_key?: string;
  read_only_settings?: boolean;
  access_revision?: number;
  access_update_id?: string;
}
export type ResolvedVaultSettings = ReturnType<typeof singleVaultSettings>;
export class GlobalConfig {
  readonly notesPath: string;
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
  readonly mcpEnabled: boolean;
  readonly mcpRateLimit: number;
  readonly allowedHosts: ReturnType<typeof parseAllowedHosts>;
  get brandName(): string | null {
    return this.resolved.vault.settings.brand.name || null;
  }
  get brandAccent(): string | null {
    return this.resolved.vault.settings.brand.accent || null;
  }
  constructor(readonly resolved: ResolvedVaultSettings) {
    const { instance, vault } = resolved;
    this.notesPath = resolved.notesPath;
    this.statePath = resolved.statePath;
    this.pathPrefix = instance.server.pathprefix;
    this.storedConfig = this.#loadStoredConfig();
    const stored = this.storedConfig?.auth_type;
    if (
      stored !== undefined &&
      !Object.values(AuthType).includes(stored as AuthType)
    ) {
      throw new Error(
        "Invalid saved auth_type; original configuration retained.",
      );
    }
    this.authType = stored as AuthType ?? null;
    this.setupRequired = this.authType === null;
    this.quickAccessHide = vault.settings.quickaccess.hide;
    this.quickAccessTitle = vault.settings.quickaccess.title;
    this.quickAccessTerm = vault.settings.quickaccess.term;
    this.quickAccessSort = vault.settings.quickaccess.sort;
    this.quickAccessLimit = vault.settings.quickaccess.limit;
    this.autoEnablePlugins = vault.settings.plugins.autoenable;
    this.mcpEnabled = instance.mcp.enabled;
    this.mcpRateLimit = instance.mcp.ratelimit;
    this.allowedHosts = parseAllowedHosts(
      instance.server.allowedhosts.join(","),
    );
  }
  get configPath(): string {
    return path.join(this.statePath, "config.json");
  }
  #loadStoredConfig(): StoredConfig | null {
    try {
      return JSON.parse(Deno.readTextFileSync(this.configPath));
    } catch {
      return null;
    }
  }
  get readOnlySettings(): boolean {
    return this.storedConfig?.read_only_settings === true;
  }
  get settingsWritable(): boolean {
    return !this.setupRequired && this.authType !== AuthType.READ_ONLY &&
      !(this.authType === AuthType.NONE && this.readOnlySettings);
  }
  storedConfigText(): string | null {
    return this.captureStoredConfig().raw;
  }
  captureStoredConfig(): StoredConfigSnapshot {
    return new BoundFileStore(this.configPath).capture();
  }
  assertStoredConfigUnchanged(snapshot: StoredConfigSnapshot): void {
    new BoundFileStore(this.configPath).assertUnchanged(snapshot);
  }
  saveStoredConfig(
    config: StoredConfig,
    expected = this.captureStoredConfig(),
  ): void {
    new BoundFileStore(this.configPath).replace(
      JSON.stringify(config, null, 2),
      expected,
      () => {
        this.storedConfig = config;
      },
    );
  }
}
