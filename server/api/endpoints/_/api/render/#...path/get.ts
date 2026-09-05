// SPDX-License-Identifier: LGPL-3.0-only

import { note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { renderMarkdown } from "@server/render/pipeline.ts";
import { state } from "@server/state.ts";

/** Render a note's markdown through the plugin pipeline (markdown-it +
 * sandboxed worker plugins). v1 returns the full document; streamed
 * fragments land as a follow-up without changing this contract. */
export default async function (request): Promise<Response> {
  let content: string;
  try {
    content = state.notes.get(request.params.path).content ?? "";
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
  const html = await renderMarkdown(content, {
    disabled: (request.query.get("disabled") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    lineNumbers: (request.query.get("lineNumbers") ?? "") === "true",
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
