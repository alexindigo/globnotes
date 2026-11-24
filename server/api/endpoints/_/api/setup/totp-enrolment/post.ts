// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { bootstrapHandlers } from "@server/auth/bootstrap.ts";
import { identityHttp } from "@server/auth/http_policy.ts";
import { state } from "@server/state.ts";
export const operation = "public";
export default identityHttp(async (request: PathfinderRequest) => {
  const bootstrap = state.identity!.bootstrap;
  if (!bootstrap.status().setupRequired) {
    throw new HttpError(409, "Setup is already complete.");
  }
  const bundle = await bootstrapHandlers(bootstrap).enrolment(request._raw);
  return Response.json(bundle, { headers: { "cache-control": "no-store" } });
});
