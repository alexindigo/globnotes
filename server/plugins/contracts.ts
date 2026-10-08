// SPDX-License-Identifier: LGPL-3.0-only

/** Serializable plugin contract. Authority always comes from the owning host. */
import type { Source } from "./network_contracts.ts";
export const PLUGIN_CONTRACT_VERSION = 1;
export const PLUGIN_LIMITS = Object.freeze({
  activationMs: 10_000,
  disposalMs: 10_000,
  preHookMs: 5_000,
  preOperationMs: 30_000,
  serviceCallMs: 30_000,
  queuedJobs: 64,
  completedReceipts: 256,
  causalDepth: 8,
  httpBytes: 16 * 1024 * 1024,
  controlBytes: 1024 * 1024,
  streamHeartbeatMs: 15_000,
});
export type PluginLimits = { [Key in keyof typeof PLUGIN_LIMITS]: number };

export const CANCELLABLE_ACTIONS = [
  "create",
  "save",
  "rename",
  "delete",
  "upload",
  "rewrite-refs",
  "file-write",
] as const;
export type CancellableAction = typeof CANCELLABLE_ACTIONS[number];
export type OperationAction = CancellableAction | "sync";
export type HookName =
  | `pre-${CancellableAction}`
  | `on-${OperationAction}`
  | "on-settings-change"
  | "on-operation-error"
  | "on-action-result";
export const HOOK_NAMES: readonly HookName[] = Object.freeze([
  ...CANCELLABLE_ACTIONS.map((a) => `on-${a}` as HookName),
  "on-sync",
  "on-settings-change",
  "on-operation-error",
  "on-action-result",
  ...CANCELLABLE_ACTIONS.map((a) => `pre-${a}` as HookName),
]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonValues;
export interface JsonValues {
  [key: string]: JsonValue;
}
export interface RevisionedValues {
  schemaVersion: 1;
  revision: number;
  values: JsonValues;
}

export type PluginStatus =
  | "discovered"
  | "disabled"
  | "starting"
  | "ready"
  | "failed"
  | "stopping";
export interface PluginDiagnostic {
  code: string;
  detail: string;
  operationId?: string;
  action?: string;
}
export type FieldKind =
  | "toggle"
  | "text"
  | "textarea"
  | "number"
  | "slider"
  | "select"
  | "file"
  | "folder"
  | "color";
export interface SettingsField {
  key: string;
  label: string;
  type: FieldKind;
  default: string | number | boolean;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  options?: { label: string; value: string | number | boolean }[];
  visibleWhen?: { field: string; equals: string | number | boolean };
}
export interface SettingsGroup {
  id: string;
  label: string;
  description?: string;
  fields: string[];
}
export interface SettingsPage {
  id: string;
  label: string;
  description?: string;
  renderer: { kind: "declarative-v1"; version: 1 };
  fields: SettingsField[];
  groups?: SettingsGroup[];
}
export interface CommandDefinition {
  id: string;
  label: string;
  target: "server" | "browser" | "editor";
  context?: "app" | "note" | "editing";
  description?: string;
}
export interface HandlerRegistration {
  kind: "hook" | "command" | "settings-change" | "action-result" | "endpoint";
  id: string;
  definition?: CommandDefinition | EndpointDescriptor;
}
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type HttpMethod = typeof HTTP_METHODS[number];
export interface EndpointDescriptor {
  method: HttpMethod;
  pattern: string;
}
export interface PluginHttpRequest {
  method: HttpMethod;
  path: string;
  params: Record<string, string | number | bigint>;
  query: [string, string][];
  headers: [string, string][];
  body: Uint8Array;
}
export interface PluginHttpResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}
export interface NoteSnapshot {
  path: string;
  content?: string;
  lastModified?: number;
  contentAvailable: boolean;
}
export interface OperationFact {
  operationId: string;
  action:
    | OperationAction
    | "settings-change"
    | "operation-error"
    | "action-result";
  origin: "api" | "plugin" | "external";
  timestamp: string;
  causalParent?: string;
  causalPlugin?: string;
  causalDepth?: number;
  path?: string;
  oldPath?: string;
  newPath?: string;
  before?: NoteSnapshot | null;
  proposed?: NoteSnapshot | null;
  after?: NoteSnapshot | null;
  contentChanged?: boolean;
  initial?: boolean;
  changedPaths?: string[];
  metadata?: JsonValues;
}
export interface ActionReceipt {
  requestId: string;
  status:
    | "accepted"
    | "running"
    | "completed"
    | "failed"
    | "partial"
    | "unknown"
    | "unavailable";
  operationId?: string;
  result?: unknown;
  error?: PluginDiagnostic;
}
/** No Request/Response, credentials or host context can cross these envelopes. */
export interface InvocationReference {
  id: string;
  kind: "background" | "invocation" | "disposal";
  pre: boolean;
}
export type HostMessage =
  | {
    type: "init";
    generation: string;
    role: "render" | "service";
    pluginUrl?: string;
    endpointsUrl?: string;
    hooks: HookName[];
    snapshot: JsonValues;
    context: InvocationReference;
    permissionsSource?: Source;
  }
  | {
    type: "invoke";
    generation: string;
    id: number;
    handlerId: string;
    args: unknown[];
    pre: boolean;
    context: InvocationReference;
  }
  | {
    type: "call";
    generation: string;
    id: number;
    fn: string;
    args: unknown[];
    context: InvocationReference;
  }
  | {
    type: "dispose";
    generation: string;
    id: number;
    context: InvocationReference;
  }
  | {
    type: "rpcResponse";
    generation: string;
    id: number;
    ok: boolean;
    value: unknown;
    error?: { status: number; code: string };
    receiptRequired?: boolean;
  };
export type WorkerMessage =
  | { type: "ready"; generation: string; exports: string[] }
  | { type: "rpcReceipt"; generation: string; id: number }
  | { type: "heartbeat"; generation: string }
  | { type: "initError"; generation: string; value: string }
  | {
    type: "result";
    generation: string;
    id: number;
    contextId: string;
    ok: boolean;
    value: unknown;
  }
  | {
    type: "register";
    generation: string;
    handlerId: string;
    registration: HandlerRegistration;
  }
  | { type: "unregister"; generation: string; handlerId: string }
  | {
    type: "rpc";
    generation: string;
    id: number;
    method: string;
    args: unknown[];
    pre: boolean;
    contextId: string;
  };

export class PluginContractError extends Error {
  constructor(readonly status: number, readonly code: string, detail: string) {
    super(detail);
    this.name = "PluginContractError";
  }
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginContractError(
      422,
      "invalid_plugin_value",
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}
export function stableId(value: unknown, label: string): string {
  if (
    typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ||
    value.length > 128
  ) {
    throw new PluginContractError(
      422,
      "invalid_plugin_id",
      `${label} must be a stable basename ID`,
    );
  }
  return value;
}
/** Preserve v2's directory identity, independently of new page/field/command keys. */
export function pluginId(value: unknown): string {
  const id = text(value, "plugin id");
  if (
    id === "." || id === ".." || /[/\\\0]/.test(id) ||
    new TextEncoder().encode(id).length > 255
  ) {
    throw new PluginContractError(
      422,
      "invalid_plugin_id",
      "plugin id must be a contained directory basename",
    );
  }
  return id;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginContractError(
      422,
      "invalid_plugin_value",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}
export function uniqueStrings(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim()) ||
    new Set(value).size !== value.length
  ) {
    throw new PluginContractError(
      422,
      "invalid_plugin_value",
      `${label} must contain unique non-empty strings`,
    );
  }
  return value;
}
export function jsonValues(value: unknown): JsonValues {
  const root = record(value, "values");
  const seen = new Set<object>();
  function check(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || seen.has(v)) {
      throw new PluginContractError(
        422,
        "invalid_plugin_value",
        "values must be finite acyclic JSON",
      );
    }
    seen.add(v);
    if (
      !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    ) {
      throw new PluginContractError(
        422,
        "invalid_plugin_value",
        "values must contain plain JSON objects",
      );
    }
    for (const item of Object.values(v)) check(item);
    seen.delete(v);
  }
  check(root);
  const encoded = JSON.stringify(root);
  if (new TextEncoder().encode(encoded).length > PLUGIN_LIMITS.controlBytes) {
    throw new PluginContractError(
      413,
      "plugin_payload_too_large",
      "plugin values exceed 1 MiB",
    );
  }
  return JSON.parse(encoded);
}
