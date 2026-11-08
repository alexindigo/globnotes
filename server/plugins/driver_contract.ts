// SPDX-License-Identifier: LGPL-3.0-only

/** Driver API 1. Wire values never select a peer or confer vault authority. */
import { PluginContractError } from "./contracts.ts";
import type { WorkerMessage } from "./contracts.ts";

export const DRIVER_API_VERSION = 1;
export const DRIVER_LIMITS = Object.freeze({
  textBytes: 4096,
  entries: 1000,
  metadataBytes: 1024 * 1024,
  bodyBytes: 16 * 1024 * 1024,
  maxBatch: 64,
  unitFiles: 256,
  unitBytes: 64 * 1024 * 1024,
  openMs: 30_000,
  discoverMs: 30_000,
  closeMs: 30_000,
  readMs: 120_000,
  applyMs: 120_000,
});
export interface DriverCapabilities {
  discovery: { snapshot: true; delta: boolean };
  revisions: "exact" | "none";
  mutations: {
    create: "conditional" | "emulated" | "none";
    update: "conditional" | "emulated" | "none";
    delete: "conditional" | "emulated" | "none";
    move: "native" | "none";
  };
  groups: "atomic" | "none";
  history: { baseText: boolean };
  limits: { maxBatch: number };
}
export interface Endpoint {
  id: string;
  epoch: string;
}
export interface DriverError {
  code:
    | "offline"
    | "rate_limited"
    | "denied"
    | "network_denied"
    | "invalid"
    | "internal";
  retryAfterMs?: number;
  message?: string;
}
export type OpenResult =
  | { state: "ready"; endpoint: Endpoint; scope: string }
  | { state: "locked"; reason: string }
  | { state: "failed"; error: DriverError };
export type Entry =
  | {
    state: "known";
    path: string;
    revision: string;
    size?: number;
    group?: string;
  }
  | { state: "absent"; path: string; proof: "native-delete" }
  | { state: "unknown"; path?: string; reason: string }
  | { state: "excluded"; path: string }
  | { state: "locked"; path?: string; reason: string };
export interface DiscoveryPage {
  endpoint: Endpoint;
  scope: string;
  mode: "snapshot" | "delta";
  entries: Entry[];
  groups?: { id: string; members: string[] }[];
  cursor?: string;
  completion: "more" | "complete" | "incomplete";
  /** Typed failure advice, only on incomplete discovery. Never proves absence.
   * Added in M5 answer 3 so providers need not encode errors in reason strings. */
  error?: DriverError;
}
export interface DiscoverRequest {
  mode: "snapshot" | "delta";
  cursor?: string;
}
export interface ReadRequest {
  path: string;
  revision: string;
}
export type ReadResult =
  | {
    state: "known";
    revision: string;
    bytes: Uint8Array;
    baseText?: string;
  }
  | { state: "absent" }
  /** A failed read remains unknown. Optional typed advice is consumed without
   * advancing discovery or inventing absence (M5 answer 3). */
  | { state: "unknown"; reason: string; error?: DriverError }
  | { state: "locked"; reason: string };
export interface ExportItem {
  id: string;
  op: "put" | "delete";
  path: string;
  batch: number;
  bytes?: Uint8Array;
  base: { revision: string } | { absent: true };
  from?: string;
}
export type MutationResult =
  | { id: string; state: "settled"; revision?: string }
  | { id: string; state: "conflict" | "uncertain" | "excluded" }
  | { id: string; state: "failed"; error: DriverError }
  | { id: string; state: "unsupported"; reason: string };
export interface Driver {
  open(): OpenResult | Promise<OpenResult>;
  discover(request: DiscoverRequest): DiscoveryPage | Promise<DiscoveryPage>;
  read(request: ReadRequest): ReadResult | Promise<ReadResult>;
  apply(items: ExportItem[]): MutationResult[] | Promise<MutationResult[]>;
  close(): void | Promise<void>;
}
export const DRIVER_METHODS = [
  "open",
  "discover",
  "read",
  "apply",
  "close",
] as const;
export type DriverMethod = typeof DRIVER_METHODS[number];
export interface DriverInstanceSnapshot {
  id: string;
  label: string;
  settings: Record<string, unknown>;
}

/** Values are host-held per instance. Omitted required preserves API 1's
 * pre-Worker lock; optional keys are checked by the selected provider in open. */
export interface DriverSecretDeclaration {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
}

export class DriverContractError extends PluginContractError {
  constructor(detail = "Invalid driver API value") {
    super(422, "driver_contract_violation", detail);
  }
}
function invalid(): never {
  // No untrusted value enters an error message (it could contain a key).
  throw new DriverContractError();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) invalid();
  return value as Record<string, unknown>;
}
function boundedText(
  value: unknown,
  max: number = DRIVER_LIMITS.textBytes,
): string {
  if (typeof value !== "string" || !value || value.includes("\0")) invalid();
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > max || new TextDecoder().decode(encoded) !== value) {
    invalid();
  }
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < 0 ||
    (value as number) > max
  ) {
    invalid();
  }
  return value as number;
}
function oneOf(value: unknown, choices: readonly string[]): string {
  if (typeof value !== "string" || !choices.includes(value)) invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
/** Lexical boundary; canonical state, links and NFC disk collisions are checked
 * again by the hub's path owner before a file operation. */
export function driverPath(value: unknown): string {
  const name = boundedText(value, 4096);
  if (
    name.includes("\\") ||
    name.split("/").some((segment) =>
      !segment || segment === "." || segment === ".." ||
      segment.startsWith(".globnotes-staging-")
    )
  ) invalid();
  return name;
}
function revision(value: unknown): string {
  return boundedText(value, 512);
}
function endpoint(value: unknown): Endpoint {
  const raw = object(value, ["id", "epoch"]);
  return { id: boundedText(raw.id), epoch: boundedText(raw.epoch) };
}
function metadata(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid();
  }
  if (
    !encoded ||
    new TextEncoder().encode(encoded).length > DRIVER_LIMITS.metadataBytes
  ) {
    invalid();
  }
}
function driverError(value: unknown): DriverError {
  const raw = object(value, ["code", "retryAfterMs", "message"]);
  oneOf(raw.code, [
    "offline",
    "rate_limited",
    "denied",
    "network_denied",
    "invalid",
    "internal",
  ]);
  if (raw.retryAfterMs !== undefined) integer(raw.retryAfterMs);
  if (raw.message !== undefined) boundedText(raw.message);
  return raw as unknown as DriverError;
}
export function validateDriverCapabilities(value: unknown): DriverCapabilities {
  metadata(value);
  const raw = object(value, [
    "discovery",
    "revisions",
    "mutations",
    "groups",
    "history",
    "limits",
  ]);
  const discovery = object(raw.discovery, ["snapshot", "delta"]);
  if (discovery.snapshot !== true) invalid();
  boolean(discovery.delta);
  oneOf(raw.revisions, ["exact", "none"]);
  const mutations = object(raw.mutations, [
    "create",
    "update",
    "delete",
    "move",
  ]);
  for (const op of ["create", "update", "delete"]) {
    oneOf(mutations[op], ["conditional", "emulated", "none"]);
  }
  oneOf(mutations.move, ["native", "none"]);
  oneOf(raw.groups, ["atomic", "none"]);
  boolean(object(raw.history, ["baseText"]).baseText);
  const max = integer(
    object(raw.limits, ["maxBatch"]).maxBatch,
    DRIVER_LIMITS.maxBatch,
  );
  if (!max) invalid();
  return structuredClone(raw) as unknown as DriverCapabilities;
}
export function validateOpenResult(value: unknown): OpenResult {
  metadata(value);
  const raw = object(value, ["state", "endpoint", "scope", "reason", "error"]);
  if (raw.state === "ready") {
    object(raw, ["state", "endpoint", "scope"]);
    endpoint(raw.endpoint);
    boundedText(raw.scope);
  } else if (raw.state === "locked") {
    object(raw, ["state", "reason"]);
    boundedText(raw.reason);
  } else if (raw.state === "failed") {
    object(raw, ["state", "error"]);
    driverError(raw.error);
  } else invalid();
  return structuredClone(raw) as unknown as OpenResult;
}
export function validateDiscoveryPage(
  value: unknown,
  caps: DriverCapabilities,
  request: DiscoverRequest,
  binding: { endpoint: Endpoint; scope: string },
): DiscoveryPage {
  metadata(value);
  const raw = object(value, [
    "endpoint",
    "scope",
    "mode",
    "entries",
    "groups",
    "cursor",
    "completion",
    "error",
  ]);
  const identity = endpoint(raw.endpoint);
  if (
    identity.id !== binding.endpoint.id ||
    identity.epoch !== binding.endpoint.epoch ||
    raw.scope !== binding.scope || raw.mode !== request.mode ||
    (raw.mode === "delta" && !caps.discovery.delta)
  ) invalid();
  oneOf(raw.completion, ["more", "complete", "incomplete"]);
  if (raw.error !== undefined) {
    if (raw.completion !== "incomplete") invalid();
    driverError(raw.error);
  }
  if (raw.cursor !== undefined) boundedText(raw.cursor, 64 * 1024);
  if (
    raw.completion === "more" && (!raw.cursor || raw.cursor === request.cursor)
  ) invalid();
  if (
    !Array.isArray(raw.entries) || raw.entries.length > DRIVER_LIMITS.entries
  ) invalid();
  const names = new Set<string>();
  const entries = raw.entries.map((value) => {
    const entry = object(value, [
      "state",
      "path",
      "revision",
      "size",
      "group",
      "proof",
      "reason",
    ]);
    if (entry.state === "known") {
      object(entry, ["state", "path", "revision", "size", "group"]);
      driverPath(entry.path);
      revision(entry.revision);
      if (entry.size !== undefined) integer(entry.size);
      if (entry.group !== undefined) boundedText(entry.group, 512);
    } else if (entry.state === "absent") {
      object(entry, ["state", "path", "proof"]);
      if (raw.mode !== "delta" || entry.proof !== "native-delete") invalid();
      driverPath(entry.path);
    } else if (entry.state === "excluded") {
      object(entry, ["state", "path"]);
      driverPath(entry.path);
    } else if (entry.state === "unknown" || entry.state === "locked") {
      object(entry, ["state", "path", "reason"]);
      if (entry.path !== undefined) driverPath(entry.path);
      boundedText(entry.reason);
    } else invalid();
    if (entry.path !== undefined) {
      const key = (entry.path as string).normalize("NFC");
      if (names.has(key)) invalid();
      names.add(key);
    }
    return entry as unknown as Entry;
  });
  const grouped = new Map<string, string>();
  if (raw.groups !== undefined) {
    if (
      !Array.isArray(raw.groups) || raw.groups.length > DRIVER_LIMITS.entries
    ) invalid();
    const ids = new Set<string>();
    for (const value of raw.groups) {
      const group = object(value, ["id", "members"]);
      const id = boundedText(group.id, 512);
      if (ids.has(id)) invalid();
      ids.add(id);
      if (
        !Array.isArray(group.members) || !group.members.length ||
        group.members.length > DRIVER_LIMITS.entries
      ) invalid();
      for (const member of group.members) {
        const key = driverPath(member).normalize("NFC");
        if (!names.has(key) || grouped.has(key)) invalid();
        grouped.set(key, id);
      }
    }
  }
  for (const entry of entries) {
    if (
      entry.state === "known" && entry.group !== undefined &&
      grouped.get(entry.path.normalize("NFC")) !== entry.group
    ) invalid();
  }
  return structuredClone(raw) as unknown as DiscoveryPage;
}
export function validateReadResult(
  value: unknown,
  caps: DriverCapabilities,
): ReadResult {
  const raw = object(value, [
    "state",
    "revision",
    "bytes",
    "baseText",
    "reason",
    "error",
  ]);
  if (raw.state === "known") {
    object(raw, ["state", "revision", "bytes", "baseText"]);
    revision(raw.revision);
    if (
      !(raw.bytes instanceof Uint8Array) ||
      raw.bytes.byteLength > DRIVER_LIMITS.bodyBytes
    ) invalid();
    if (raw.baseText !== undefined) {
      if (
        !caps.history.baseText || typeof raw.baseText !== "string" ||
        new TextEncoder().encode(raw.baseText).length > DRIVER_LIMITS.bodyBytes
      ) invalid();
    }
  } else if (raw.state === "absent") object(raw, ["state"]);
  else if (raw.state === "unknown" || raw.state === "locked") {
    object(
      raw,
      raw.state === "unknown"
        ? ["state", "reason", "error"]
        : ["state", "reason"],
    );
    boundedText(raw.reason);
    if (raw.error !== undefined) driverError(raw.error);
  } else invalid();
  return structuredClone(raw) as unknown as ReadResult;
}
/** Validate host output too; a batch is copied once so later mutations cannot
 * change the bytes or bases that the invocation describes. */
export function validateExportItems(
  value: unknown,
  caps: DriverCapabilities,
): ExportItem[] {
  if (
    !Array.isArray(value) || !value.length ||
    value.length > caps.limits.maxBatch
  ) invalid();
  let total = 0;
  const ids = new Set<string>();
  for (const valueItem of value) {
    const raw = object(valueItem, [
      "id",
      "op",
      "path",
      "batch",
      "bytes",
      "base",
      "from",
    ]);
    const id = boundedText(raw.id, 128);
    if (ids.has(id)) invalid();
    ids.add(id);
    driverPath(raw.path);
    if (!integer(raw.batch)) invalid();
    const base = object(raw.base, ["revision", "absent"]);
    if (Object.hasOwn(base, "revision")) {
      object(base, ["revision"]);
      revision(base.revision);
    } else if (base.absent !== true || Object.keys(base).length !== 1) {
      invalid();
    }
    if (raw.op === "put") {
      if (
        !(raw.bytes instanceof Uint8Array) ||
        raw.bytes.byteLength > DRIVER_LIMITS.bodyBytes
      ) invalid();
      total += raw.bytes.byteLength;
      if (raw.from !== undefined) {
        if (caps.mutations.move !== "native") invalid();
        driverPath(raw.from);
      }
    } else if (raw.op === "delete") {
      if (
        raw.bytes !== undefined || raw.from !== undefined ||
        base.absent === true
      ) invalid();
    } else invalid();
  }
  if (total > DRIVER_LIMITS.bodyBytes) invalid();
  // Omit binary bodies from the metadata budget.
  metadata(value.map(({ bytes: _bytes, ...item }) => item));
  return structuredClone(value) as ExportItem[];
}
export function validateMutationResults(
  value: unknown,
  items: ExportItem[],
): MutationResult[] {
  metadata(value);
  if (!Array.isArray(value) || value.length !== items.length) invalid();
  const expected = new Map(items.map((item) => [item.id, item]));
  for (const input of value) {
    const raw = object(input, ["id", "state", "revision", "error", "reason"]);
    const item = expected.get(raw.id as string);
    if (!item) invalid();
    expected.delete(item.id);
    if (raw.state === "settled") {
      object(raw, ["id", "state", "revision"]);
      if (item.op === "put" || raw.revision !== undefined) {
        revision(raw.revision);
      }
    } else if (
      ["conflict", "uncertain", "excluded"].includes(raw.state as string)
    ) {
      object(raw, ["id", "state"]);
    } else if (raw.state === "failed") {
      object(raw, ["id", "state", "error"]);
      driverError(raw.error);
    } else if (raw.state === "unsupported") {
      object(raw, ["id", "state", "reason"]);
      boundedText(raw.reason);
    } else invalid();
  }
  return structuredClone(value) as MutationResult[];
}

/** Check transport control fields before the shared host can act on them. The
 * method-specific result body is validated at DriverWorker's typed boundary. */
export function validateDriverEnvelope(
  value: unknown,
): asserts value is WorkerMessage {
  const raw = object(value, [
    "type",
    "generation",
    "exports",
    "lateMs",
    "value",
    "handlerId",
    "registration",
    "id",
    "contextId",
    "ok",
    "method",
    "args",
    "pre",
  ]);
  boundedText(raw.generation, 128);
  if (raw.type === "heartbeat") {
    object(raw, ["type", "generation", "lateMs"]);
    if (
      raw.lateMs !== undefined &&
      (typeof raw.lateMs !== "number" || !Number.isFinite(raw.lateMs) ||
        raw.lateMs < 0)
    ) invalid();
  } else if (raw.type === "ready") {
    object(raw, ["type", "generation", "exports"]);
    if (!Array.isArray(raw.exports) || raw.exports.length > 128) invalid();
    for (const name of raw.exports) boundedText(name, 128);
  } else if (raw.type === "initError") {
    object(raw, ["type", "generation", "value"]);
    boundedText(raw.value);
  } else if (raw.type === "register" || raw.type === "unregister") {
    object(
      raw,
      raw.type === "register"
        ? ["type", "generation", "handlerId", "registration"]
        : ["type", "generation", "handlerId"],
    );
    boundedText(raw.handlerId, 128);
    if (raw.type === "register") {
      const registration = object(raw.registration, ["kind", "id"]);
      if (registration.kind !== "driver") invalid();
      oneOf(registration.id, DRIVER_METHODS);
    }
  } else if (raw.type === "result") {
    object(raw, ["type", "generation", "id", "contextId", "ok", "value"]);
    if (!integer(raw.id)) invalid();
    boundedText(raw.contextId, 128);
    boolean(raw.ok);
    if (!raw.ok) boundedText(raw.value);
  } else if (raw.type === "rpc") {
    object(raw, [
      "type",
      "generation",
      "id",
      "method",
      "args",
      "pre",
      "contextId",
    ]);
    if (!integer(raw.id)) invalid();
    boundedText(raw.contextId, 128);
    if (raw.pre !== false || !Array.isArray(raw.args)) invalid();
    if (raw.method === "driver.secret") {
      if (raw.args.length !== 1) invalid();
      boundedText(raw.args[0], 32);
    } else if (raw.method !== "driver.hint" || raw.args.length !== 0) invalid();
  } else invalid();
}
