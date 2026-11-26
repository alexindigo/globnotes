// SPDX-License-Identifier: LGPL-3.0-only
import type { ViewerAuthority } from "../auth/authority.ts";
import { renderMarkdown } from "./pipeline.ts";

/** The GET and POST render routes accept the same switches and emit HTML. */
export async function renderResponse(
  content: string,
  query: URLSearchParams,
  viewer?: ViewerAuthority,
): Promise<Response> {
  const html = await renderMarkdown(content, {
    viewer,
    disabled: (query.get("disabled") ?? "").split(",").map((id) => id.trim())
      .filter(Boolean),
    lineNumbers: query.get("lineNumbers") === "true",
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
