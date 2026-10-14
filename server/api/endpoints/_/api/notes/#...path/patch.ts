// SPDX-License-Identifier: LGPL-3.0-only

import { note_exists, note_not_found } from "@server/api_messages.ts";
import type { NoteUpdate } from "@server/notes/models.ts";
import {
  InvalidPathError,
  NoteExistsError,
  NoteNotFoundError,
} from "@server/notes/models.ts";
import { validateNotePath } from "@server/notes/validate.ts";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import { noteMutationLease } from "@server/auth/middleware.ts";

export default async function (request: PathfinderRequest<{ path: string }>) {
  try {
    const lease = await noteMutationLease(request._raw);
    const data = (await request.body.json()) as NoteUpdate;
    const fileRefs = request.query.get("file_refs") ?? "none";
    if (data.newPath !== undefined && data.newPath !== null) {
      data.newPath = validateNotePath(data.newPath, "newPath");
    }
    return await state.operations!.updateNote(
      request.params.path,
      data,
      fileRefs,
      { origin: "api", lease },
    );
  } catch (e) {
    if (e instanceof OperationError) return toOperationResponse(e);
    if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
    if (e instanceof NoteExistsError) throw new HttpError(409, note_exists);
    if (e instanceof NoteNotFoundError) {
      throw new HttpError(404, note_not_found);
    }
    throw e;
  }
}
