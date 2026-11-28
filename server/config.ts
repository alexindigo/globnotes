// SPDX-License-Identifier: LGPL-3.0-only
/** Resolved settings; account and vault access records have their own owners. */
import { storedDurabilityStatus } from "./config/durability.ts";
import { parseAllowedHosts } from "./host_admission.ts";
import type { singleVaultSettings } from "./config/single_vault.ts";
export {
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "./config/file_store.ts";

export type ResolvedVaultSettings = ReturnType<typeof singleVaultSettings>;
export class GlobalConfig {
  get storageDurability() {
    return storedDurabilityStatus();
  }
  readonly notesPath: string;
  readonly statePath: string;
  readonly pathPrefix: string;
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
}
