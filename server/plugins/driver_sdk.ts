// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DiscoveryPage,
  type Driver,
  DRIVER_LIMITS,
  type DriverCapabilities,
  type DriverError,
  type Endpoint,
  type ExportItem,
  type MutationResult,
  type ReadResult,
} from "./driver_contract.ts";

export type StorageErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "precondition_failed"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "invalid";

/** A mutation error must say whether the endpoint could have committed. Never
 * classify a lost reply as effect:none just because fetch rejected. */
export class StorageError extends Error {
  readonly effect: "none" | "unknown";
  readonly retryAfterMs?: number;
  constructor(
    readonly code: StorageErrorCode,
    options: {
      effect: "none" | "unknown";
      retryAfterMs?: number;
      message?: string;
    },
  ) {
    super(options.message ?? code);
    this.name = "StorageError";
    this.effect = options.effect;
    if (
      options.retryAfterMs !== undefined &&
      Number.isSafeInteger(options.retryAfterMs) && options.retryAfterMs >= 0
    ) this.retryAfterMs = options.retryAfterMs;
  }
}

export interface StorageProvider {
  identity(): Promise<Endpoint>;
  /** Keys in listings are canonical vault paths. A provider with encoded native
   * names decodes them here; name() maps canonical paths back for object IO. */
  list(cursor?: string): Promise<{
    entries: { key: string; size: number; etag: string }[];
    next?: string;
  }>;
  get(key: string): Promise<{ bytes: Uint8Array; etag: string }>;
  put(
    key: string,
    bytes: Uint8Array,
    condition: { ifMatch?: string; ifNoneMatch?: "*" },
  ): Promise<{ etag: string }>;
  delete(key: string, condition: { ifMatch?: string }): Promise<void>;
  conditions: { create: boolean; update: boolean; delete: boolean };
  exclude?(path: string): boolean;
  scope?(): string;
  name?(path: string):
    | { ok: true; key: string }
    | { ok: false; reason: string };
}

export const STORAGE_CONDITION_NOTICE =
  "This storage cannot check versions while writing; a change made there at the same moment can be overwritten.";

class NetworkDenied extends Error {
  readonly code = "network_denied";
  readonly effect = "none";
  readonly retryAfterMs = undefined;
  constructor() {
    super("Server network access is not approved");
  }
}
type ProviderFailure = StorageError | NetworkDenied;
function storageError(error: unknown, mutation = false): ProviderFailure {
  if (error instanceof StorageError) return error;
  if (
    error instanceof Error &&
    (error.name === "NotCapable" || error.name === "PermissionDenied")
  ) return new NetworkDenied();
  return new StorageError("network", { effect: mutation ? "unknown" : "none" });
}
function locked(error: ProviderFailure): boolean {
  return error.code === "unauthorized" || error.code === "forbidden";
}
function detail(error: ProviderFailure): DriverError {
  return {
    code: error.code === "rate_limited" || error.code === "network_denied"
      ? error.code
      : locked(error)
      ? "denied"
      : error.code === "invalid"
      ? "invalid"
      : "offline",
    message: error.message,
    ...(error.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: error.retryAfterMs }),
  };
}

/** Storage-shaped protocols share paging and conditional-mutation semantics, not
 * hub reconciliation or history. The lifecycle retains no file bodies. */
export function storageDriver(
  provider: StorageProvider,
  _options: { name?: string } = {},
  capabilities?: DriverCapabilities,
): Driver {
  if (
    !provider ||
    ["identity", "list", "get", "put", "delete"].some((method) =>
      typeof provider[method as keyof StorageProvider] !== "function"
    ) ||
    !provider.conditions ||
    ["create", "update", "delete"].some((op) =>
      typeof provider.conditions[op as keyof StorageProvider["conditions"]] !==
        "boolean"
    )
  ) {
    throw new TypeError(
      "A storage provider requires explicit methods and native-condition support",
    );
  }
  const conditions = Object.freeze({ ...provider.conditions });
  for (const op of ["create", "update", "delete"] as const) {
    if (capabilities?.mutations[op] === "conditional" && !conditions[op]) {
      throw new TypeError(
        "Native-condition support does not match the driver declaration",
      );
    }
  }
  let binding: { endpoint: Endpoint; scope: string } | undefined;
  const name = (path: string) =>
    provider.name?.(path) ?? { ok: true as const, key: path };
  const lifecycle: Driver = {
    async open() {
      try {
        binding = {
          endpoint: await provider.identity(),
          scope: provider.scope?.() ?? "all",
        };
        return { state: "ready", ...binding };
      } catch (cause) {
        const error = storageError(cause);
        return locked(error)
          ? { state: "locked", reason: error.message }
          : { state: "failed", error: detail(error) };
      }
    },
    async discover(request) {
      if (!binding || request.mode !== "snapshot") {
        throw new Error("Storage requires an opened snapshot session");
      }
      const page: DiscoveryPage = {
        ...binding,
        mode: "snapshot",
        entries: [],
        completion: "incomplete",
      };
      try {
        const listing = await provider.list(request.cursor);
        // Do not truncate an oversized provider page and claim completeness.
        if (listing.entries.length > DRIVER_LIMITS.entries) {
          throw new StorageError("invalid", { effect: "none" });
        }
        page.entries = listing.entries.map((entry) => ({
          ...(provider.exclude?.(entry.key)
            ? { state: "excluded" as const, path: entry.key }
            : {
              state: "known" as const,
              path: entry.key,
              revision: entry.etag,
              size: entry.size,
            }),
        }));
        if (listing.next !== undefined) page.cursor = listing.next;
        page.completion = listing.next === undefined ? "complete" : "more";
      } catch (cause) {
        const error = storageError(cause);
        page.entries = [{
          state: locked(error) ? "locked" : "unknown",
          reason: error.message,
        }];
        page.error = detail(error);
      }
      return page;
    },
    async read(request): Promise<ReadResult> {
      const target = name(request.path);
      if (!target.ok) return { state: "unknown", reason: target.reason };
      try {
        const result = await provider.get(target.key);
        // Current-only providers cannot label new bytes with an old ETag.
        if (result.etag !== request.revision) {
          return { state: "unknown", reason: "revision_changed" };
        }
        return { state: "known", revision: result.etag, bytes: result.bytes };
      } catch (cause) {
        const error = storageError(cause);
        return error.code === "not_found"
          ? { state: "absent" }
          : locked(error)
          ? { state: "locked", reason: error.message }
          : { state: "unknown", reason: error.message, error: detail(error) };
      }
    },
    async apply(items) {
      const results: MutationResult[] = [];
      let denied: DriverError | undefined;
      for (const item of items) {
        if (denied) {
          results.push({ id: item.id, state: "failed", error: denied });
          continue;
        }
        if (provider.exclude?.(item.path)) {
          results.push({ id: item.id, state: "excluded" });
          continue;
        }
        const operation = item.op === "delete"
          ? "delete"
          : "absent" in item.base
          ? "create"
          : "update";
        if (capabilities?.mutations[operation] === "none") {
          results.push({
            id: item.id,
            state: "unsupported",
            reason: "mutation_not_supported",
          });
          continue;
        }
        const target = name(item.path);
        if (!target.ok) {
          results.push({
            id: item.id,
            state: "unsupported",
            reason: target.reason,
          });
          continue;
        }
        let dispatched = false;
        try {
          const create = "absent" in item.base;
          const native = item.op === "delete"
            ? conditions.delete
            : create
            ? conditions.create
            : conditions.update;
          if (!native && !await checkBase(provider, target.key, item)) {
            results.push({ id: item.id, state: "conflict" });
            continue;
          }
          // Even an emulated check passes the original condition. A provider
          // without native support ignores it only after this fresh check.
          dispatched = true;
          if (item.op === "put") {
            const result = await provider.put(
              target.key,
              item.bytes!,
              create
                ? { ifNoneMatch: "*" }
                : { ifMatch: (item.base as { revision: string }).revision },
            );
            results.push({
              id: item.id,
              state: "settled",
              revision: result.etag,
            });
          } else {
            await provider.delete(target.key, {
              ifMatch: (item.base as { revision: string }).revision,
            });
            results.push({ id: item.id, state: "settled" });
          }
        } catch (cause) {
          const error = storageError(cause, dispatched);
          if (dispatched && error.effect === "unknown") {
            results.push({ id: item.id, state: "uncertain" });
          } else if (
            error.code === "precondition_failed" || error.code === "not_found"
          ) {
            results.push({ id: item.id, state: "conflict" });
          } else {
            const failure = detail(error);
            if (locked(error) || error.code === "network_denied") {
              denied = failure;
            }
            results.push({ id: item.id, state: "failed", error: failure });
          }
        }
      }
      return results;
    },
    close() {
      binding = undefined;
    },
  };
  return Object.freeze(lifecycle);
}

async function checkBase(
  provider: StorageProvider,
  key: string,
  item: ExportItem,
): Promise<boolean> {
  try {
    const current = await provider.get(key);
    return "revision" in item.base && current.etag === item.base.revision;
  } catch (cause) {
    if (cause instanceof StorageError && cause.code === "not_found") {
      return "absent" in item.base;
    }
    throw cause;
  }
}
