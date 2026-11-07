// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { readConflict } from "@server/hub/conflicts.ts";
import { state } from "@server/state.ts";

export default function (request: PathfinderRequest<{ id: string }>) {
  if (!state.hub) throw new HttpError(503, "Conflicts unavailable");
  return Response.json(
    readConflict({
      hub: state.hub,
      stateRoot: Deno.realPathSync(state.config.statePath),
    }, request.params.id),
    { headers: { "cache-control": "no-store" } },
  );
}
