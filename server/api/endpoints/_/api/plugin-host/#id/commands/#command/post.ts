// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

/** POST /_/api/plugin-host/<id>/commands/<command> — invoke a registered
 * server command; the result is the command's actual return value. */
export default async function (request: PathfinderRequest) {
  const runtime = state.plugins?.runtime;
  if (!runtime?.isEnabled(String(request.params.id))) {
    throw new HttpError(404, "Not Found");
  }
  const payload = await request.body.json().catch(() => ({}));
  try {
    const result = await runtime.invokeCommand(
      String(request.params.id),
      String(request.params.command),
      payload,
    );
    return Response.json({ result });
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes("not registered")) {
      throw new HttpError(404, "Not Found");
    }
    throw new HttpError(500, "plugin command failed");
  }
}
