// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { identityHttp } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "session";
export default identityHttp(async (request: PathfinderRequest) => {
  const identity = state.identity!, raw = request._raw;
  return identity.provisioning.reviewResponse(
    await identity.composition.auth.principal(raw),
    request.query.get("operationId"),
    raw.signal,
  );
});
