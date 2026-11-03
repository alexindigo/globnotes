// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP endpoint `<prefix>/_/mcp` (docs/mcp.md): stateless Streamable HTTP
 * with JSON responses (design §2 row 3: no sessions, no SSE). 2026-07-28
 * requests go to the SDK's web-standard handler; 2025-era requests to the
 * SDK's stateless streamable HTTP transport in JSON-response mode (the
 * SDK's own legacy leg would answer with an SSE stream). There are no
 * change notifications, so `subscriptions/listen` (a long-lived SSE stream)
 * is not served. Before the SDK sees a request this module applies the
 * transport's Origin rule and the REST API's authentication, and captures
 * the caller's write authority (the note mutation lease) before any other
 * awaited work, as every REST write endpoint does. The route files under
 * server/api/endpoints/_/mcp/ only forward to it; main.ts creates it
 * (GLOBNOTES_MCP_ENABLED).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AuthInfo,
  createMcpHandler,
  isLegacyRequest,
  type McpRequestContext,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { enforceReadAuth, noteMutationLease } from "../auth/middleware.ts";
import { logger } from "../logger.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { state } from "../state.ts";
import { formatVersion } from "../../shared/version.ts";
import { createGlobnotesMcpServer, type McpAccess } from "./server.ts";
import { type McpVault, stateVault } from "./vault.ts";

export interface McpEndpointAdapters {
  vault: McpVault;
  /** Whether this deployment accepts note writes at all (not read_only). */
  writable(): boolean;
  /** Authenticate a read; throws HttpError (503 setup, 401 token). */
  authenticateRead(request: Request): Promise<void>;
  /** Authenticate and capture write authority; throws HttpError. */
  lease(request: Request): Promise<NoteMutationLease>;
  version(): string;
}

/** The running server's adapters (the default). */
export const stateEndpointAdapters: McpEndpointAdapters = {
  vault: stateVault,
  writable: () => state.lifecycle?.writable() ?? false,
  authenticateRead: enforceReadAuth,
  lease: noteMutationLease,
  version: () => (state.version && formatVersion(state.version)) || "dev",
};

export interface McpEndpoint {
  /** POST: one JSON-RPC message. */
  post(request: Request): Promise<Response>;
  /** GET/DELETE: no sessions or server-initiated streams (405). */
  notAllowed(request: Request): Response;
  close(): Promise<void>;
}

const ACCESS_KEY = "globnotes";

/** Errors the SDK and transports report while one request is served. */
const reported = new AsyncLocalStorage<Error[]>();

/** The SDK's `onerror` receives client rejections (a bad header, an
 * unsupported version, malformed JSON) and server faults alike. What the
 * request was answered with tells them apart: a 5xx answer is a server
 * fault and goes to the error log with its details; anything else was the
 * client's request and stays at debug. An error outside any request (none
 * is expected) is logged as an error. */
function reportError(error: Error): void {
  const errors = reported.getStore();
  if (errors) errors.push(error);
  else logger.error("MCP server error:", error);
}

async function served(run: () => Promise<Response>): Promise<Response> {
  const errors: Error[] = [];
  const response = await reported.run(errors, run);
  if (response.status >= 500) {
    if (!errors.length) {
      logger.error(`MCP request failed: HTTP ${response.status}`);
    }
    for (const error of errors) {
      logger.error(`MCP request failed (HTTP ${response.status}):`, error);
    }
  } else {
    for (const error of errors) {
      logger.debug(
        `MCP request rejected (HTTP ${response.status}): ${error.message}`,
      );
    }
  }
  return response;
}

/** A failure to release a finished exchange: not the client's doing, and
 * the answer is already decided. */
function cleanupFailed(error: unknown): void {
  logger.warning("MCP request cleanup failed:", error);
}

function jsonRpcError(
  status: number,
  message: string,
  headers = {},
  code = -32000,
) {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers },
  );
}

/** The only method that opens a long-lived stream. The SDK rejects a
 * 2026-07-28 request whose Mcp-Method header and body disagree, so the
 * header names the method that would run. */
function opensStream(request: Request): boolean {
  return request.headers.get("mcp-method") === "subscriptions/listen";
}

/** MCP transport rule: a present Origin whose host differs from the
 * request's Host is refused. Clients without Origin (CLI agents) pass. This
 * stops ordinary cross-site browser requests only: under DNS rebinding the
 * attacker's Origin and Host match, so it is not rebinding protection (the
 * REST API has the same limit; docs/mcp.md, Security). */
export function foreignOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return false;
  const host = (request.headers.get("host") ?? new URL(request.url).host)
    .toLowerCase();
  try {
    return new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true; // "null" and other opaque origins
  }
}

/** The tools a tools/call request names (read-only instances only).
 * Modern requests carry the name in Mcp-Name, which the SDK has already
 * checked against the body; a 2025-era request (or batch) is read from its
 * body, which isLegacyRequest has size-checked. */
async function calledTools(ctx: McpRequestContext): Promise<string[]> {
  const request = ctx.requestInfo;
  if (!request) return [];
  if (ctx.era === "modern") {
    if (request.headers.get("mcp-method") !== "tools/call") return [];
    const name = request.headers.get("mcp-name");
    if (name === null) return [];
    const encoded = name.match(/^=\?base64\?(.*)\?=$/);
    return [
      encoded
        ? new TextDecoder().decode(
          Uint8Array.from(atob(encoded[1]), (c) => c.charCodeAt(0)),
        )
        : name,
    ];
  }
  try {
    const body = await request.clone().json();
    return (Array.isArray(body) ? body : [body]).flatMap((message) =>
      message?.method === "tools/call" &&
        typeof message.params?.name === "string"
        ? [message.params.name]
        : []
    );
  } catch {
    return [];
  }
}

export function createMcpEndpoint(
  overrides: Partial<McpEndpointAdapters> = {},
): McpEndpoint {
  const adapters = { ...stateEndpointAdapters, ...overrides };
  // The factory builds a fresh server per request from the access this
  // endpoint established, passed as the SDK's per-caller authInfo.
  const factory = async (ctx: McpRequestContext) => {
    const access = ctx.authInfo?.extra?.[ACCESS_KEY] as McpAccess;
    return createGlobnotesMcpServer(
      access.lease
        ? access
        : { ...access, calledTools: await calledTools(ctx) },
      adapters.version(),
    );
  };
  const modern = createMcpHandler(factory, {
    legacy: "reject",
    onerror: reportError,
  });
  /** One 2025-era exchange: a fresh server on a stateless transport that
   * answers with one JSON body. */
  const legacy = async (request: Request, authInfo: AuthInfo) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // Set before connect, which chains the server's own handler after it.
    transport.onerror = reportError;
    let server: Awaited<ReturnType<typeof factory>> | undefined;
    try {
      server = await factory({ era: "legacy", authInfo, requestInfo: request });
      await server.connect(transport);
      return await transport.handleRequest(request, { authInfo });
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)));
      return jsonRpcError(500, "Internal error", {}, -32603);
    } finally {
      await transport.close().catch(cleanupFailed);
      await server?.close().catch(cleanupFailed);
    }
  };
  return {
    async post(request) {
      if (foreignOrigin(request)) {
        return jsonRpcError(403, "Forbidden: Origin does not match Host");
      }
      let lease: NoteMutationLease | null = null;
      if (adapters.writable()) lease = await adapters.lease(request);
      else await adapters.authenticateRead(request);
      const access: McpAccess = { vault: adapters.vault, lease };
      const authInfo: AuthInfo = {
        token: "",
        clientId: "globnotes",
        scopes: lease ? ["notes:read", "notes:write"] : ["notes:read"],
        extra: { [ACCESS_KEY]: access },
      };
      if (opensStream(request)) {
        // MCP: a method the server doesn't implement is 404 with -32601.
        return jsonRpcError(
          404,
          "Method not found: this server sends no change notifications",
          {},
          -32601,
        );
      }
      return await served(async () =>
        await isLegacyRequest(request)
          ? await legacy(request, authInfo)
          : await modern.fetch(request, { authInfo })
      );
    },
    notAllowed(request) {
      if (foreignOrigin(request)) {
        return jsonRpcError(403, "Forbidden: Origin does not match Host");
      }
      return jsonRpcError(405, "Method not allowed.", { Allow: "POST" });
    },
    close: () => modern.close(),
  };
}
