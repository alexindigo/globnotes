// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";

import { renderMarkdown } from "@server/render/pipeline.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import type { createInstanceAuth } from "@server/auth/middleware.ts";
import { createHttpPolicy } from "@server/auth/http_policy.ts";

export function createIdentityRender(
  auth: ReturnType<typeof createInstanceAuth>,
) {
  const policy = createHttpPolicy(auth);
  return async (request: PathfinderRequest) => {
    return await policy.read(request._raw, "readVault", async () => {
      const viewer = await auth.viewer(request._raw);
      const content = await request.body.text();
      const html = await renderMarkdown(content, {
        viewer,
        disabled: (request.query.get("disabled") ?? "").split(",").filter(
          Boolean,
        ),
        lineNumbers: request.query.get("lineNumbers") === "true",
      });
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  };
}

/** POST /_/api/render — render an unsaved markdown buffer through the
 * plugin pipeline (markdown-it + sandboxed worker plugins). The Preview
 * tab's data source: the rendered HTML must reflect the editor's buffer,
 * not the stored note. Body = raw markdown (text/markdown). Query flags
 * match the GET path: `disabled` (comma-separated plugin ids, from the
 * client's localStorage plugin switches) and `lineNumbers=true`. */
export default async function (request: PathfinderRequest): Promise<Response> {
  const content = await request.body.text();
  const disabled = (request.query.get("disabled") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const html = await renderMarkdown(content, {
    disabled,
    lineNumbers: request.query.get("lineNumbers") === "true",
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
