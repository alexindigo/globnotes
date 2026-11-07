// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
export default async function () {
  if (!state.drivers) throw new HttpError(503, "Sync is unavailable");
  return Response.json(await state.drivers.view(), {
    headers: { "cache-control": "no-store" },
  });
}
