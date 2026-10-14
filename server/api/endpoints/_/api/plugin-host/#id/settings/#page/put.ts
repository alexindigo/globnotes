// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";

/** PUT /_/api/plugin-host/<id>/settings/<page> — validated page values with
 * revision checking; committed values notify the owning plugin. */
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  const catalog = await state.plugins!.catalog();
  const plugin = catalog.plugins.find((p) =>
    p.id === String(request.params.id)
  );
  const page = plugin?.pages.find((p) => p.id === String(request.params.page));
  if (!page) throw new HttpError(404, "Not Found");
  const lease = state.pluginData!.forPlugin(String(request.params.id))
    .settingsLease(plugin!.pages);
  const body = (await request.body.json()) as {
    values?: unknown;
    revision?: number;
    sourceKey?: string;
  };
  try {
    lease.assertCurrent();
    const owner = state.pluginData!.forPlugin(String(request.params.id), () => {
      lease.assertCurrent();
      guard();
    });
    const committed = await owner.savePage(
      page,
      body.values ?? {},
      body.revision ?? -1,
      body.sourceKey,
    );
    state.lifecycle?.notifyInvalidation();
    return {
      values: committed.values,
      revision: committed.revision,
      sourceKey: committed.sourceKey,
      fields: committed.fields,
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
