// SPDX-License-Identifier: LGPL-3.0-only
import type { InstanceConfig, VaultConfig } from "./schema.ts";
import { freeze, type LoadResult } from "./loader.ts";

export interface NotesSettings {
  scanCacheTtlMs: number;
}
export interface IndexSettings {
  batchSize: number;
  batchDelayMs: number;
}
export interface HubSettings {
  scanIntervalMs: number;
}
export interface SessionSettings {
  expirySeconds: number;
}

export interface PluginSettings {
  renderWorkers: number;
  autoEnable: boolean;
  autoEnablePin?: { value: boolean; source: "toml" | "environment" };
  addressed: { raw: string; source: "toml" | "environment" };
}

/** Saved plugin policy remains separate from explicit operator configuration. */
export function pluginSettings(
  instance: InstanceConfig,
  vault: LoadResult<VaultConfig>,
): PluginSettings {
  const layer = vault.provenance["plugins.autoenable"].layer;
  return freeze({
    renderWorkers: instance.plugins.renderworkers,
    autoEnable: vault.config.plugins.autoenable,
    ...(layer === "defaults" ? {} : {
      autoEnablePin: {
        value: vault.config.plugins.autoenable,
        source: layer === "env" ? "environment" as const : "toml" as const,
      },
    }),
    addressed: {
      raw: vault.config.plugins.settings,
      source: vault.provenance["plugins.settings"].layer === "env"
        ? "environment"
        : "toml",
    },
  });
}

/** Unit conversion belongs here, never in each consumer or its hot path. */
export function serviceSettings(instance: InstanceConfig) {
  return freeze({
    notes: { scanCacheTtlMs: instance.index.scancachettl * 1000 },
    index: {
      batchSize: instance.index.batchsize,
      batchDelayMs: instance.index.batchdelay * 1000,
    },
    hub: { scanIntervalMs: instance.hub.scaninterval * 1000 },
    sessions: { expirySeconds: instance.sessions.expirydays * 86_400 },
  });
}
