// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";

/** Worker-free metadata, including disabled/failed/settings-less plugins. */
export default async function (request: PathfinderRequest) {
  try {
    return await state.pluginNetwork!.view(String(request.params.id));
  } catch (error) {
    if (error instanceof PluginContractError) {
      return Response.json({ detail: error.message, code: error.code }, {
        status: error.status,
      });
    }
    throw error;
  }
}
