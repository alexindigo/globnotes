// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { identityHttp } from "@server/auth/http_policy.ts";
import { assertVaultTarget } from "@server/config/projection.ts";
import { state } from "@server/state.ts";
export const operation = "session";
export default identityHttp((request: PathfinderRequest) => {
  assertVaultTarget(state.config, request);
  return state.identity!.composition.responses.config(request._raw);
});
