// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { PluginContractError } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";

/** PUT /_/api/plugin-host/policy — vault auto-enable default. Existing
 * inventory choices are materialized into the explicit lists first; a
 * pinned env default rejects with 409 policy_pinned. */
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  const body = (await request.body.json()) as {
    autoEnable?: boolean;
    revision?: number;
    signature?: string;
  };
  if (typeof body.autoEnable !== "boolean") {
    throw new HttpError(422, "autoEnable must be a boolean");
  }
  const catalog = await state.plugins!.catalog();
  try {
    const result = await state.plugins!.policy.setAutoEnable(
      body.autoEnable,
      catalog.plugins.map((p) => p.id),
      { revision: body.revision ?? -1, signature: body.signature ?? "" },
      guard,
    );
    // reconcile()'s change notification publishes the invalidation.
    await state.plugins!.reconcileOwners();
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
