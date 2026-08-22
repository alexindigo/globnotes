// SPDX-License-Identifier: LGPL-3.0-only

import { invalid_note_title, note_not_found } from "@server/api_messages.ts";
import { InvalidTitleError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

export default function (ctx: RequestCtx) {
  try {
    state.notes.delete(ctx.params.title);
  } catch (e) {
    if (e instanceof InvalidTitleError) {
      throw new HttpError(400, invalid_note_title);
    }
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
  return null;
}
