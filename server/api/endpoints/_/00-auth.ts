// SPDX-License-Identifier: LGPL-3.0-only

/**
 * App-wide account admission uses operation metadata, not the HTTP method.
 *
 * Dir `/_` covers the whole app space but NOT layer0's `/_status` (no
 * prefix overlap — layer0 is the package's own tree).
 */

import { HttpError, type Middleware } from "@pathfinder/pathfinder";
import { OperationError, toOperationResponse } from "@server/plugins/errors.ts";
import {
  createHttpPolicy,
  type HttpLease,
  type HttpOperation,
  type InstanceAuth,
  ownsOutcomeResponse,
  protectVaultResponse,
  replacePrivateResponse,
} from "@server/auth/http_policy.ts";

import { activeAuth } from "@server/auth/middleware.ts";
import { AdmissionRefusal } from "@server/auth/admission_refusal.ts";
import { logger } from "@server/logger.ts";

declare module "@pathfinder/pathfinder" {
  interface Meta {
    operation?: HttpOperation;
  }
}

export function createIdentityAuthMiddleware(auth: InstanceAuth): Middleware {
  const policy = createHttpPolicy(auth);
  return async (request, context) => {
    if (context.miss !== undefined) return;
    let lease: HttpLease | null;
    try {
      lease = await policy.admit(request._raw, context.meta.operation);
    } catch (error) {
      if (error instanceof AdmissionRefusal) return error.response();
      throw error;
    }
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
        if (error instanceof AdmissionRefusal) {
          return replacePrivateResponse(response._raw, error.response());
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
  return await createIdentityAuthMiddleware(activeAuth())(request, context);
}) satisfies Middleware;
