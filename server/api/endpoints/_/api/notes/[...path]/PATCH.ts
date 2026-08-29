// SPDX-License-Identifier: LGPL-3.0-only

import { note_exists, note_not_found } from "@server/api_messages.ts";
import type { NoteUpdate } from "@server/notes/models.ts";
import {
  InvalidPathError,
  NoteExistsError,
  NoteNotFoundError,
} from "@server/notes/models.ts";
import { validateNotePath } from "@server/notes/validate.ts";
import { HttpError } from "@server/http_error.ts";
import type { RequestCtx } from "@server/router.ts";
import { state } from "@server/state.ts";

export default async function (ctx: RequestCtx) {
  const data = (await ctx.req.json()) as NoteUpdate;
  const fileRefs = ctx.query.get("file_refs") ?? "none";
  if (data.newPath !== undefined && data.newPath !== null) {
    data.newPath = validateNotePath(data.newPath, "newPath");
  }
  try {
    return state.notes.update(ctx.params.path, data, fileRefs);
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteExistsError) throw new HttpError(409, note_exists);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
}
