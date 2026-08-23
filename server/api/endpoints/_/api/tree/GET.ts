// SPDX-License-Identifier: LGPL-3.0-only

import { note_not_found } from "@server/api_messages.ts";
import { InvalidTitleError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

/** Tree notes carry displayTitle for the sidebar label; `title` stays
 * the path (identity). */
export default function (ctx: RequestCtx) {
  const dirPath = ctx.query.get("path") ?? "";
  try {
    const level = state.notes.listLevel(dirPath);
    const meta = state.indexer?.displayTitlesFor(
      level.notes.map((t) => t + ".md"),
    ) ?? {};
    return {
      folders: level.folders,
      notes: level.notes.map((t) => ({
        title: t,
        displayTitle: meta[t + ".md"] ?? t.split("/").pop(),
      })),
    };
  } catch (e) {
    if (e instanceof InvalidTitleError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
}
