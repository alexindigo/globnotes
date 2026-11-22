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
import { readCredential } from "../../shared/credentials.ts";
import {
  type AuthorityVault,
  InstanceAuthority,
  type InstanceOperation,
  type VaultOperation,
} from "./authority.ts";
import {
  AuthenticationError,
  type InstanceSessions,
  type Principal,
} from "./sessions.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";

/** Preparatory v3 adapter. The old exported production functions below stay
 * active until cutover; tests/next composition inject concrete instance owners. */
export function createInstanceAuth(adapters: {
  sessions: InstanceSessions;
  vault(request: Request): AuthorityVault | null;
  cookieName: string;
  /** Explicit prepared composition binding; never a silent production no-op. */
  lifetime(request: Request): OperationLease<"live">;
}) {
  const owners = new WeakMap<
    InstanceSessions,
    WeakMap<Request, Promise<Principal>>
  >();
  const invalid = () =>
    new HttpError(401, "Invalid authentication credentials.", {
      "WWW-Authenticate": "Bearer",
    });
  const token = (request: Request): string | null => {
    try {
      return readCredential(
        request.headers.get("authorization"),
        request.headers.get("cookie") ?? "",
        adapters.cookieName,
      );
    } catch {
      throw invalid();
    }
  };
  const principal = async (
    request: Request,
    sessions = adapters.sessions,
  ): Promise<Principal> => {
    let requests = owners.get(sessions);
    if (!requests) {
      requests = new WeakMap();
      owners.set(sessions, requests);
    }
    let pending = requests.get(request);
    if (!pending) {
      try {
        // Capture credentials synchronously, including failure, before yielding.
        const credential = token(request);
        pending = Promise.resolve().then(() => sessions.resolve(credential));
      } catch (error) {
        pending = Promise.reject(error);
      }
      requests.set(request, pending);
    }
    try {
      const value = await pending;
      if (value.kind === "account") sessions.assertCurrent(value);
      return value;
    } catch (error) {
      if (error instanceof AuthenticationError) throw invalid();
      throw error;
    }
  };
  const admission = (request: Request) => {
    const sessions = adapters.sessions;
    const lifetime = adapters.lifetime(request);
    assertOperationLease(lifetime, "live");
    const { lease: requestLifetime } = createOperationLease("live", [() => {
      request.signal.throwIfAborted();
      if (adapters.sessions !== sessions) throw invalid();
    }], [lifetime]);
    const check = requestLifetime.assertCurrent;
    check();
    return {
      sessions,
      check,
      evaluator: new InstanceAuthority(sessions, () => {
        check();
        return adapters.vault(request);
      }, requestLifetime),
    };
  };
  const lease = async (request: Request, operation: VaultOperation) => {
    const admitted = admission(request);
    const bind = admitted.evaluator.prepareLease(operation);
    const value = await principal(request, admitted.sessions);
    admitted.check();
    return bind(value);
  };
  const instanceLease = async (
    request: Request,
    operation: InstanceOperation,
  ) => {
    const admitted = admission(request);
    const value = await principal(request, admitted.sessions);
    admitted.check();
    return admitted.evaluator.instanceLease(value, operation);
  };
  return Object.freeze({
    principal: (request: Request) => principal(request),
    lease,
    instanceLease,
    /** Live capability flags for the request's principal and concrete vault. */
    async capabilities(request: Request) {
      const admitted = admission(request);
      const value = await principal(request, admitted.sessions);
      admitted.check();
      return admitted.evaluator.capabilities(value);
    },
    async viewer(request: Request) {
      const admitted = admission(request);
      const bind = admitted.evaluator.prepareViewer();
      const value = await principal(request, admitted.sessions);
      admitted.check();
      return bind(value);
    },
    noteMutationLease: (request: Request) => lease(request, "editNotes"),
    readLease: (request: Request) => lease(request, "readVault"),
    async settingsWriteGuard(request: Request): Promise<() => void> {
      return (await lease(request, "manageVault")).assertCurrent;
    },
    async instanceGuard(
      request: Request,
      operation: InstanceOperation,
    ): Promise<() => void> {
      return (await instanceLease(request, operation)).assertCurrent;
    },
  });
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
  const { expiresAt } = await authenticate(req, req.method !== "GET");
  return { expiresAt };
}

/** The same rules for a request that only reads, whatever its HTTP method:
 * MCP sends every call as POST, so its read-only gate is per tool
 * (server/mcp/), not per method. Writes still need noteMutationLease.
 * Resolves to the authenticated subject, or null when the deployment has
 * no authentication. */
export async function enforceReadAuth(req: Request): Promise<string | null> {
  return (await authenticate(req, false)).subject;
}

async function authenticate(
  req: Request,
  writes: boolean,
): Promise<{ expiresAt: number | null; subject: string | null }> {
  if (state.config.setupRequired) {
    throw new HttpError(503, "setup_required");
  }
  if (state.config.authType === AuthType.READ_ONLY && writes) {
    throw new HttpError(403, "read-only mode");
  }
  const auth = state.auth;
  if (auth !== null) {
    try {
      const { expiresAt } = await auth.validateTokenMetadata(
        readCredential(
          req.headers.get("authorization"),
          req.headers.get("cookie") ?? "",
          "token",
        ),
      );
      // A valid token's subject is the account (validateTokenMetadata
      // checks it).
      return { expiresAt, subject: auth.username };
    } catch {
      throw new HttpError(401, "Invalid authentication credentials", {
        "WWW-Authenticate": "Bearer",
      });
    }
  }
  return { expiresAt: null, subject: null };
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
