// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "editNotes";

import { note_exists } from "@server/api_messages.ts";
import { InvalidPathError, NoteExistsError } from "@server/notes/models.ts";
import { readNoteCreate } from "@server/notes/request.ts";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import {
  type Context,
  HttpError,
  type PathfinderRequest,
} from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import { noteMutationLease } from "@server/auth/middleware.ts";
import { committedWithPrivateJson } from "@server/auth/http_policy.ts";
import { deliverAdmissionRefusals } from "@server/auth/admission_refusal.ts";

export default deliverAdmissionRefusals(
  async (request: PathfinderRequest, context?: Context) => {
    try {
      const lease = await noteMutationLease(request._raw);
      const data = await readNoteCreate(request.body);
      const note = await state.operations!.createNote(data, {
        origin: "api",
        lease,
      });
      return committedWithPrivateJson(context?.state.identityLease, note, {
        committed: true,
        saveResult: { status: "saved" },
      });
    } catch (e) {
      if (e instanceof OperationError) return toOperationResponse(e);
      if (e instanceof InvalidPathError) throw new HttpError(400, e.message);
      if (e instanceof NoteExistsError) throw new HttpError(409, note_exists);
      throw e;
    }
  },
);
