// SPDX-License-Identifier: LGPL-3.0-only

import { note_exists } from "@server/api_messages.ts";
import type { NoteCreate } from "@server/notes/models.ts";
import { InvalidTitleError, NoteExistsError } from "@server/notes/models.ts";
import { validateNoteTitle } from "@server/notes/validate.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

export default async function (ctx: RequestCtx) {
  const data = (await ctx.req.json()) as NoteCreate;
  // Pydantic model validation runs before the route in the Python server.
  data.title = validateNoteTitle(data.title, "title");
  try {
    return state.notes.create(data);
  } catch (e) {
    if (e instanceof InvalidTitleError) throw new HttpError(400, e.message);
    if (e instanceof NoteExistsError) throw new HttpError(409, note_exists);
    throw e;
  }
}
