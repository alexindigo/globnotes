// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { listConflicts } from "@server/hub/conflicts.ts";
import { state } from "@server/state.ts";

export default function () {
  if (!state.hub) throw new HttpError(503, "Conflicts unavailable");
  return Response.json(
    listConflicts({
      hub: state.hub,
      stateRoot: Deno.realPathSync(state.config.statePath),
    }),
    { headers: { "cache-control": "no-store" } },
  );
}
