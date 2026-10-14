// SPDX-License-Identifier: LGPL-3.0-only

/** Shared proxy for the plugin-local endpoint namespace. Host controls live
 * under /_/api/plugin-host so plugin routes can never shadow them. */

import { BodyLimitError, HttpError } from "@pathfinder/pathfinder";
import {
  PLUGIN_LIMITS,
  type PluginHttpRequest,
  pluginId,
} from "./contracts.ts";
import { sanitizeRequestHeaders } from "./endpoints.ts";
import { advertisedEndpointMethods } from "./endpoint_table.ts";
import { state } from "../state.ts";

const textEncoder = new TextEncoder();
export const PLUGIN_BODY_ACQUISITION_MS = 30_000;
export interface PluginProxyRequest {
  method: string;
  params: Record<string, unknown>;
  query: URLSearchParams;
  headers: Headers;
  _raw: Request;
  body: { stream: ReadableStream<Uint8Array> | null };
}
/** Main has already removed deployment prefix; local captures stay encoded. */
export function encodedPluginPath(
  request: { params: Record<string, unknown>; _raw: Request },
): { id: string; path: string } {
  const pathname = new URL(request._raw.url).pathname;
  const namespace = "/_/api/plugins/";
  if (!pathname.startsWith(namespace)) throw new HttpError(404, "Not Found");
  const slash = pathname.indexOf("/", namespace.length);
  const encodedId = pathname.slice(
    namespace.length,
    slash < 0 ? undefined : slash,
  );
  let id: string;
  try {
    id = pluginId(decodeURIComponent(encodedId));
  } catch {
    throw new HttpError(404, "Not Found");
  }
  if (id !== String(request.params.id)) throw new HttpError(404, "Not Found");
  return { id, path: slash < 0 ? "/" : pathname.slice(slash) };
}
function localLookup<T>(lookup: () => T): T {
  try {
    return lookup();
  } catch (error) {
    if (error instanceof URIError) {
      throw new HttpError(400, "Malformed encoded plugin path");
    }
    throw error;
  }
}

/** Proxy one HTTP request to the owning service worker. `localPath` is the
 * plugin-local path ("" for the plugin root). */
export async function proxyPluginEndpoint(
  request: PluginProxyRequest,
  _localPath?: string,
): Promise<Response> {
  const { id, path } = encodedPluginPath(request);
  const endpoints = state.pluginEndpoints;
  if (!endpoints) throw new HttpError(404, "Not Found");
  const admission = localLookup(() =>
    endpoints.admit(id, request.method as PluginHttpRequest["method"], path)
  );
  if (admission.kind === "not-found" || admission.kind === "unavailable") {
    throw new HttpError(404, "Not Found");
  }
  if (admission.kind === "method-miss") {
    return Response.json({ detail: "Method Not Allowed" }, {
      status: 405,
      headers: {
        allow: advertisedEndpointMethods(admission.allowed).join(", "),
      },
    });
  }
  const body = await readBodyBytes(request);
  const envelope: PluginHttpRequest = {
    method: request.method as PluginHttpRequest["method"],
    path,
    params: {},
    query: [...request.query.entries()],
    headers: sanitizeRequestHeaders(request.headers),
    body,
  };
  const outcome = await endpoints.invoke(admission, envelope);
  if (outcome.kind === "unavailable" || outcome.kind === "not-found") {
    // Disabled/unavailable plugins and plain route misses are both 404 —
    // installed files never leak availability.
    throw new HttpError(404, "Not Found");
  }
  if (outcome.kind === "method-miss") {
    const allowed = advertisedEndpointMethods(outcome.allowed).join(", ");
    return Response.json(
      { detail: "Method Not Allowed" },
      { status: 405, headers: { allow: allowed } },
    );
  }
  const { response } = outcome;
  return new Response(
    response.body.length ? response.body as unknown as BodyInit : null,
    { status: response.status, headers: response.headers },
  );
}

/** Host-owned HEAD: never invokes plugin code — answers from the declared
 * method table (GET present ⇒ 200 with no body; otherwise 404). */
export function headPluginEndpoint(
  request: { params: Record<string, unknown>; _raw: Request },
  _localPath?: string,
): Response {
  const { id, path } = encodedPluginPath(request);
  const endpoints = state.pluginEndpoints;
  const runtime = state.plugins?.runtime;
  if (!endpoints || !runtime?.isEnabled(id)) {
    throw new HttpError(404, "Not Found");
  }
  const allowed = localLookup(() => endpoints.allowedMethods(id, path));
  if (!allowed?.includes("GET")) throw new HttpError(404, "Not Found");
  return new Response(null, { status: 200 });
}

/** Host-owned OPTIONS: the declared method table plus HEAD/OPTIONS. */
export function optionsPluginEndpoint(
  request: { params: Record<string, unknown>; _raw: Request },
  _localPath?: string,
): Response {
  const { id, path } = encodedPluginPath(request);
  const endpoints = state.pluginEndpoints;
  const runtime = state.plugins?.runtime;
  if (!endpoints || !runtime?.isEnabled(id)) {
    throw new HttpError(404, "Not Found");
  }
  const allowed = localLookup(() => endpoints.allowedMethods(id, path));
  if (!allowed) throw new HttpError(404, "Not Found");
  return new Response(null, {
    status: 204,
    headers: { allow: advertisedEndpointMethods(allowed).join(", ") },
  });
}

export async function readBodyBytes(request: {
  body: { stream: ReadableStream<Uint8Array> | null };
  _raw?: Request;
}): Promise<Uint8Array> {
  const signal = request._raw?.signal;
  if (signal?.aborted) {
    throw new HttpError(400, "Plugin request body acquisition aborted");
  }
  const stream = request.body.stream;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const deadline = Date.now() + PLUGIN_BODY_ACQUISITION_MS;
  let rejection!: (error: HttpError) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejection = reject;
  });
  interrupted.catch(() => undefined);
  let failure: HttpError | undefined;
  const stop = (error: HttpError) => {
    if (failure) return;
    failure = error;
    rejection(error);
    // Cancellation is best-effort; hostile sources may never settle cancel().
    try {
      reader.cancel(error).catch(() => undefined);
    } catch { /* already released */ }
  };
  const abort = () =>
    stop(new HttpError(400, "Plugin request body acquisition aborted"));
  const timer = setTimeout(
    () =>
      stop(
        new HttpError(408, "Plugin request body acquisition deadline exceeded"),
      ),
    PLUGIN_BODY_ACQUISITION_MS,
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let bytes = new Uint8Array(0), count = 0;
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        stop(
          new HttpError(
            408,
            "Plugin request body acquisition deadline exceeded",
          ),
        );
      }
      if (failure) throw failure;
      const result = await Promise.race([reader.read(), interrupted]);
      if (failure) throw failure;
      if (Date.now() >= deadline) {
        stop(
          new HttpError(
            408,
            "Plugin request body acquisition deadline exceeded",
          ),
        );
        throw failure!;
      }
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new HttpError(400, "Invalid plugin request body chunk");
      }
      const next = count + chunk.byteLength;
      if (next > PLUGIN_LIMITS.httpBytes) {
        stop(
          new HttpError(
            413,
            "plugin endpoint request exceeds the 16 MiB bound",
          ),
        );
        throw failure!;
      }
      if (next > bytes.byteLength) {
        const capacity = Math.min(
          PLUGIN_LIMITS.httpBytes,
          Math.max(next, bytes.byteLength ? bytes.byteLength * 2 : 64 * 1024),
        );
        const owned = new Uint8Array(capacity);
        owned.set(bytes.subarray(0, count));
        bytes = owned;
      }
      bytes.set(chunk, count);
      count = next;
    }
    return bytes.subarray(0, count);
  } catch (error) {
    if (error instanceof HttpError) {
      stop(error);
      throw error;
    }
    if (error instanceof BodyLimitError) {
      try {
        reader.cancel(error).catch(() => undefined);
      } catch { /* errored stream */ }
      throw error;
    }
    const failed = new HttpError(400, "Plugin request body stream failed");
    stop(failed);
    throw failed;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}
