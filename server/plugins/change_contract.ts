// SPDX-License-Identifier: LGPL-3.0-only
import type { ChangeEntry, Vector } from "../hub/types.ts";
import type { BatchPart } from "../hub/store.ts";
import { PluginContractError } from "./contracts.ts";

export const CHANGES_API_VERSION = 1;
export const CHANGE_LIMITS = Object.freeze({
  entries: 128,
  bytes: 1024 * 1024,
  snapshotMs: 5 * 60 * 1000,
  retryMs: 5000,
  maxRetryMs: 5 * 60 * 1000,
});
export type GapReason =
  | "first_subscription"
  | "retention"
  | "log_replaced"
  | "future_cursor"
  | "authority_changed"
  | "snapshot_expired";
export interface SnapshotEntry {
  path: string;
  pathKey: string;
  hash: string;
  size: number;
  mtimeMs: number;
  vector: Vector;
  seq: number;
}
export type ChangePacket =
  | {
    type: "changes";
    logId: string;
    from: number;
    to: number;
    entries: ChangeEntry[];
    batches: BatchPart[];
    token: string;
  }
  | {
    type: "gap";
    gap: true;
    reason: GapReason;
    logId: string;
    next: number;
    resetId: string;
    token: string;
  }
  | {
    type: "snapshot";
    resetId: string;
    watermark: number;
    entries: SnapshotEntry[];
    page: number;
    complete: boolean;
    token: string;
  };

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function acknowledge(value: unknown, token: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { ack?: unknown }).ack === token;
}
/** Freeze at both sides of transport; functions and host authority never cross. */
export function freezePacket<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezePacket(item);
    Object.freeze(value);
  }
  return value;
}
export function checkPacket(packet: ChangePacket): ChangePacket {
  if (
    encodedBytes(packet) > CHANGE_LIMITS.bytes ||
    (packet.type !== "gap" && packet.entries.length > CHANGE_LIMITS.entries)
  ) {
    throw new PluginContractError(
      413,
      "changes_packet_too_large",
      "Change packet exceeds its bound",
    );
  }
  return freezePacket(packet);
}
