// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { vaultAccessHandlers } from "@server/auth/access.ts";
import { identityHttp, ownOutcomeResponse } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "manageVault";
export default identityHttp(async (request: PathfinderRequest) => {
  const identity = state.identity!;
  const response = await vaultAccessHandlers(
    identity.access,
    identity.composition.auth.principal,
  ).put(request._raw);
  return response.ok ? ownOutcomeResponse(response) : response;
});
