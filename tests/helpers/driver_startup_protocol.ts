// SPDX-License-Identifier: LGPL-3.0-only
import { publishRecord } from "./process_records.ts";
import {
  decodeDriverStartup,
  type DriverStartupSnapshot,
  recordName,
  startupFailurePrefix,
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

export function reportDriverStartupFailure(
  error: unknown,
  writer: { writeSync(bytes: Uint8Array): number } = Deno.stderr,
) {
  const write = writer.writeSync.bind(writer);
  let failure: string;
  try {
    failure = String(error);
  } catch {
    failure = "Unprintable driver startup observation failure";
  }
  const frame = new TextEncoder().encode(
    startupFailurePrefix + JSON.stringify({ failure }) + "\n",
  );
  for (let offset = 0; offset < frame.length;) {
    const written = write(frame.subarray(offset));
    if (
      !Number.isSafeInteger(written) || written <= 0 ||
      written > frame.length - offset
    ) {
      throw Error("Driver startup failure transport made no progress");
    }
    offset += written;
  }
}
