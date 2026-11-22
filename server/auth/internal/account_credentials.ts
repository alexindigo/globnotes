// SPDX-License-Identifier: LGPL-3.0-only
import type { Account, AccountIdentity } from "../accounts.ts";
import { hashPassword, verifyPassword } from "../../helpers.ts";
import { AuthenticationError } from "../account_credentials.ts";
import {
  createTotpCandidate,
  decodeStoredAuthenticator,
  matchingStoredTotpStep,
  sameStoredTotpSecret,
  serializeStoredTotpSecret,
  type StoredAuthenticator,
  type StoredTotpSecret,
} from "../credentials.ts";
import {
  fields,
  identity,
  IdentityStateError,
  integer,
  record,
} from "../records.ts";
import {
  PublicationRecoveryRequired,
  StoredConfigConflict,
} from "../../config/file_store.ts";
import {
  type EnrollmentRenderer,
  renderAccountTotpEnrollment,
} from "../totp_enrolment.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../../operation_lease.ts";

declare const loginProofBrand: unique symbol;
export interface LoginProof {
  readonly [loginProofBrand]: true;
}
declare const loginClaimBrand: unique symbol;
export interface LoginClaim {
  readonly [loginClaimBrand]: true;
  readonly identity: AccountIdentity;
  readonly lease: OperationLease<"live">;
}
export interface CredentialOptions {
  now?: () => number;
  verify?: typeof verifyPassword;
  hash?: typeof hashPassword;
  renderQr?: EnrollmentRenderer;
}
/** The domain adapter binds its admitted principal in this required P05 lease.
 * This owner captures the target; it does not evaluate HTTP/session authority. */
declare const authorityBrand: unique symbol;
export interface CredentialAuthority {
  readonly [authorityBrand]: true;
}
interface AuthorityBinding {
  readonly owner: object;
  readonly accountId: string;
  readonly credentialRevision: number;
  readonly lease: OperationLease<"live">;
}
const authorities = new WeakMap<CredentialAuthority, AuthorityBinding>();
/** Trusted domain integration, protected by P01 like the repository binding.
 * Principal admission belongs to the caller's P05 lease, not this constructor. */
export function bindCredentialAuthority(
  owner: AccountCredentials,
  account: AccountIdentity,
  lease: OperationLease<"live">,
): CredentialAuthority {
  const binding = Object.freeze({
    owner,
    accountId: account.id,
    credentialRevision: account.credentialRevision,
    lease,
  });
  assertOperationLease(binding.lease, "live");
  if (!identity(binding.accountId) || !integer(binding.credentialRevision)) {
    throw new IdentityStateError();
  }
  const authority = Object.freeze({}) as CredentialAuthority;
  authorities.set(authority, binding);
  return authority;
}
export type AuthenticatorChange =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "remove" }>
  | Readonly<{ kind: "enroll"; key: string; code: string }>;
export interface CredentialChangeRequest {
  readonly credentialRevision: number;
  readonly updateId: string;
  readonly current: Readonly<{ password: string; code?: string }>;
  readonly newPassword?: string;
  readonly authenticator: AuthenticatorChange;
}
declare const transitionBrand: unique symbol;
export interface PreparedCredentialTransition {
  readonly [transitionBrand]: true;
}
/** Private repository integration. The parsed import contract permits only the
 * repository to bind these callbacks; workflows receive the narrow commands. */
interface CredentialStore {
  byLogin(login: string): Account | null;
  byId(id: string): Account | null;
  authenticator(account: Account): StoredAuthenticator;
  identity(account: Account): AccountIdentity;
  assertBound(): void;
  consume(
    account: Account,
    step: number,
    guard: () => undefined,
    lease: OperationLease<"live">,
  ): Account;
  publish(transition: PreparedCredentialTransition): void;
}
interface ProofRecord {
  readonly account: Account;
  readonly operation: ReturnType<typeof createOperationLease<"live">>;
  phase: "prepared" | "claimed" | "finished";
  claimOwner?: ReturnType<typeof createOperationLease<"live">>;
}
interface EnrollmentAttempt {
  readonly accountId: string;
  readonly revision: number;
  readonly secret: StoredTotpSecret;
  key?: string;
  phase: "rendering" | "ready" | "publishing" | "retired";
}
interface TransitionRecord {
  readonly next: Account;
  readonly proof: ProofRecord;
  readonly guard: () => undefined;
  phase: "publishing" | "finished";
}
function captureChange(
  input: CredentialChangeRequest,
): CredentialChangeRequest {
  const value: unknown = structuredClone(input);
  if (
    !record(value) ||
    !fields(value, [
      "credentialRevision",
      "updateId",
      "current",
      "authenticator",
      ...(Object.hasOwn(value, "newPassword") ? ["newPassword"] : []),
    ]) ||
    !integer(value.credentialRevision) || !identity(value.updateId) ||
    (Object.hasOwn(value, "newPassword") &&
      (typeof value.newPassword !== "string" ||
        value.newPassword.length === 0)) ||
    !record(value.current) ||
    !fields(value.current, [
      "password",
      ...(Object.hasOwn(value.current, "code") ? ["code"] : []),
    ]) ||
    typeof value.current.password !== "string" ||
    (value.current.code !== undefined &&
      typeof value.current.code !== "string") ||
    !record(value.authenticator)
  ) throw new IdentityStateError();
  const change = value.authenticator;
  if (change.kind === "enroll") {
    if (
      !fields(change, ["kind", "key", "code"]) ||
      typeof change.key !== "string" || typeof change.code !== "string"
    ) throw new IdentityStateError();
  } else if (
    !["keep", "remove"].includes(change.kind as string) ||
    !fields(change, ["kind"])
  ) throw new IdentityStateError();
  Object.freeze(value.current);
  Object.freeze(change);
  return Object.freeze(value) as unknown as CredentialChangeRequest;
}

/** One aggregate per repository. A stored value is not proof of sign-in, and a
 * proof is not reusable account data. No caller supplies a matched code step. */
export function bindAccountCredentials(
  store: CredentialStore,
  options: CredentialOptions = {},
) {
  const now = options.now ?? Date.now,
    verify = options.verify ?? verifyPassword,
    hash = options.hash ?? hashPassword,
    renderQr = options.renderQr;
  const lifetime = createOperationLease("live", [() => undefined]);
  const proofs = new WeakMap<LoginProof, ProofRecord>();
  const claims = new WeakMap<LoginClaim, ProofRecord>();
  const enrollments = new Map<string, EnrollmentAttempt>();
  const transitions = new WeakMap<
    PreparedCredentialTransition,
    TransitionRecord
  >();
  const assertSnapshot = (account: Account): undefined => {
    const live = store.byId(account.id);
    if (
      !live || live.credentialRevision !== account.credentialRevision ||
      live.passwordHash !== account.passwordHash ||
      live.login !== account.login ||
      live.passwordChangeRequired !== account.passwordChangeRequired ||
      live.lastTotpStep !== account.lastTotpStep
    ) throw new AuthenticationError();
    const before = store.authenticator(account),
      after = store.authenticator(live);
    if (
      before.kind !== after.kind || (before.kind === "totp" &&
        (after.kind !== "totp" ||
          !sameStoredTotpSecret(before.secret, after.secret)))
    ) throw new AuthenticationError();
    store.assertBound();
    return undefined;
  };
  const current = (record: ProofRecord): undefined => {
    try {
      if (record.phase === "finished") throw new AuthenticationError();
      assertSnapshot(record.account);
      assertOperationLease(record.operation.lease, "live");
      return undefined;
    } catch {
      throw new AuthenticationError();
    }
  };
  const close = (record: ProofRecord) => {
    record.phase = "finished";
    record.claimOwner?.retire();
    record.operation.retire();
  };
  // Sign-in and changes share this one verifier. Only the intended command
  // receives the private result; no caller can lend a LoginProof to a change.
  const verifyCurrent = async (
    login: string,
    password: string,
    code?: string,
    signal?: AbortSignal,
    witness: () => undefined = () => undefined,
    expected?: Account,
    parents: readonly OperationLease<"live">[] = [],
  ): Promise<ProofRecord> => {
    if (
      typeof login !== "string" || typeof password !== "string" ||
      (code !== undefined && typeof code !== "string") ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) throw new AuthenticationError();
    let operation: ReturnType<typeof createOperationLease<"live">>;
    try {
      operation = createOperationLease("live", [() => {
        if (signal?.aborted) throw new AuthenticationError();
        return witness();
      }], [lifetime.lease, ...parents]);
    } catch {
      throw new AuthenticationError();
    }
    let admitted = false;
    try {
      assertOperationLease(operation.lease, "live");
      const account = store.byLogin(login);
      if (
        !account || typeof password !== "string" ||
        !await verify(password, account.passwordHash)
      ) throw new AuthenticationError();
      assertOperationLease(operation.lease, "live");
      const live = store.byId(account.id);
      if (
        !live || live.credentialRevision !== account.credentialRevision ||
        live.passwordHash !== account.passwordHash
      ) throw new AuthenticationError();
      if (expected) assertSnapshot(expected);
      const authenticator = store.authenticator(live);
      let verified = live;
      if (authenticator.kind === "totp") {
        const step = matchingStoredTotpStep(
          code ?? "",
          authenticator.secret,
          now(),
        );
        if (step === null) throw new AuthenticationError();
        verified = store.consume(live, step, () => {
          assertSnapshot(live);
          assertOperationLease(operation.lease, "live");
          return undefined;
        }, operation.lease);
      } else if (code !== undefined && code !== "") {
        throw new AuthenticationError();
      }
      assertSnapshot(verified);
      assertOperationLease(operation.lease, "live");
      admitted = true;
      return { account: verified, operation, phase: "prepared" };
    } catch {
      throw new AuthenticationError();
    } finally {
      if (!admitted) operation.retire();
    }
  };
  const bindAuthority = (source: CredentialAuthority, signal?: AbortSignal) => {
    const authority = authorities.get(source);
    if (
      !authority || authority.owner !== credentials ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) throw new IdentityStateError();
    const owner = createOperationLease("live", [() => {
      if (signal?.aborted) throw new AuthenticationError();
      const account = store.byId(authority.accountId);
      if (
        !account || account.credentialRevision !== authority.credentialRevision
      ) throw new StoredConfigConflict();
      store.assertBound();
      return undefined;
    }], [lifetime.lease, authority.lease]);
    const guard = (): undefined => {
      assertOperationLease(owner.lease, "live");
    };
    return { authority, guard, lease: owner.lease };
  };
  // One reducer for both sealed commands and the quarantined fixture adapter.
  const derive = (
    account: Account,
    after: StoredAuthenticator,
    updateId: string,
    passwordHash = account.passwordHash,
    restricted = account.passwordChangeRequired,
  ): Account => {
    const before = store.authenticator(account);
    const same = before.kind === "totp" && after.kind === "totp" &&
      sameStoredTotpSecret(before.secret, after.secret);
    const floor = after.kind === "none"
      ? null
      : same
      ? Math.max(before.lastTotpStep ?? -1, after.lastTotpStep ?? -1)
      : after.lastTotpStep;
    const next = {
      ...account,
      passwordHash,
      passwordChangeRequired: restricted,
      credentialRevision: account.credentialRevision + 1,
      credentialUpdateId: updateId,
      totpKey: after.kind === "none"
        ? null
        : serializeStoredTotpSecret(after.secret).key,
      lastTotpStep: floor === -1 ? null : floor,
    };
    delete next.totpKeyEncoding;
    if (after.kind === "totp") {
      const stored = serializeStoredTotpSecret(after.secret);
      if (Object.hasOwn(stored, "encoding")) {
        next.totpKeyEncoding = stored.encoding;
      }
    }
    return Object.freeze(next);
  };
  const credentials = Object.freeze({
    async authenticate(
      login: string,
      password: string,
      code?: string,
      signal?: AbortSignal,
    ): Promise<LoginProof> {
      const verified = await verifyCurrent(login, password, code, signal);
      const proof = Object.freeze({}) as LoginProof;
      proofs.set(proof, verified);
      return proof;
    },
    async beginEnrollment(source: CredentialAuthority, signal?: AbortSignal) {
      const { authority, guard } = bindAuthority(source, signal);
      const account = store.byId(authority.accountId)!;
      const attempt: EnrollmentAttempt = {
        accountId: account.id,
        revision: account.credentialRevision,
        secret: createTotpCandidate(),
        phase: "rendering",
      };
      const previous = enrollments.get(account.id);
      if (previous) previous.phase = "retired";
      enrollments.set(account.id, attempt);
      try {
        const bundle = await renderAccountTotpEnrollment(
          account.login,
          attempt.secret,
          renderQr,
        );
        guard();
        if (
          enrollments.get(account.id) !== attempt ||
          attempt.phase !== "rendering"
        ) throw new StoredConfigConflict();
        attempt.key = bundle.key;
        attempt.phase = "ready";
        guard();
        return bundle;
      } catch (error) {
        attempt.phase = "retired";
        if (enrollments.get(account.id) === attempt) {
          enrollments.delete(account.id);
        }
        throw error;
      }
    },
    async changeOwn(
      source: CredentialAuthority,
      input: CredentialChangeRequest,
      signal?: AbortSignal,
    ): Promise<AccountIdentity> {
      const request = captureChange(input);
      const { authority, guard, lease } = bindAuthority(source, signal);
      if (request.credentialRevision !== authority.credentialRevision) {
        throw new StoredConfigConflict();
      }
      const initial = store.byId(authority.accountId)!;
      // A forced change must end the temporary password, not re-issue it to
      // whoever handed it out. Checked before any current code is spent.
      if (
        initial.passwordChangeRequired &&
        (request.newPassword === undefined ||
          await verify(request.newPassword, initial.passwordHash))
      ) throw new IdentityStateError();
      let attempt: EnrollmentAttempt | undefined;
      let confirmed: StoredAuthenticator | undefined;
      if (request.authenticator.kind === "enroll") {
        attempt = enrollments.get(initial.id);
        if (
          !attempt || attempt.accountId !== initial.id ||
          attempt.revision !== initial.credentialRevision ||
          attempt.phase !== "ready" ||
          attempt.key !== request.authenticator.key
        ) throw new IdentityStateError();
        const step = matchingStoredTotpStep(
          request.authenticator.code,
          attempt.secret,
          now(),
        );
        if (step === null) throw new IdentityStateError();
        const old = store.authenticator(initial);
        if (
          old.kind === "totp" &&
          sameStoredTotpSecret(old.secret, attempt.secret) &&
          old.lastTotpStep !== null && step <= old.lastTotpStep
        ) throw new IdentityStateError();
        confirmed = Object.freeze({
          kind: "totp",
          secret: attempt.secret,
          lastTotpStep: step,
        });
      }
      const candidateGuard = (): undefined => {
        guard();
        if (
          attempt &&
          (enrollments.get(initial.id) !== attempt ||
            !["ready", "publishing"].includes(attempt.phase))
        ) throw new StoredConfigConflict();
        return undefined;
      };
      const proof = await verifyCurrent(
        initial.login,
        request.current.password,
        request.current.code,
        signal,
        candidateGuard,
        initial,
        [lease],
      );
      proof.phase = "claimed";
      let token: PreparedCredentialTransition | undefined;
      let committed = false;
      try {
        const passwordHash = request.newPassword === undefined
          ? proof.account.passwordHash
          : await hash(request.newPassword);
        current(proof);
        candidateGuard();
        const after = request.authenticator.kind === "remove"
          ? Object.freeze({ kind: "none" as const })
          : confirmed ?? store.authenticator(proof.account);
        const next = derive(
          proof.account,
          after,
          request.updateId,
          passwordHash,
          request.newPassword === undefined
            ? proof.account.passwordChangeRequired
            : false,
        );
        const result = store.identity(next);
        token = Object.freeze({}) as PreparedCredentialTransition;
        transitions.set(token, {
          next,
          proof,
          guard: candidateGuard,
          phase: "publishing",
        });
        if (attempt) attempt.phase = "publishing";
        store.publish(token);
        committed = true;
        return result;
      } catch (error) {
        if (error instanceof PublicationRecoveryRequired) committed = true;
        throw error;
      } finally {
        if (token) transitions.get(token)!.phase = "finished";
        if (attempt && attempt.phase === "publishing") {
          attempt.phase = committed ? "retired" : "ready";
          if (committed && enrollments.get(initial.id) === attempt) {
            enrollments.delete(initial.id);
          }
        }
        if (committed) {
          const pending = enrollments.get(initial.id);
          if (pending?.revision === initial.credentialRevision) {
            pending.phase = "retired";
            enrollments.delete(initial.id);
          }
        }
        close(proof);
      }
    },
    beginLogin(proof: LoginProof): LoginClaim {
      const record = proofs.get(proof);
      if (!record || record.phase !== "prepared") {
        throw new AuthenticationError();
      }
      record.phase = "claimed";
      try {
        current(record);
        const identity = store.identity(record.account);
        const claimOwner = createOperationLease("live", [() => {
          if (record.phase !== "claimed") throw new AuthenticationError();
          assertSnapshot(record.account);
        }], [record.operation.lease]);
        record.claimOwner = claimOwner;
        const claim = Object.freeze({
          identity,
          lease: claimOwner.lease,
        }) as LoginClaim;
        claims.set(claim, record);
        return claim;
      } catch (error) {
        close(record);
        throw error;
      }
    },
    finishLogin(claim: LoginClaim): AccountIdentity {
      const record = claims.get(claim);
      if (!record || record.phase !== "claimed") {
        throw new AuthenticationError();
      }
      current(record);
      close(record);
      return claim.identity;
    },
    closeLogin(claim: LoginClaim): void {
      const record = claims.get(claim);
      if (!record) throw new AuthenticationError();
      close(record);
    },
  });
  return Object.freeze({
    credentials,
    // Only the repository's private binding may resolve sealed write inputs.
    resolveTransition(token: PreparedCredentialTransition) {
      const transition = transitions.get(token);
      if (!transition || transition.phase !== "publishing") {
        throw new IdentityStateError();
      }
      current(transition.proof);
      transition.guard();
      // Domain witnesses can synchronously reenter the account owner.
      current(transition.proof);
      return Object.freeze({
        account: transition.next,
        lease: transition.proof.operation.lease,
      });
    },
    legacyChange(
      account: Account,
      changes: Partial<
        Pick<
          Account,
          | "passwordHash"
          | "passwordChangeRequired"
          | "totpKey"
          | "totpKeyEncoding"
        >
      >,
      updateId: string,
    ): Account {
      const candidate = { ...account, ...changes };
      // Supplied keys and encoding are one replacement value. Omitted encoding
      // means historical UTF-8, never metadata inherited from the old key.
      const after = Object.hasOwn(changes, "totpKey")
        ? decodeStoredAuthenticator(
          changes.totpKey,
          changes.totpKeyEncoding,
          null,
        )
        : store.authenticator(account);
      return Object.freeze({
        ...derive(account, after, updateId),
        passwordHash: candidate.passwordHash,
        passwordChangeRequired: candidate.passwordChangeRequired,
      });
    },
    retire(): boolean {
      const retired = lifetime.retire();
      for (const attempt of enrollments.values()) attempt.phase = "retired";
      enrollments.clear();
      return retired;
    },
  });
}
export type AccountCredentials = ReturnType<
  typeof bindAccountCredentials
>["credentials"];
