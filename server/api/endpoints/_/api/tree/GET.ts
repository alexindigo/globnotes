// SPDX-License-Identifier: LGPL-3.0-only

import { note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

/** Tree notes carry `path` (identity) and `title` (display label). */
export default function (ctx: RequestCtx) {
  const dirPath = ctx.query.get("path") ?? "";
  try {
    const level = state.notes.listLevel(dirPath);
    const meta = state.indexer?.titlesFor(
      level.notes.map((t) => t + ".md"),
    ) ?? {};
    return {
      folders: level.folders,
      notes: level.notes.map((t) => ({
        path: t,
        title: meta[t + ".md"] ?? t.split("/").pop(),
      })),
    };
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
}
