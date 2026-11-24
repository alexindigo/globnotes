// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "editNotes";

import { note_exists, note_not_found } from "@server/api_messages.ts";
import {
  InvalidPathError,
  NoteExistsError,
  NoteNotFoundError,
} from "@server/notes/models.ts";
import { readNoteUpdate } from "@server/notes/request.ts";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import {
  type Context,
  HttpError,
  type PathfinderRequest,
} from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import { noteMutationLease } from "@server/auth/middleware.ts";
import { deliverAdmissionRefusals } from "@server/auth/admission_refusal.ts";
import { committedWithPrivateJson } from "@server/auth/http_policy.ts";

export default deliverAdmissionRefusals(
  async (request: PathfinderRequest<{ path: string }>, context?: Context) => {
    try {
      const lease = await noteMutationLease(request._raw);
      const data = await readNoteUpdate(request.body);
      const fileRefs = request.query.get("file_refs") ?? "none";
      const note = await state.operations!.updateNote(
        request.params.path,
        data,
        fileRefs,
        { origin: "api", lease },
      );
      return committedWithPrivateJson(context?.state.identityLease, note, {
        committed: true,
        saveResult: { status: note.saveResult?.status ?? "saved" },
      });
    } catch (e) {
      if (e instanceof OperationError) return toOperationResponse(e);
      if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
      if (e instanceof NoteExistsError) throw new HttpError(409, note_exists);
      if (e instanceof NoteNotFoundError) {
        throw new HttpError(404, note_not_found);
      }
      throw e;
    }
  },
);
