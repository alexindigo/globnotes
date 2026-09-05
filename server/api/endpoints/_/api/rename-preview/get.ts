// SPDX-License-Identifier: LGPL-3.0-only

import { note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export default function (request) {
  const path = request.query.get("path") ?? "";
  const newPath = request.query.get("new_path") ?? "";
  try {
    return state.notes.previewRename(path, newPath);
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
}
