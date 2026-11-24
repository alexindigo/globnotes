// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { bootstrapHandlers } from "@server/auth/bootstrap.ts";
import { identityHttp } from "@server/auth/http_policy.ts";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";

export const operation = "public";
export default identityHttp(async (request: PathfinderRequest) => {
  const { identity, plugins } = state;
  if (!identity!.bootstrap.status().setupRequired) {
    throw new HttpError(409, "Setup is already complete.");
  }
  const response = await bootstrapHandlers(identity!.bootstrap).post(
    request._raw,
  );
  // Service readiness is separate from delivering the committed sign-in result.
  void plugins?.reconcileOwners().catch((error) =>
    logger.error("plugin owner reconciliation failed", error)
  );
  response.headers.set("cache-control", "no-store");
  return response;
});
