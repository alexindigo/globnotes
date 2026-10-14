// SPDX-License-Identifier: LGPL-3.0-only

import { invalid_file_name } from "@server/api_messages.ts";
import { ValueError } from "@server/files/file_serving.ts";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import { noteMutationLease } from "@server/auth/middleware.ts";

/** Upload a file into the given directory (relative to the notes
 * root), creating the directory if needed. */
export default async function (request: PathfinderRequest) {
  try {
    const lease = await noteMutationLease(request._raw);
    const form = await request.body.form();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new HttpError(422, "file field is required");
    }
    const directory = (form.get("directory") as string | null) ?? "";
    const body = new Uint8Array(await file.arrayBuffer());
    return await state.operations!.uploadFile(directory, file.name, body, {
      origin: "api",
      lease,
    });
  } catch (e) {
    if (e instanceof OperationError) return toOperationResponse(e);
    if (e instanceof ValueError) {
      throw new HttpError(400, invalid_file_name);
    }
    throw e;
  }
}
