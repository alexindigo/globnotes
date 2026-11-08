// SPDX-License-Identifier: LGPL-3.0-only
import {
  jsonValues,
  PluginContractError,
  record,
} from "../plugins/contracts.ts";
import { driverPath } from "../plugins/driver_contract.ts";
import type { ParsedMetadata } from "./parse.ts";

export const METADATA_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  body: 16 * 1024 * 1024,
  watches: 16,
});
export type MetadataRecord =
  & {
    path: string;
    pathKey: string;
    version: string;
    seq: number;
  }
  & ({ status: "ready" } & ParsedMetadata | {
    status: "unavailable";
    reason:
      | "reading"
      | "read_failed"
      | "too_large"
      | "invalid_utf8"
      | "parse_failed"
      | "record_too_large";
  });
export interface MetadataQuery {
  prefix?: string;
  property?: { key: string; equals: string };
  task?: { checked: boolean };
  offset: number;
  limit: number;
}
export interface MetadataPage {
  revision: string;
  cursor: number | null;
  catchingUp: boolean;
  total: number;
  rows: MetadataRecord[];
  unavailable: MetadataRecord[];
  nextOffset?: number;
}
export function metadataError(code = "metadata_invalid_query"): never {
  throw new PluginContractError(400, code, code);
}
export function metadataPath(value: unknown): string {
  if (typeof value !== "string" || !value.endsWith(".md")) {
    metadataError("metadata_invalid_path");
  }
  try {
    return driverPath(value);
  } catch {
    return metadataError("metadata_invalid_path");
  }
}
export function metadataQuery(value: unknown): MetadataQuery {
  const q = jsonValues(value);
  if (
    Object.keys(q).some((k) =>
      !["prefix", "property", "task", "offset", "limit"].includes(k)
    )
  ) metadataError();
  const offset = q.offset === undefined ? 0 : q.offset,
    limit = q.limit === undefined ? 50 : q.limit;
  if (
    !Number.isSafeInteger(offset) || (offset as number) < 0 ||
    !Number.isSafeInteger(limit) || (limit as number) < 1 ||
    (limit as number) > 128
  ) metadataError();
  let prefix: string | undefined;
  if (q.prefix !== undefined) {
    if (typeof q.prefix !== "string") metadataError();
    prefix = q.prefix;
    if (prefix) {
      try {
        prefix = driverPath(prefix);
      } catch {
        metadataError();
      }
    }
  }
  let property: MetadataQuery["property"], task: MetadataQuery["task"];
  if (q.property !== undefined) {
    const p = record(q.property, "metadata property");
    if (
      Object.keys(p).length !== 2 || typeof p.key !== "string" ||
      typeof p.equals !== "string" ||
      !p.key || p.key.length > 4096 || p.equals.length > 65536
    ) metadataError();
    property = { key: p.key, equals: p.equals };
  }
  if (q.task !== undefined) {
    const t = record(q.task, "metadata task");
    if (Object.keys(t).length !== 1 || typeof t.checked !== "boolean") {
      metadataError();
    }
    task = { checked: t.checked };
  }
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(property ? { property } : {}),
    ...(task ? { task } : {}),
    offset: offset as number,
    limit: limit as number,
  };
}
export function metadataBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function boundedRecord(record: MetadataRecord): MetadataRecord {
  return metadataBytes(record) <= METADATA_LIMITS.bytes - 2048 ? record : {
    path: record.path,
    pathKey: record.pathKey,
    version: record.version,
    seq: record.seq,
    status: "unavailable",
    reason: "record_too_large",
  };
}
