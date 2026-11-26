// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";

import type { PathfinderRequest } from "@pathfinder/pathfinder";
import type { ViewerAuthority } from "@server/auth/authority.ts";
import type { createInstanceAuth } from "@server/auth/middleware.ts";
import { createHttpPolicy } from "@server/auth/http_policy.ts";
import { renderResponse } from "@server/render/response.ts";

export function createIdentityRender(
  auth: ReturnType<typeof createInstanceAuth>,
) {
  const policy = createHttpPolicy(auth);
  return async (request: PathfinderRequest) => {
    return await policy.read(
      request._raw,
      "readVault",
      ({ viewer }) => renderBuffer(request, viewer),
    );
  };
}

/** POST /_/api/render — render an unsaved markdown buffer through the
 * plugin pipeline (markdown-it + sandboxed worker plugins). The Preview
 * tab's data source: the rendered HTML must reflect the editor's buffer,
 * not the stored note. Body = raw markdown (text/markdown). Query flags
 * match the GET path: `disabled` (comma-separated plugin ids, from the
 * client's localStorage plugin switches) and `lineNumbers=true`. */
export default function (request: PathfinderRequest): Promise<Response> {
  return renderBuffer(request);
}

async function renderBuffer(
  request: PathfinderRequest,
  viewer?: ViewerAuthority,
) {
  return await renderResponse(await request.body.text(), request.query, viewer);
}
