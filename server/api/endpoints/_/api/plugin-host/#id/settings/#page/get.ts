// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { deliverAdmissionRefusals } from "@server/auth/admission_refusal.ts";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";

/** Runtime values for enabled browser contributions; full page for Admin. */
export default deliverAdmissionRefusals(async (request: PathfinderRequest) => {
  try {
    return await state.identity!.composition.responses.pluginSettings(
      request._raw,
      state.pluginData!,
      String(request.params.id),
      String(request.params.page),
    );
  } catch (e) {
    if (e instanceof PluginContractError) {
      return Response.json(
        { detail: e.message, code: e.code },
        { status: e.status },
      );
    }
    throw e;
  }
});
