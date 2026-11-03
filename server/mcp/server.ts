// SPDX-License-Identifier: LGPL-3.0-only

/**
 * One MCP server instance per HTTP request (the SDK's stateless model):
 * the globnotes tools registered for the caller's access. Write tools are
 * registered only when the caller holds write authority, so tools/list on a
 * read-only instance shows the read tools only. A call to a write tool on a
 * read-only instance still gets that tool, without authority, so the agent
 * reads the read-only tool error instead of a protocol "not found".
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { toolErrorMessage } from "./errors.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listFolder,
  listTags,
  searchNotes,
  type ToolContext,
  type ToolDefinition,
  updateNote,
} from "./tools.ts";

export const SERVER_NAME = "globnotes-mcp-server";

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
  /** On a read-only instance, the tool a tools/call request names. */
  calledTool?: string;
}

function register(
  server: McpServer,
  tool: ToolDefinition,
  ctx: ToolContext,
): void {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  }, async (args): Promise<CallToolResult> => {
    try {
      const { structured, text } = await tool.run(args, ctx);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: structured as Record<string, unknown>,
      };
    } catch (error) {
      const path = (args as { path?: unknown }).path;
      return {
        content: [{
          type: "text" as const,
          text: toolErrorMessage(
            error,
            typeof path === "string" ? path : undefined,
          ),
        }],
        isError: true,
      };
    }
  });
}

export function createGlobnotesMcpServer(
  access: McpAccess,
  version: string,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });
  const ctx: ToolContext = { vault: access.vault, lease: access.lease };
  for (const tool of READ_TOOLS) register(server, tool, ctx);
  for (const tool of WRITE_TOOLS) {
    if (access.lease !== null || tool.name === access.calledTool) {
      register(server, tool, ctx);
    }
  }
  return server;
}
