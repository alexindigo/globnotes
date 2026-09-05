// SPDX-License-Identifier: LGPL-3.0-only

/**
 * App-wide auth middleware (the old Router.use(requireAuth)):
 * setup gate → read-only gate → token validation, skipped for routes that
 * opted out via `export const auth = false` (context.meta.auth) and for
 * 404/405 misses (context.miss — public, matching the Python server).
 *
 * Dir `/_` covers the whole app space but NOT layer0's `/_status` (no
 * prefix overlap — layer0 is the package's own tree).
 */

import type { Middleware } from "@pathfinder/pathfinder";

import { enforceAuth } from "@server/auth/middleware.ts";

export default (async (request, context) => {
  if (context.miss !== undefined) return; // 404/405 stay public
  if (context.meta.auth === false) return; // opted-out routes
  await enforceAuth(request._raw);
}) satisfies Middleware;
