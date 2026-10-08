// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import { readPermissionBody } from "../../../permissions/put.ts";

export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  try {
    return await state.pluginNetwork!.controls(
      String(request.params.id),
      await readPermissionBody(request),
      String(request.params.request),
      guard,
    );
  } catch (error) {
    if (error instanceof PluginContractError) {
      return Response.json({ detail: error.message, code: error.code }, {
        status: error.status,
      });
    }
    throw error;
  }
}
