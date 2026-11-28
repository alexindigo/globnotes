// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { identityHttp } from "@server/auth/http_policy.ts";
import { identityTokenHandler } from "@server/auth/token_handler.ts";
import { state } from "@server/state.ts";
export const operation = "public";
export default identityHttp((request: PathfinderRequest) => {
  const identity = state.identity!;
  return identityTokenHandler(identity.sessions)(request._raw);
});
