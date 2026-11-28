// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { identityAuthCheck } from "@server/auth/access.ts";
import { identityHttp } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "session";
export default identityHttp((request: PathfinderRequest) => {
  const { access, composition } = state.identity!;
  return identityAuthCheck(
    request._raw,
    access,
    composition.auth.principal,
    composition.responses.status,
  );
});
