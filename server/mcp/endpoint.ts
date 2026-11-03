// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The MCP endpoint `<prefix>/_/mcp` (docs/mcp.md): stateless Streamable HTTP
 * through the SDK's web-standard handler. Before the SDK sees a request this
 * module applies the transport's Origin rule and the REST API's
 * authentication, and captures the caller's write authority (the note
 * mutation lease) before any other awaited work, as every REST write
 * endpoint does. The route files under server/api/endpoints/_/mcp/ only
 * forward to it; main.ts creates it (GLOBNOTES_MCP_ENABLED).
 */

import {
  type AuthInfo,
  createMcpHandler,
  type McpRequestContext,
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

function jsonRpcError(status: number, message: string, headers = {}) {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers },
  );
}

/** MCP transport rule: a present Origin whose host differs from the
 * request's Host is refused. Clients without Origin (CLI agents) pass. */
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

/** The tool a tools/call request names (read-only instances only). Modern
 * requests carry it in Mcp-Name, which the SDK has already checked against
 * the body; a 2025-era request is read from its (size-checked) body. */
async function calledTool(ctx: McpRequestContext): Promise<string | undefined> {
  const request = ctx.requestInfo;
  if (!request) return undefined;
  if (ctx.era === "modern") {
    if (request.headers.get("mcp-method") !== "tools/call") return undefined;
    const name = request.headers.get("mcp-name") ?? undefined;
    const encoded = name?.match(/^=\?base64\?(.*)\?=$/);
    return encoded
      ? new TextDecoder().decode(
        Uint8Array.from(atob(encoded[1]), (c) => c.charCodeAt(0)),
      )
      : name;
  }
  try {
    const body = await request.clone().json();
    return body?.method === "tools/call" &&
        typeof body.params?.name === "string"
      ? body.params.name
      : undefined;
  } catch {
    return undefined;
  }
}

export function createMcpEndpoint(
  overrides: Partial<McpEndpointAdapters> = {},
): McpEndpoint {
  const adapters = { ...stateEndpointAdapters, ...overrides };
  // One handler; the factory builds a fresh server per request from the
  // access this endpoint established, passed as the SDK's per-caller
  // authInfo.
  const handler = createMcpHandler(async (ctx) => {
    const access = ctx.authInfo?.extra?.[ACCESS_KEY] as McpAccess;
    return createGlobnotesMcpServer(
      access.lease ? access : { ...access, calledTool: await calledTool(ctx) },
      adapters.version(),
    );
  }, {
    onerror: (error) => logger.debug(`MCP request rejected: ${error.message}`),
  });
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
      return await handler.fetch(request, { authInfo });
    },
    notAllowed(request) {
      if (foreignOrigin(request)) {
        return jsonRpcError(403, "Forbidden: Origin does not match Host");
      }
      return jsonRpcError(405, "Method not allowed.", { Allow: "POST" });
    },
    close: () => handler.close(),
  };
}
