// SPDX-License-Identifier: LGPL-3.0-only

/** Sandboxed plugin endpoint routing. Plugin endpoint code was discovered
 * and imported INSIDE the owning service worker (never Pathfinder's
 * walkRoot on plugin code in the host); this module compiles the reported
 * method/path descriptors with Pathfinder's public matcher and proxies
 * bounded structured-clone envelopes to the registered handlers. */

import {
  type CompiledEndpointTable,
  compileEndpointTable,
  endpointMethods,
} from "./endpoint_table.ts";
import {
  HTTP_METHODS,
  PLUGIN_LIMITS,
  type PluginHttpRequest,
  type PluginHttpResponse,
} from "./contracts.ts";
import type { PluginRuntime } from "./runtime.ts";

export type EndpointOutcome =
  | { kind: "response"; response: PluginHttpResponse }
  | { kind: "not-found" }
  | { kind: "method-miss"; allowed: string[] }
  | { kind: "unavailable" };

interface Compiled extends CompiledEndpointTable {
  generation: string;
  version: number;
}
export type EndpointAdmission =
  | {
    kind: "admitted";
    pluginId: string;
    runtime: PluginRuntime;
    generation: string;
    handlerId: string;
    method: PluginHttpRequest["method"];
    path: string;
    params: PluginHttpRequest["params"];
  }
  | Exclude<EndpointOutcome, { kind: "response" }>;

/** Headers that never cross the sandbox boundary, in either direction. */
const BLOCKED_REQUEST_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

export function sanitizeRequestHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of headers) {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
      out.push([name, value]);
    }
  }
  return out;
}

export function sanitizeResponseHeaders(
  headers: [string, string][],
): [string, string][] {
  return headers.filter(([name]) =>
    !BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())
  );
}

/** Normalize whatever the endpoint handler returned into the bounded
 * response envelope. Plain values become JSON results. */
function endpointCandidate(value: unknown): PluginHttpResponse {
  if (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    // A response envelope must declare a body or status; a lone "headers"
    // key is ordinary payload data, not an envelope.
    ("body" in value || "status" in value)
  ) {
    const shaped = value as {
      status?: unknown;
      headers?: unknown;
      body?: unknown;
    };
    const status = typeof shaped.status === "number" &&
        shaped.status >= 100 && shaped.status <= 599
      ? shaped.status
      : 200;
    const headers: [string, string][] = Array.isArray(shaped.headers)
      ? (shaped.headers as [string, string][]).filter(
        (h) => Array.isArray(h) && h.length === 2,
      )
      : [];
    let body: Uint8Array;
    if (shaped.body === undefined || shaped.body === null) {
      body = new Uint8Array(0);
    } else if (shaped.body instanceof Uint8Array) {
      body = shaped.body;
    } else if (typeof shaped.body === "string") {
      body = new TextEncoder().encode(shaped.body);
      if (!headers.some(([k]) => k.toLowerCase() === "content-type")) {
        headers.push(["content-type", "text/plain; charset=utf-8"]);
      }
    } else {
      body = new TextEncoder().encode(JSON.stringify(shaped.body));
      if (!headers.some(([k]) => k.toLowerCase() === "content-type")) {
        headers.push(["content-type", "application/json"]);
      }
    }
    return { status, headers: sanitizeResponseHeaders(headers), body };
  }
  const body = new TextEncoder().encode(JSON.stringify(value ?? null));
  return {
    status: 200,
    headers: [["content-type", "application/json"]],
    body,
  };
}
export function normalizeEndpointResult(value: unknown): PluginHttpResponse {
  const candidate = endpointCandidate(value);
  if (candidate.body.byteLength > PLUGIN_LIMITS.httpBytes) {
    throw new Error("plugin endpoint response exceeds the 16 MiB bound");
  }
  return candidate;
}

export class PluginEndpoints {
  readonly #compiled = new Map<string, Compiled>();

  constructor(private readonly runtime: () => PluginRuntime | null) {}

  #routes(id: string): Compiled | null {
    const runtime = this.runtime();
    const status = runtime?.status(id);
    if (
      !runtime || !status || status.status !== "ready" || !status.generation
    ) {
      this.#compiled.delete(id);
      return null;
    }
    const version = runtime.version;
    const cached = this.#compiled.get(id);
    if (
      cached && cached.generation === status.generation &&
      cached.version === version
    ) {
      return cached;
    }
    const descriptors = runtime.endpointDescriptors(id);
    if (!descriptors.length) {
      this.#compiled.delete(id);
      return null;
    }
    const table = compileEndpointTable(descriptors);
    const compiled: Compiled = {
      generation: status.generation,
      version,
      ...table,
    };
    this.#compiled.set(id, compiled);
    return compiled;
  }

  /** Methods a plugin declares for a local path (for 405/OPTIONS/HEAD). */
  allowedMethods(id: string, localPath: string): string[] | null {
    const compiled = this.#routes(id);
    if (!compiled) return null;
    return endpointMethods(compiled, localPath);
  }

  /** Captures a ready current owner without body acquisition or dispatch. */
  admit(
    id: string,
    method: PluginHttpRequest["method"],
    encodedPath: string,
  ): EndpointAdmission {
    const runtime = this.runtime();
    if (!runtime?.isEnabled(id)) return { kind: "unavailable" };
    const compiled = this.#routes(id);
    if (!compiled) return { kind: "not-found" };
    const path = encodedPath || "/";
    const result = compiled.matcher.lookup(method, path);
    if (result.kind === "no-match") return { kind: "not-found" };
    if (result.kind === "method-miss") {
      return {
        kind: "method-miss",
        allowed: endpointMethods(compiled, path) ?? result.allowed,
      };
    }
    const handlerId = compiled.handlers.get(result.data as string);
    if (!handlerId) return { kind: "not-found" };
    return {
      kind: "admitted",
      pluginId: id,
      runtime,
      generation: compiled.generation,
      handlerId,
      method,
      path,
      params: result.params,
    };
  }
  async invoke(
    admission: Extract<EndpointAdmission, { kind: "admitted" }>,
    request: PluginHttpRequest,
  ): Promise<EndpointOutcome> {
    const runtime = this.runtime();
    if (
      runtime !== admission.runtime || !runtime.isEnabled(admission.pluginId) ||
      runtime.status(admission.pluginId)?.generation !== admission.generation
    ) return { kind: "unavailable" };
    try {
      const value = await runtime.invokeHandler(
        admission.pluginId,
        admission.handlerId,
        [{
          ...request,
          method: admission.method,
          path: admission.path,
          params: admission.params,
        }],
      );
      return { kind: "response", response: normalizeEndpointResult(value) };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async dispatch(
    id: string,
    request: PluginHttpRequest,
  ): Promise<EndpointOutcome> {
    const admission = this.admit(id, request.method, request.path);
    return admission.kind === "admitted"
      ? await this.invoke(admission, request)
      : admission;
  }
}

export const ENDPOINT_METHODS = HTTP_METHODS;
