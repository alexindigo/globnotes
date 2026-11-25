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

import { HttpError, type Middleware } from "@pathfinder/pathfinder";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import {
  createHttpPolicy,
  type HttpOperation,
  type InstanceAuth,
  ownsOutcomeResponse,
  protectVaultResponse,
  replacePrivateResponse,
} from "@server/auth/http_policy.ts";

import { enforceAuth } from "@server/auth/middleware.ts";
import { assertVaultTarget } from "@server/config/projection.ts";
import { state } from "@server/state.ts";
import { logger } from "@server/logger.ts";

declare module "@pathfinder/pathfinder" {
  interface Meta {
    auth?: boolean;
    operation?: HttpOperation;
  }
}

/** Prepared only; production activation belongs to I14. */
export function createIdentityAuthMiddleware(auth: InstanceAuth): Middleware {
  const policy = createHttpPolicy(auth);
  return async (request, context) => {
    if (context.miss !== undefined) return;
    const lease = await policy.admit(request._raw, context.meta.operation);
    if (!lease) return;
    context.state.identityLease = lease;
    return (response) => {
      if (ownsOutcomeResponse(response._raw)) return;
      try {
        return protectVaultResponse(lease, response._raw);
      } catch (error) {
        if (error instanceof OperationError) {
          return replacePrivateResponse(
            response._raw,
            toOperationResponse(error),
          );
        }
        if (error instanceof HttpError) {
          return replacePrivateResponse(
            response._raw,
            Response.json({ detail: error.detail }, {
              status: error.status,
              headers: error.headers,
            }),
          );
        }
        // Preserve Pathfinder's generic 500 outcome while retaining source
        // custody until consumption, including abort/lifetime/unknown failures.
        logger.error("Private response refused:", error);
        return replacePrivateResponse(
          response._raw,
          new Response(null, { status: 500 }),
        );
      }
    };
  };
}

export default (async (request, context) => {
  if (context.miss !== undefined) return; // 404/405 stay public
  assertVaultTarget(state.config, request);
  if (context.meta.auth === false) return; // opted-out routes
  await enforceAuth(request._raw);
}) satisfies Middleware;
