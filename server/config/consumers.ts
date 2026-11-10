// SPDX-License-Identifier: LGPL-3.0-only
import type { InstanceConfig } from "./schema.ts";
import { freeze } from "./loader.ts";

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
