// SPDX-License-Identifier: LGPL-3.0-only
import { publishRecord } from "./process_records.ts";
import {
  decodeDriverStartup,
  type DriverStartupSnapshot,
  recordName,
} from "./driver_startup_schema.ts";
/** Private child publisher; fixture construction cannot import this module. */
export function publishDriverStartup(
  directory: string,
  snapshot: DriverStartupSnapshot,
) {
  publishRecord(
    `${directory}/${recordName}`,
    JSON.stringify(
      decodeDriverStartup(snapshot as unknown as Record<string, unknown>),
    ),
  );
}
