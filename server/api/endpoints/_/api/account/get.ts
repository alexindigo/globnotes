// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { ownAccountHandlers } from "@server/auth/account.ts";
import { identityHttp } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "manageOwnAccount";
export default identityHttp((request: PathfinderRequest) => {
  const identity = state.identity!;
  return ownAccountHandlers(
    identity.account,
    identity.composition.auth.principal,
  ).get(request._raw);
});
