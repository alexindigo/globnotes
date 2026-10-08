// SPDX-License-Identifier: LGPL-3.0-only

/** Serializable server-Worker consent contract; plugin declarations are requests. */
import { PluginContractError, record } from "./contracts.ts";

export const NETWORK_LIMITS = Object.freeze({
  scopes: 128,
  reasonBytes: 512,
  requests: 256,
  receiptMs: 10_000,
});
export type Kind = "network" | "imports";
export type Scope = { type: "host"; authority: string } | { type: "all" };
export interface Source {
  key: string;
  revision: number;
  codeFingerprint: string;
  settingsRevision: number;
}
export type RequestState =
  | "pending"
  | "approved"
  | "denied"
  | "revoked"
  | "obsolete";
export interface PermissionRequest {
  id: string;
  pluginId: string;
  source: Source;
  kind: Kind;
  scopes: Scope[];
  reason?: string;
  state: RequestState;
}
export type BlockedReason =
  | "unapproved"
  | "master-off"
  | "not-requested"
  | "parent-unavailable";
export interface PermissionRow {
  kind: Kind;
  scope: Scope;
  requested: boolean;
  approved: boolean;
  effective: boolean;
  approvalCoverage: Scope[];
  sources: ("static" | "legacy" | "service" | "render" | "access-request")[];
  blockedReasons: BlockedReason[];
}
export interface PermissionView {
  pluginId: string;
  revision: number;
  signature: string;
  requestSourceKey: string;
  requestSourceRevision: number;
  source: Source;
  allowNetwork: boolean;
  approvedNetwork: Scope[];
  approvedImports: Scope[];
  requestedNetwork: Scope[];
  requestedImports: Scope[];
  effectiveNetwork: Scope[];
  effectiveImports: Scope[];
  rows: PermissionRow[];
  pendingRequests: PermissionRequest[];
  reload: {
    id?: string;
    state: "none" | "scheduled" | "reloading" | "ready" | "failed";
    fingerprint: string;
    detail?: string;
  };
  runsInBrowser: boolean;
  browserComponents: ("editor" | "runtime")[];
}
export interface PermissionControls {
  revision: number;
  signature: string;
  requestSourceKey: string;
  requestSourceRevision: number;
  allowNetwork: boolean;
  approvedNetwork: Scope[];
  approvedImports: Scope[];
}
export interface PermissionDeclaration {
  network: Scope[];
  imports: Scope[];
}
export interface AccessAdmission {
  requestId: string;
  revision: number;
  status: RequestState;
  blockedReasons: BlockedReason[];
}
export interface PermissionPublicationOptions {
  source: Source;
}

function invalid(detail: string): never {
  throw new PluginContractError(422, "invalid_permission_scope", detail);
}
/** No URL schemes, credentials, paths, wildcard strings or implicit default port. */
export function canonicalAuthority(value: unknown): string {
  if (typeof value !== "string" || !value || /[\s/@\\?#%*\0]/u.test(value)) {
    invalid("permission hosts must be exact host[:port] authorities");
  }
  let host: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = /^(\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/.exec(value);
    if (!match) {
      invalid("IPv6 authorities must use brackets and a valid optional port");
    }
    host = match[1];
    port = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/.exec(value);
    if (!match) invalid("invalid authority or port");
    host = match[1];
    port = match[2];
  }
  if (
    port !== undefined &&
    (!Number.isInteger(Number(port)) || Number(port) < 1 ||
      Number(port) > 65535)
  ) {
    invalid("permission ports must be between 1 and 65535");
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}/`);
  } catch {
    invalid("invalid permission host");
  }
  const canonical = parsed.hostname.toLowerCase();
  if (
    !canonical.startsWith("[") && (
      canonical.length > 253 ||
      canonical.replace(/\.$/, "").split(".").some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
      )
    )
  ) invalid("invalid DNS or IDNA permission host");
  return port === undefined ? canonical : `${canonical}:${Number(port)}`;
}
export function scopeKey(scope: Scope): string {
  return scope.type === "all" ? "all" : `host:${scope.authority}`;
}
export function canonicalScopes(value: unknown): Scope[] {
  if (value === false) return [];
  if (value === true) return [{ type: "all" }];
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries) || entries.length > NETWORK_LIMITS.scopes) {
    invalid("permission scopes must be a bounded list");
  }
  const scopes = entries.map((entry): Scope => {
    if (typeof entry === "string") {
      return { type: "host", authority: canonicalAuthority(entry) };
    }
    const raw = record(entry, "permission scope");
    if (raw.type === "all" && Object.keys(raw).length === 1) {
      return { type: "all" };
    }
    if (
      raw.type === "host" && Object.keys(raw).length === 2 &&
      Object.hasOwn(raw, "authority")
    ) {
      return { type: "host", authority: canonicalAuthority(raw.authority) };
    }
    invalid("unsupported permission scope");
  });
  return [...new Map(scopes.map((scope) => [scopeKey(scope), scope])).values()]
    .sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
}
export function unionScopes(...sets: Scope[][]): Scope[] {
  return canonicalScopes([
    ...new Map(sets.flat().map((scope) => [scopeKey(scope), scope])).values(),
  ]);
}
function authorityParts(authority: string): { host: string; port?: string } {
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(authority)!;
  return { host: match[1], port: match[2] };
}
export function scopeCovers(cover: Scope, candidate: Scope): boolean {
  if (cover.type === "all") return true;
  if (candidate.type === "all") return false;
  const outer = authorityParts(cover.authority),
    inner = authorityParts(candidate.authority);
  return outer.host === inner.host &&
    (outer.port === undefined || outer.port === inner.port);
}
export function scopesCover(covers: Scope[], candidate: Scope): boolean {
  return covers.some((cover) => scopeCovers(cover, candidate));
}
export function intersectScopes(left: Scope[], right: Scope[]): Scope[] {
  const result: Scope[] = [];
  for (const a of left) {
    for (const b of right) {
      if (scopeCovers(a, b)) result.push(b);
      else if (scopeCovers(b, a)) result.push(a);
    }
  }
  return unionScopes(result);
}
export function equalSource(left: Source, right: Source): boolean {
  return left.key === right.key && left.revision === right.revision &&
    left.codeFingerprint === right.codeFingerprint &&
    left.settingsRevision === right.settingsRevision;
}
export function permissionRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginContractError(
      422,
      "invalid_permission_revision",
      "permission revision must be a non-negative safe integer",
    );
  }
  return value as number;
}
export function permissionSource(value: unknown): Source {
  const raw = record(value, "permission source");
  if (
    typeof raw.key !== "string" || !/^[a-f0-9]{64}$/.test(raw.key) ||
    typeof raw.codeFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.codeFingerprint) ||
    Object.keys(raw).some((key) =>
      !["key", "revision", "codeFingerprint", "settingsRevision"].includes(key)
    )
  ) {
    throw new PluginContractError(
      422,
      "invalid_permission_source",
      "invalid permission source token",
    );
  }
  return {
    key: raw.key,
    revision: permissionRevision(raw.revision),
    codeFingerprint: raw.codeFingerprint,
    settingsRevision: permissionRevision(raw.settingsRevision),
  };
}
export function permissionKind(value: unknown): Kind {
  if (value !== "network" && value !== "imports") {
    invalid("permission kind must be network or imports");
  }
  return value;
}
export function permissionReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > NETWORK_LIMITS.reasonBytes ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[<>]|-----BEGIN|(?:ghp_|github_pat_|sk-proj-)|\bBearer\s|eyJ[A-Za-z0-9_-]+\./
      .test(value)
  ) {
    throw new PluginContractError(
      422,
      "invalid_permission_reason",
      "permission reason must be bounded plain text without credentials or HTML",
    );
  }
  return value;
}
