// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "editNotes";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { noteMutationLease } from "@server/auth/middleware.ts";
import { committedJson } from "@server/auth/http_policy.ts";
import { readRequestJson } from "@server/auth/request_json.ts";
import { ConflictStaleError } from "@server/hub/conflicts.ts";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import { state } from "@server/state.ts";

export default async function (request: PathfinderRequest<{ id: string }>) {
  try {
    const lease = await noteMutationLease(request._raw);
    const body = await readRequestJson(request.body);
    return committedJson(
      await state.operations!.resolveConflict(request.params.id, body, {
        origin: "api",
        lease,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ConflictStaleError) {
      return Response.json(
        { code: error.code, status: "stale", id: error.id },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof OperationError) {
      const response = toOperationResponse(error);
      response.headers.set("cache-control", "no-store");
      return response;
    }
    if (error instanceof HttpError) {
      error.headers = { ...error.headers, "Cache-Control": "no-store" };
    }
    throw error;
  }
}
