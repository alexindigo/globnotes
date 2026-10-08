// SPDX-License-Identifier: LGPL-3.0-only

import { invalid_note_path, note_not_found } from "@server/api_messages.ts";
import { InvalidPathError, NoteNotFoundError } from "@server/notes/models.ts";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import {
  HttpError,
  json,
  type PathfinderRequest,
} from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import { noteMutationLease } from "@server/auth/middleware.ts";

export default async function (request: PathfinderRequest<{ path: string }>) {
  try {
    const lease = await noteMutationLease(request._raw);
    await state.operations!.deleteNote(request.params.path, {
      origin: "api",
      lease,
    });
  } catch (e) {
    if (e instanceof OperationError) return toOperationResponse(e);
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
