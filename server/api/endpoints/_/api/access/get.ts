// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { vaultAccessHandlers } from "@server/auth/access.ts";
import { identityHttp } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "manageVault";
export default identityHttp((request: PathfinderRequest) => {
  const identity = state.identity!;
  return vaultAccessHandlers(
    identity.access,
    identity.composition.auth.principal,
  ).get(request._raw);
});
