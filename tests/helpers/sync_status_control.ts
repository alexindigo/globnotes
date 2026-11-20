// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import type { FixtureScope } from "./fixture_scope.ts";
import type { ScopedPluginFixture } from "./plugin_fixture_engine.ts";
import type { ProcessOwner } from "./process_records.ts";
import {
  objectRecordSchema,
  openRecordDirectory,
  ownedRecordDirectory,
  recordChannel,
  type RecordDirectory,
  recordReader,
} from "./owned_record_channel.ts";

export interface SyncStatusControl {
  failureSince?: Record<string, number>;
  activities?: Record<string, "receiving" | "sending" | null>;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export const syncStatusSchema = objectRecordSchema<SyncStatusControl>(
  "Sync control",
  (value) => {
    if (
      Object.keys(value).some((key) =>
        key !== "failureSince" && key !== "activities"
      )
    ) throw new TypeError("Unknown Sync control field");
    if (
      value.failureSince !== undefined &&
      (!object(value.failureSince) ||
        Object.values(value.failureSince).some((at) =>
          typeof at !== "number" || !Number.isFinite(at)
        ))
    ) throw new TypeError("Invalid Sync failureSince");
    if (
      value.activities !== undefined &&
      (!object(value.activities) ||
        Object.values(value.activities).some((activity) =>
          activity !== null && activity !== "receiving" &&
          activity !== "sending"
        ))
    ) throw new TypeError("Invalid Sync activities");
    return value as SyncStatusControl;
  },
);
const directoryName = "sync-control", recordName = "status.json";
export const createSyncStatusDirectory = (
  scope: FixtureScope,
  state: string | ScopedPluginFixture,
) => ownedRecordDirectory(scope, state, directoryName);
export const syncStatusChannel = (
  directory: RecordDirectory,
  owner: ProcessOwner,
) => recordChannel(directory, recordName, syncStatusSchema, owner);
export const syncStatusReader = (
  scope: FixtureScope,
  state: string | RecordDirectory,
) =>
  recordReader(
    openRecordDirectory(
      scope,
      typeof state === "string" ? path.join(state, directoryName) : state,
    ),
    recordName,
    syncStatusSchema,
  );
