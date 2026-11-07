// SPDX-License-Identifier: LGPL-3.0-only
import type { FileState } from "../types.ts";
import type { PeerFile } from "./peers.ts";

export interface PlannedExport {
  pathKey: string;
  path: string;
  op: "put" | "delete";
  version: string | null;
  batch: number;
  base: { revision: string } | { absent: true };
}
export type ExportDisposition =
  | { kind: "none" | "delete-pending" | "too_large" }
  | { kind: "send"; item: PlannedExport };

/** State, never authorship, decides echo suppression. Names are transient. */
export function planExport(
  input: {
    pathKey: string;
    path?: string;
    file: FileState | null;
    mapping: PeerFile | null;
    batch: number;
    now: number;
  },
): ExportDisposition {
  const { mapping, file } = input;
  if (
    mapping &&
    (["excluded", "unsupported", "held", "uncertain"].includes(mapping.state) ||
      mapping.nextAt > input.now)
  ) return { kind: "none" };
  if (file) {
    if (mapping?.version === file.hash) return { kind: "none" };
    if (file.size > 16 * 1024 * 1024) return { kind: "too_large" };
    return {
      kind: "send",
      item: {
        pathKey: input.pathKey,
        path: file.diskPath,
        op: "put",
        version: file.hash,
        batch: input.batch,
        base: mapping?.revision
          ? { revision: mapping.revision }
          : { absent: true },
      },
    };
  }
  if (!mapping?.revision) return { kind: "none" };
  if (!input.path) return { kind: "delete-pending" };
  return {
    kind: "send",
    item: {
      pathKey: input.pathKey,
      path: input.path,
      op: "delete",
      version: null,
      batch: input.batch,
      base: { revision: mapping.revision },
    },
  };
}

/** Preserve native batches where they fit, put before delete for emulated moves. */
export function exportUnits(
  items: PlannedExport[],
  maxBatch: number,
): PlannedExport[][] {
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 64) {
    throw new TypeError("Invalid maxBatch");
  }
  const batches = new Map<number, PlannedExport[]>();
  for (const item of items) {
    const batch = batches.get(item.batch) ?? [];
    batch.push(item);
    batches.set(item.batch, batch);
  }
  const units: PlannedExport[][] = [];
  let unit: PlannedExport[] = [];
  for (const batch of batches.values()) {
    batch.sort((a, b) => Number(a.op === "delete") - Number(b.op === "delete"));
    if (unit.length + batch.length > maxBatch && unit.length) {
      units.push(unit);
      unit = [];
    }
    for (const item of batch) {
      unit.push(item);
      if (unit.length === maxBatch) {
        units.push(unit);
        unit = [];
      }
    }
  }
  if (unit.length) units.push(unit);
  return units;
}
