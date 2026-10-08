// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Authentication middleware, ported from the Python server's require_auth
 * dependency. Order matters: setup gate first, then the read-only gate,
 * then token validation. Applies only to routes that didn't opt out via
 * `export const auth = false`.
 */

import { AuthType } from "../config.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "../state.ts";
import type { NoteMutationLease } from "../plugins/lifecycle.ts";
import { OperationError } from "../plugins/errors.ts";

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
  await enforceAuthMetadata(req);
}

/** Internal authenticated expiry projection; never decodes an unverified JWT. */
export async function enforceAuthMetadata(
  req: Request,
): Promise<{ expiresAt: number | null }> {
  if (state.config.setupRequired) {
    throw new HttpError(503, "setup_required");
  }
  if (state.config.authType === AuthType.READ_ONLY && req.method !== "GET") {
    throw new HttpError(403, "read-only mode");
  }
  if (state.auth !== null) {
    try {
      return await state.auth.validateTokenMetadata(tokenFromRequest(req));
    } catch {
      throw new HttpError(401, "Invalid authentication credentials", {
        "WWW-Authenticate": "Bearer",
      });
    }
  }
  return { expiresAt: null };
}

/** Capture original HTTP note authority before any awaited request work.
 * Public settings locking is deliberately not part of note authority. */
export async function noteMutationLease(
  req: Request,
): Promise<NoteMutationLease> {
  const config = state.config, auth = state.auth, lifecycle = state.lifecycle;
  if (!lifecycle) throw new HttpError(503, "Note operations are unavailable.");
  const epoch = lifecycle.epoch;
  const metadata = await enforceAuthMetadata(req);
  const assertCurrent = (operationId?: string) => {
    if (state.config.setupRequired) throw new HttpError(503, "setup_required");
    if (state.config.authType === AuthType.READ_ONLY) {
      throw new HttpError(403, "read-only mode");
    }
    if (
      state.auth !== auth ||
      (metadata.expiresAt !== null && Date.now() >= metadata.expiresAt)
    ) {
      throw new HttpError(401, "Invalid authentication credentials", {
        "WWW-Authenticate": "Bearer",
      });
    }
    if (
      state.config !== config || state.lifecycle !== lifecycle ||
      lifecycle.epoch !== epoch
    ) {
      throw new OperationError(
        409,
        "operation_conflict",
        "Access policy changed while this operation was pending; it was not applied.",
        { operationId },
      );
    }
    if (!lifecycle.operational()) throw new HttpError(503, "setup_required");
    if (!lifecycle.writable()) throw new HttpError(403, "read-only mode");
  };
  assertCurrent();
  return Object.freeze({ epoch, assertCurrent });
}

/** Host-owned request lease carried to the final settings persistence effect.
 * No request or credential is transported to a plugin. */
export async function settingsWriteGuard(req: Request): Promise<() => void> {
  const auth = state.auth, epoch = state.lifecycle?.epoch;
  const accessRevision = state.config.storedConfig?.access_revision;
  const metadata = await enforceAuthMetadata(req);
  const check = () => {
    if (!state.config.settingsWritable) {
      throw new HttpError(
        403,
        "Settings are read-only; change deployment configuration to recover access.",
      );
    }
    if (
      state.auth !== auth ||
      (metadata.expiresAt !== null && Date.now() >= metadata.expiresAt)
    ) {
      throw new HttpError(401, "Invalid authentication credentials");
    }
    if (
      state.lifecycle?.epoch !== epoch ||
      state.config.storedConfig?.access_revision !== accessRevision
    ) {
      throw new HttpError(
        409,
        "Access policy changed; review current settings before retrying.",
      );
    }
  };
  check();
  return check;
}
