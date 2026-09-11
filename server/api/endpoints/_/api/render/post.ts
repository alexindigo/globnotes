// SPDX-License-Identifier: LGPL-3.0-only

import { renderMarkdown } from "@server/render/pipeline.ts";

/** POST /_/api/render — render an unsaved markdown buffer through the
 * plugin pipeline (markdown-it + sandboxed worker plugins). The Preview
 * tab's data source: the rendered HTML must reflect the editor's buffer,
 * not the stored note. Body = raw markdown (text/markdown). Query flags
 * match the GET path: `disabled` (comma-separated plugin ids, from the
 * client's localStorage plugin switches) and `lineNumbers=true`. */
export default async function (request): Promise<Response> {
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
