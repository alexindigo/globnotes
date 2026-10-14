// SPDX-License-Identifier: LGPL-3.0-only
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";

export default async function () {
  try {
    return await state.pluginNetwork!.pending();
  } catch (error) {
    if (error instanceof PluginContractError) {
      return Response.json({ detail: error.message, code: error.code }, {
        status: error.status,
      });
    }
    throw error;
  }
}
