// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { identityHttp, ownOutcomeResponse } from "@server/auth/http_policy.ts";
import { readRequestJson } from "@server/auth/request_json.ts";
import { state } from "@server/state.ts";
export const operation = "manageVault";
export default identityHttp(async (request: PathfinderRequest) => {
  const identity = state.identity!, raw = request._raw;
  const principal = await identity.composition.auth.principal(raw);
  const admission = identity.access.admit(principal);
  const input = await readRequestJson(request.body);
  admission.assertCurrent();
  const body = await identity.provisioning.createAndAdd(
    principal,
    input,
    raw.signal,
  );
  return ownOutcomeResponse(
    new Response(body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    }),
  );
});
