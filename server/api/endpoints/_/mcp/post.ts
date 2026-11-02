// SPDX-License-Identifier: LGPL-3.0-only

/** POST /_/mcp — the MCP endpoint (server/mcp/endpoint.ts, docs/mcp.md).
 * It authenticates like the REST API itself: every MCP call is a POST, so
 * the method-based read-only gate of the auth middleware does not apply. */

import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export const auth = false;

export default function (request: PathfinderRequest): Promise<Response> {
  if (!state.mcp) throw new HttpError(404, "Not Found");
  return state.mcp.post(request._raw);
}
