// SPDX-License-Identifier: LGPL-3.0-only

import { note_not_found } from "@server/api_messages.ts";
import { InvalidTitleError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError } from "@server/http_error.ts";
import { renderMarkdown } from "@server/render/pipeline.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

/** Render a note's markdown through the plugin pipeline (markdown-it +
 * sandboxed worker plugins). v1 returns the full document; streamed
 * fragments land as a follow-up without changing this contract. */
export default async function (ctx: RequestCtx): Promise<Response> {
  let content: string;
  try {
    content = state.notes.get(ctx.params.title).content ?? "";
  } catch (e) {
    if (e instanceof InvalidTitleError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
  const html = await renderMarkdown(content);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
