// SPDX-License-Identifier: LGPL-3.0-only

/**
 * One MCP server instance per HTTP request (the SDK's stateless model):
 * the globnotes tools registered for the caller's access. Write tools are
 * registered only when the caller holds write authority, so tools/list on a
 * read-only instance shows the read tools only. A call to a write tool on a
 * read-only instance (or a 2025-era batch of calls) still gets that tool,
 * without authority, so the agent reads the read-only tool error instead of
 * a protocol "not found".
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { logger } from "../logger.ts";
import { describeToolError } from "./errors.ts";
import { COMMITTED_REPLY } from "./disclosure.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listFolder,
  listTags,
  resultText,
  searchNotes,
  type ToolContext,
  type ToolDefinition,
  updateNote,
} from "./tools.ts";

export const SERVER_NAME = "globnotes-mcp-server";

/** How the tools fit together, sent at initialize (and server/discover)
 * for clients that pass server instructions to their model. The details
 * live in each tool's description; this stays short (under 1,000
 * characters). */
export const INSTRUCTIONS =
  "globnotes is a vault of Markdown notes in folders. Find notes with " +
  'globnotes_search_notes (words, "exact phrase", #tag, prefix*, or * for ' +
  "all) or browse with globnotes_list_folder, then read one with " +
  "globnotes_get_note. Listings and large notes come in parts: while " +
  "has_more is true, call again with offset=next_offset. To change a note, " +
  "read all of it first, then call globnotes_update_note with the whole new " +
  "content, expected_last_modified and expected_hash set to the " +
  "last_modified and hash you read, so edits made since are not " +
  "overwritten; update (also a rename) and delete refuse without them. " +
  "Changing a note's first '# Heading' " +
  "renames it (unless its front matter sets a title); use the path in the " +
  "result from then on. A read-only instance offers only the read tools.";

export const READ_TOOLS: ToolDefinition[] = [
  searchNotes,
  getNote,
  listFolder,
  listTags,
];
export const WRITE_TOOLS: ToolDefinition[] = [
  createNote,
  updateNote,
  deleteNote,
];

export interface McpAccess extends ToolContext {
  /** On a read-only instance, the tools a tools/call request names. */
  calledTools?: string[];
  identityReplies?: boolean;
}

function register(
  server: McpServer,
  tool: ToolDefinition,
  ctx: McpAccess,
): void {
  const outputSchema =
    ctx.identityReplies && (tool === createNote || tool === updateNote)
      ? tool.outputSchema.partial().extend({
        committed: z.literal(true).optional(),
      })
      : tool.outputSchema;
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema,
    annotations: tool.annotations,
  }, async (args): Promise<CallToolResult> => {
    try {
      ctx.readLease?.assertCurrent();
      const operation = await ctx.operationLease?.(
        tool.write ? "editNotes" : "readVault",
      );
      ctx.readLease?.assertCurrent();
      const output = await tool.run(
        args,
        operation && tool.write ? { ...ctx, lease: operation } : ctx,
      );
      const result = {
        content: [{ type: "text" as const, text: resultText(output) }],
        structuredContent: output.structured as Record<string, unknown>,
        ...(ctx.identityReplies && output.receipt
          ? { _meta: { [COMMITTED_REPLY]: output.receipt } }
          : {}),
      };
      // A successful write can carry both a receipt and a private projection.
      // The transport chooses between them at emission, per reply.
      if (!output.receipt) {
        operation?.assertCurrent();
        ctx.readLease?.assertCurrent();
      }
      return result;
    } catch (error) {
      const path = (args as { path?: unknown }).path;
      const failure = describeToolError(
        error,
        typeof path === "string" ? path : undefined,
      );
      if (failure.internal) {
        logger.error(`MCP tool ${tool.name} failed:`, error);
      }
      return {
        content: [{ type: "text" as const, text: failure.message }],
        isError: true,
      };
    }
  });
}

export function createGlobnotesMcpServer(
  access: McpAccess,
  version: string,
): McpServer {
  // The tool list never changes while a server runs, and the endpoint has
  // no change-notification streams (endpoint.ts), so list changes are not
  // advertised.
  const server = new McpServer({ name: SERVER_NAME, version }, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
  });
  const ctx: McpAccess = {
    vault: access.vault,
    lease: access.lease,
    readLease: access.readLease,
    operationLease: access.operationLease,
    identityReplies: access.identityReplies,
  };
  for (const tool of READ_TOOLS) register(server, tool, ctx);
  for (const tool of WRITE_TOOLS) {
    if (access.lease !== null || access.calledTools?.includes(tool.name)) {
      register(server, tool, ctx);
    }
  }
  return server;
}
