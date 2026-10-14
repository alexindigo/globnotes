// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";

/** PUT /_/api/plugin-host/<id>/enabled — revision/signature-checked vault
 * enablement with immediate runtime reconciliation. */
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  const body = (await request.body.json()) as {
    enabled?: boolean;
    revision?: number;
    signature?: string;
  };
  if (typeof body.enabled !== "boolean") {
    throw new HttpError(422, "enabled must be a boolean");
  }
  try {
    const result = await state.plugins!.policy.setEnabled(
      String(request.params.id),
      body.enabled,
      { revision: body.revision ?? -1, signature: body.signature ?? "" },
      guard,
    );
    // reconcile()'s change notification publishes the invalidation.
    await state.plugins!.reconcileOwners({
      replaceId: body.enabled ? String(request.params.id) : undefined,
    });
    return { policy: result.metadata };
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
