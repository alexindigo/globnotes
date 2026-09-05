// SPDX-License-Identifier: LGPL-3.0-only

import { note_exists } from "@server/api_messages.ts";
import type { NoteCreate } from "@server/notes/models.ts";
import { InvalidPathError, NoteExistsError } from "@server/notes/models.ts";
import { validateNotePath } from "@server/notes/validate.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export default async function (request) {
  const data = (await request.body.json()) as NoteCreate;
  // Pydantic model validation runs before the route in the Python server.
  data.path = validateNotePath(data.path, "path");
  try {
    return state.notes.create(data);
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteExistsError) throw new HttpError(409, note_exists);
    throw e;
  }
}
