// SPDX-License-Identifier: LGPL-3.0-only
import { objectRecordSchema } from "./record_schema.ts";
export interface DriverStartupSnapshot {
  pid: number;
  owner: string;
  pending: boolean;
  states: Record<string, string>;
  failure: string | null;
}
export const recordName = "initial.json";
export const decodeDriverStartup = (
  value: Record<string, unknown>,
): DriverStartupSnapshot => {
  if (
    Object.keys(value).sort().join(",") !==
      "failure,owner,pending,pid,states" ||
    !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
    typeof value.owner !== "string" || !value.owner ||
    typeof value.pending !== "boolean" ||
    !(value.failure === null || typeof value.failure === "string") ||
    !value.states || typeof value.states !== "object" ||
    Array.isArray(value.states) ||
    Object.values(value.states).some((state) => typeof state !== "string")
  ) throw new TypeError("Invalid driver initial-cycle snapshot");
  return value as unknown as DriverStartupSnapshot;
};
export const driverStartupSchema = objectRecordSchema(
  "driver initial cycle",
  decodeDriverStartup,
);
