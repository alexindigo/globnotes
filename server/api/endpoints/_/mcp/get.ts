// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/mcp — stateless MCP has no sessions or server-initiated streams:
 * 405 with `Allow: POST` (server/mcp/endpoint.ts). */

import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export const auth = false;

export default function (request: PathfinderRequest): Response {
  if (!state.mcp) throw new HttpError(404, "Not Found");
  return state.mcp.notAllowed(request._raw);
}
