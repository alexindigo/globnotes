// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "manageVault";
import type { Context, PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import { deliverAdmissionRefusals } from "@server/auth/admission_refusal.ts";
import { readRequestObject } from "@server/auth/request_json.ts";
import { committedWithPrivateJson } from "@server/auth/http_policy.ts";

/** PUT /_/api/plugin-host/<id>/settings/<page> — validated page values with
 * revision checking; committed values notify the owning plugin. */
export default deliverAdmissionRefusals(
  async (request: PathfinderRequest, context?: Context) => {
    const guard = await settingsWriteGuard(request._raw);
    const catalog = await state.plugins!.catalog();
    const plugin = catalog.plugins.find((p) =>
      p.id === String(request.params.id)
    );
    const page = plugin?.pages.find((p) =>
      p.id === String(request.params.page)
    );
    if (!page) throw new HttpError(404, "Not Found");
    const lease = state.pluginData!.forPlugin(String(request.params.id))
      .settingsLease(plugin!.pages);
    const body = (await readRequestObject(request.body)) as {
      values?: unknown;
      revision?: number;
      sourceKey?: string;
    };
    try {
      lease.assertCurrent();
      const owner = state.pluginData!.forPlugin(
        String(request.params.id),
        () => {
          lease.assertCurrent();
          guard();
        },
      );
      const committed = await owner.savePage(
        page,
        body.values ?? {},
        body.revision ?? -1,
        body.sourceKey,
      );
      return committedWithPrivateJson(context?.state.identityLease, {
        values: committed.values,
        revision: committed.revision,
        sourceKey: committed.sourceKey,
        fields: committed.fields,
      }, { committed: true, revision: committed.revision });
    } catch (e) {
      if (e instanceof PluginContractError) {
        return Response.json(
          { detail: e.message, code: e.code },
          { status: e.status },
        );
      }
      throw e;
    }
  },
);
