// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Authentication middleware, ported from the Python server's require_auth
 * dependency. Order matters: setup gate first, then the read-only gate,
 * then token validation. Applies only to routes that didn't opt out via
 * `export const auth = false`.
 */

import { AuthType } from "../config.ts";
import { HttpError } from "../http_error.ts";
import type { Middleware } from "../router.ts";
import { state } from "../state.ts";

function tokenFromRequest(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7);
  }
  const cookie = req.headers.get("cookie");
  if (cookie) {
    for (const pair of cookie.split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name === "token") return rest.join("=");
    }
  }
  return null;
}

/** The auth rules themselves, usable both by the middleware (gated by
 * ctx.authRequired) and by the catch-all which serves vault files. */
export async function enforceAuth(req: Request): Promise<void> {
  if (state.config.setupRequired) {
    throw new HttpError(503, "setup_required");
  }
  if (state.config.authType === AuthType.READ_ONLY && req.method !== "GET") {
    throw new HttpError(403, "read-only mode");
  }
  if (state.auth !== null) {
    try {
      await state.auth.validateToken(tokenFromRequest(req));
    } catch {
      throw new HttpError(401, "Invalid authentication credentials", {
        "WWW-Authenticate": "Bearer",
      });
    }
  }
}

export const requireAuth: Middleware = async (ctx, next) => {
  if (!ctx.authRequired) return next();
  await enforceAuth(ctx.req);
  return next();
};
