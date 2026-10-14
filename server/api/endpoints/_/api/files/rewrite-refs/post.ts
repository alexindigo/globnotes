// SPDX-License-Identifier: LGPL-3.0-only

import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import {
  HttpError,
  json,
  type PathfinderRequest,
} from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import { noteMutationLease } from "@server/auth/middleware.ts";

export default async function (request: PathfinderRequest) {
  try {
    const lease = await noteMutationLease(request._raw);
    const oldPath = request.query.get("old_path") ?? "";
    const newPath = request.query.get("new_path") ?? "";
    await state.operations!.rewriteRefs(oldPath, newPath, {
      origin: "api",
      lease,
    });
  } catch (e) {
    // Guard cancellations/conflicts keep their structured wire envelope;
    // only genuine storage failures fall through to the legacy 500.
    if (e instanceof OperationError) return toOperationResponse(e);
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, (e as Error).message);
  }
  return json(null);
}
