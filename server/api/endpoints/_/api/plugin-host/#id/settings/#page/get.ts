// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";

/** GET /_/api/plugin-host/<id>/settings/<page> — validated effective values
 * and the current persistence revision. */
export default async function (request: PathfinderRequest) {
  const catalog = await state.plugins!.catalog();
  const plugin = catalog.plugins.find((p) =>
    p.id === String(request.params.id)
  );
  const page = plugin?.pages.find((p) => p.id === String(request.params.page));
  if (!page) throw new HttpError(404, "Not Found");
  try {
    const owner = state.pluginData!.forPlugin(String(request.params.id));
    const current = await owner.page(page);
    return {
      values: current.values,
      revision: current.revision,
      sourceKey: current.sourceKey,
      fields: current.fields,
    };
  } catch (e) {
    if (e instanceof PluginContractError) {
      return Response.json(
        { detail: e.message, code: e.code },
        { status: e.status },
      );
    }
    throw e;
  }
}
