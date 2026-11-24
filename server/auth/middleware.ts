// SPDX-License-Identifier: LGPL-3.0-only

import { HttpError } from "@pathfinder/pathfinder";
import { AdmissionRefusal } from "./admission_refusal.ts";
import { state } from "../state.ts";
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

/** Request authentication using the captured session and issued lifetime. */
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
  const invalid = () => new AdmissionRefusal("credentials_refused");
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
    const checkSessions = () => {
      if (adapters.sessions !== sessions) throw invalid();
    };
    const { lease: requestLifetime } = createOperationLease("live", [() => {
      request.signal.throwIfAborted();
      checkSessions();
    }], [lifetime]);
    const check = requestLifetime.assertCurrent;
    check();
    return {
      sessions,
      check,
      requestLifetime,
      // Request cancellation remains a boundary for admission and response
      // delivery. A retained Worker callback owns the original principal and
      // target, but legitimately outlives transport completion.
      retained: () =>
        new InstanceAuthority(sessions, () => {
          checkSessions();
          return adapters.vault(request);
        }, lifetime),
      evaluator: new InstanceAuthority(sessions, () => {
        check();
        return adapters.vault(request);
      }, requestLifetime),
    };
  };
  const lease = async (request: Request, operation: VaultOperation) => {
    const admitted = admission(request);
    const bind = admitted.retained().prepareLease(
      operation,
      admitted.requestLifetime,
    );
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
    async principal(request: Request) {
      const admitted = admission(request);
      const value = await principal(request, admitted.sessions);
      admitted.check();
      return value;
    },
    lease,
    instanceLease,
    /** Live capability flags for the request's principal and concrete vault. */
    async capabilities(request: Request) {
      const admitted = admission(request);
      const value = await principal(request, admitted.sessions);
      admitted.check();
      return admitted.evaluator.capabilities(value);
    },
    /** Decide and bind the disclosure scope without an intervening await. */
    async statusAdmission(request: Request) {
      const admitted = admission(request);
      const principalValue = await principal(request, admitted.sessions);
      admitted.check();
      const capabilities = admitted.evaluator.capabilities(principalValue);
      return capabilities.canRead
        ? {
          scope: "vault" as const,
          capabilities,
          lease: admitted.evaluator.lease(principalValue, "readVault"),
        }
        : {
          scope: "instance" as const,
          capabilities,
          lease: admitted.evaluator.instanceLease(
            principalValue,
            "readInstance",
          ),
        };
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

export type StatusAdmission = Awaited<
  ReturnType<ReturnType<typeof createInstanceAuth>["statusAdmission"]>
>;

export function activeAuth() {
  const identity = state.identity;
  if (!identity) throw new HttpError(503, "Accounts are unavailable.");
  identity.lifetime.assertCurrent();
  return identity.composition.auth;
}

export const noteMutationLease = (req: Request) =>
  activeAuth().noteMutationLease(req);
export const settingsWriteGuard = (req: Request) =>
  activeAuth().settingsWriteGuard(req);
