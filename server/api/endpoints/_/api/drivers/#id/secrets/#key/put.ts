// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { driverControl } from "@server/hub/drivers/api.ts";
export default function (
  request: PathfinderRequest<{ id: string; key: string }>,
) {
  return driverControl(
    request,
    (owner, body, guard) =>
      owner.secret(request.params.id, request.params.key, body, false, guard),
  );
}
