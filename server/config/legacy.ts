// SPDX-License-Identifier: LGPL-3.0-only
/** Temporary pre-cutover composition adapter. Remove in step 8, not a v3 alias layer. */
import { type Environment, processEnvironment } from "../environment.ts";
import { getEnv } from "../helpers.ts";
import { isLogLevel, type LogLevel } from "../logger.ts";
import { loadInstanceConfig } from "./loader.ts";
import type { InstanceConfig } from "./schema.ts";
import type {
  HubSettings,
  IndexSettings,
  NotesSettings,
  SessionSettings,
} from "./consumers.ts";

export type LegacyInput<T> = T | Environment;
let defaults: InstanceConfig | undefined;
function baseline(): InstanceConfig {
  return defaults ??= loadInstanceConfig({ env: {}, overlayPath: null }).config;
}

export function notesSettings(
  input: LegacyInput<NotesSettings> = processEnvironment,
): NotesSettings {
  if (!("get" in input)) return Object.freeze({ ...input });
  return Object.freeze({
    scanCacheTtlMs: Number(
      input.get("GLOBNOTES_SCAN_CACHE_TTL") ?? baseline().index.scancachettl,
    ) * 1000,
  });
}
export function indexSettings(
  input: LegacyInput<IndexSettings> = processEnvironment,
): IndexSettings {
  if (!("get" in input)) return Object.freeze({ ...input });
  return Object.freeze({
    batchSize: Number(
      input.get("GLOBNOTES_INDEX_BATCH_SIZE") ?? baseline().index.batchsize,
    ),
    batchDelayMs: Number(
      input.get("GLOBNOTES_INDEX_BATCH_DELAY") ?? baseline().index.batchdelay,
    ) * 1000,
  });
}
export function hubSettings(
  input: LegacyInput<HubSettings> = processEnvironment,
): HubSettings {
  if (!("get" in input)) return Object.freeze({ ...input });
  const scanIntervalMs = Number(
    getEnv("GLOBNOTES_HUB_SCAN_INTERVAL", {
      default: baseline().hub.scaninterval,
    }, input),
  ) * 1000;
  if (!(scanIntervalMs > 0) || !Number.isFinite(scanIntervalMs)) {
    throw new Error("GLOBNOTES_HUB_SCAN_INTERVAL must be positive");
  }
  return Object.freeze({ scanIntervalMs });
}
export function sessionSettings(
  input: LegacyInput<SessionSettings> = processEnvironment,
): SessionSettings {
  if (!("get" in input)) return Object.freeze({ ...input });
  return Object.freeze({
    expirySeconds: Number(
      getEnv("GLOBNOTES_SESSION_EXPIRY_DAYS", {
        castInt: true,
        default: baseline().sessions.expirydays,
      }, input),
    ) * 86_400,
  });
}
export function legacyLogLevel(
  env: Environment = processEnvironment,
): LogLevel {
  const value = (env.get("LOGLEVEL") ?? baseline().log.level).toUpperCase();
  return isLogLevel(value) ? value : baseline().log.level as LogLevel;
}
export function legacyServiceSettings(env: Environment = processEnvironment) {
  return {
    notes: notesSettings(env),
    index: indexSettings(env),
    hub: hubSettings(env),
    sessions: sessionSettings(env),
  };
}
