// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The one owner of MCP tool-call rate limiting (GLOBNOTES_MCP_RATE_LIMIT,
 * docs/mcp.md): at most `perMinute` tool calls per minute per client, as a
 * token bucket per client key. A bucket holds up to `perMinute` calls and
 * refills continuously at `perMinute` per minute, so a client may burst to
 * the limit and then proceeds at the limit's pace. Memory is bounded: at
 * most `maxClients` buckets are kept, and a new client's bucket replaces
 * the least recently used one (which has had the longest to refill). The
 * endpoint (server/mcp/endpoint.ts) decides the key and answers
 * a refusal with 429 and Retry-After.
 */

import { NATIVE_SCHEDULER } from "../observed_time.ts";

export type RateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  readonly perMinute: number;
  /** Take `calls` tool calls from `key`'s budget, or refuse them all. */
  take(key: string, calls: number): RateDecision;
  /** Buckets currently kept (bounded by maxClients). */
  size(): number;
}

export interface RateLimiterOptions {
  /** Tool calls per minute per client; 0 disables limiting (null). */
  perMinute: number;
  /** Most clients tracked at once. */
  maxClients?: number;
  /** Monotonic milliseconds; tests inject a fake. */
  now?: () => number;
}

const MINUTE_MS = 60_000;
export const DEFAULT_MAX_CLIENTS = 10_000;

interface Bucket {
  tokens: number;
  at: number;
}

/** A limiter, or null when `perMinute` is 0 (no limit). */
export function createRateLimiter(
  options: RateLimiterOptions,
): RateLimiter | null {
  const { perMinute } = options;
  if (perMinute === 0) return null;
  if (!Number.isInteger(perMinute) || perMinute < 0) {
    throw new RangeError("perMinute must be a non-negative integer");
  }
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const now = options.now ?? (() => NATIVE_SCHEDULER.now());
  const perMs = perMinute / MINUTE_MS;
  /** Insertion order is use order: a used bucket is re-inserted. */
  const buckets = new Map<string, Bucket>();

  const level = (bucket: Bucket, at: number) =>
    Math.min(perMinute, bucket.tokens + (at - bucket.at) * perMs);

  /** Make room for one more bucket: drop the least recently used. */
  const evict = () => {
    while (buckets.size >= maxClients) {
      buckets.delete(buckets.keys().next().value!);
    }
  };

  return {
    perMinute,
    size: () => buckets.size,
    take(key, calls) {
      if (calls <= 0) return { allowed: true };
      const at = now();
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key);
      } else {
        evict();
        bucket = { tokens: perMinute, at };
      }
      const tokens = level(bucket, at);
      const allowed = calls <= tokens;
      buckets.set(key, { tokens: allowed ? tokens - calls : tokens, at });
      if (allowed) return { allowed: true };
      // More calls than the whole budget wait for a full bucket.
      const missing = Math.min(calls, perMinute) - tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(missing / perMs / 1000)),
      };
    },
  };
}
