// SPDX-License-Identifier: LGPL-3.0-only

import { invalid_note_path, note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError, json } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export default function (request) {
  try {
    state.notes.delete(request.params.path);
  } catch (e) {
    if (e instanceof InvalidPathError) {
      throw new HttpError(400, invalid_note_path);
    }
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
  return json(null);
}
