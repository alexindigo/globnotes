// SPDX-License-Identifier: LGPL-3.0-only

import { note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { folderLevel } from "@server/notes/folder_level.ts";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";

/** Tree notes carry `path` (identity) and `title` (display label). */
export default function (request: PathfinderRequest) {
  const dirPath = request.query.get("path") ?? "";
  try {
    return folderLevel(dirPath);
  } catch (e) {
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
}
