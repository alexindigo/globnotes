// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "manageVault";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { driverControl } from "@server/hub/drivers/api.ts";
export default function (request: PathfinderRequest) {
  return driverControl(
    request,
    (owner, body, guard) => owner.create(body, guard),
  );
}
