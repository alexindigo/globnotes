// SPDX-License-Identifier: LGPL-3.0-only
import type { AccountIdentity } from "../accounts.ts";
import type {
  Account,
  AccountSnapshot,
  ProvisioningReceipt,
} from "./account_record.ts";
import type { PublicationParticipant } from "../../config/owned_publication.ts";
import { assertPublicationAuthority } from "../../internal/publication_validation.ts";
import {
  accountAclParticipant,
  assertSettledInitialAccountPair,
  registerInitialAccountParticipant,
  registerRecipientAccountParticipant,
} from "./account_participation.ts";
import { reduceAccountCredentials } from "./credential_reducer.ts";
import { hashPassword, verifyPassword } from "../../helpers.ts";
import { AuthenticationError } from "../account_credentials.ts";
import { createUuid } from "../../../shared/uuid.ts";
import {
  assertOfflineRecovery,
  type OfflineRecoveryAuthority,
} from "../offline_recovery.ts";
import {
  createTotpCandidate,
  matchingStoredTotpStep,
  sameStoredTotpSecret,
  serializeStoredTotpSecret,
  type StoredAuthenticator,
  type StoredTotpSecret,
} from "../credentials.ts";
import {
  CredentialInputError,
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
declare const initialProofBrand: unique symbol;
export interface InitialAccountProof {
  readonly [initialProofBrand]: true;
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
declare const preparationAuthorityBrand: unique symbol;
export interface AccountPreparationAuthority {
  readonly [preparationAuthorityBrand]: true;
}
type DomainPreparationPurpose = "initial" | "recipient";
type PreparationPurpose = DomainPreparationPurpose | "offline";
const preparationAuthorities = new WeakMap<
  AccountPreparationAuthority,
  {
    owner: object;
    purpose: DomainPreparationPurpose;
    lease: OperationLease<"live">;
    completion?: OperationLease<"live">;
  }
>();
/** Trusted bootstrap/Admin admission adapter, not a consumer-supplied flag. */
export function bindAccountPreparationAuthority(
  owner: AccountCredentials,
  purpose: DomainPreparationPurpose,
  lease: OperationLease<"live">,
  completion?: OperationLease<"live">,
): AccountPreparationAuthority {
  if (!["initial", "recipient"].includes(purpose)) {
    throw new IdentityStateError();
  }
  assertOperationLease(lease, "live");
  if (completion !== undefined) {
    if (purpose !== "initial") throw new IdentityStateError();
    assertOperationLease(completion, "live");
  }
  const authority = Object.freeze({}) as AccountPreparationAuthority;
  preparationAuthorities.set(
    authority,
    Object.freeze({ owner, purpose, lease, completion }),
  );
  return authority;
}
declare const preparedAccountBrand: unique symbol;
export interface PreparedAccount {
  readonly [preparedAccountBrand]: true;
}
export type AccountPreparationRequest = {
  readonly login: string;
  readonly password: string;
  readonly updateId: string;
};
// Unlike an optional `never` property, the password-only arm excludes a
// present `authenticator: undefined` without exactOptionalPropertyTypes.
export type InitialAccountPreparationRequest =
  & AccountPreparationRequest
  & (
    | { readonly [field: `authenticator${string}`]: never }
    | { readonly authenticator: Readonly<{ key: string; code: string }> }
  );
export interface OfflineAccountRequest {
  readonly accountId: string;
  readonly credentialRevision: number;
  readonly updateId: string;
}
export interface AccountParticipantReceipt {
  readonly acl: PublicationParticipant;
  readonly operationId: string;
  readonly actorId: string;
  readonly payloadHash: string;
}
export interface OfflinePasswordRequest extends OfflineAccountRequest {
  readonly password: string;
}
interface PreparedAccountRecord {
  readonly account: Account;
  readonly snapshot: AccountSnapshot;
  readonly updateId: string;
  readonly guard: () => undefined;
  readonly operation: ReturnType<typeof createOperationLease<"live">>;
  readonly purpose: PreparationPurpose | "import";
  readonly validation: { transferred: boolean };
  readonly completion?: OperationLease<"live">;
  readonly signal?: AbortSignal;
  receipt?: ProvisioningReceipt;
  enrollment?: InitialEnrollmentAttempt;
  phase: "prepared" | "publishing" | "participating" | "claiming" | "finished";
}
/** Private repository integration. The parsed import contract permits only the
 * repository to bind these callbacks; workflows receive the narrow commands. */
interface CredentialStore {
  readonly root: string;
  capture(): AccountSnapshot;
  assertSnapshot(snapshot: AccountSnapshot): void;
  normalizeLogin(login: string): string;
  validateAccount(account: unknown): Account;
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
  create(prepared: PreparedAccount, configured?: true): void;
  participant(prepared: PreparedAccount, setId: string): PublicationParticipant;
}
interface ProofRecord {
  readonly account: Account;
  readonly operation: ReturnType<typeof createOperationLease<"live">>;
  phase: "prepared" | "claimed" | "finished";
  claimOwner?: ReturnType<typeof createOperationLease<"live">>;
}
/** Only this verifier can produce the sign-in step. Thrown errors, including
 * AuthenticationError values supplied by adapters, are always generic. */
type VerificationResult = {
  readonly kind: "verified" | "authenticator_required";
  readonly record: ProofRecord;
};
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
interface InitialEnrollmentAttempt {
  readonly source: AccountPreparationAuthority;
  readonly login: string;
  readonly secret: StoredTotpSecret;
  readonly operation: ReturnType<typeof createOperationLease<"live">>;
  key?: string;
  phase: "rendering" | "ready" | "retired";
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
  const initialProofs = new WeakMap<InitialAccountProof, ProofRecord>();
  const accountParticipants = new WeakMap<
    PublicationParticipant,
    PreparedAccountRecord
  >();
  const claims = new WeakMap<LoginClaim, ProofRecord>();
  const enrollments = new Map<string, EnrollmentAttempt>();
  let initialEnrollment: InitialEnrollmentAttempt | undefined;
  const retireInitialEnrollment = (attempt: InitialEnrollmentAttempt) => {
    attempt.phase = "retired";
    attempt.operation.retire();
    if (initialEnrollment === attempt) initialEnrollment = undefined;
  };
  const transitions = new WeakMap<
    PreparedCredentialTransition,
    TransitionRecord
  >();
  const preparedAccounts = new WeakMap<
    PreparedAccount,
    PreparedAccountRecord
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
  ): Promise<VerificationResult> => {
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
      assertSnapshot(account);
      // Keep the exact password-checked snapshot, not a replacement with the
      // same password/revision but different authenticator or replay state.
      const live = account;
      if (expected) assertSnapshot(expected);
      const authenticator = store.authenticator(live);
      let verified = live;
      if (authenticator.kind === "totp") {
        if (code === undefined || code === "") {
          assertSnapshot(live);
          assertOperationLease(operation.lease, "live");
          admitted = true;
          return {
            kind: "authenticator_required",
            record: { account: live, operation, phase: "prepared" },
          };
        }
        const step = matchingStoredTotpStep(
          code,
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
      return {
        kind: "verified",
        record: { account: verified, operation, phase: "prepared" },
      };
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
  // Pure private arithmetic; authority and publication stay in this aggregate.
  const derive = (
    account: Account,
    after: StoredAuthenticator,
    updateId: string,
    passwordHash = account.passwordHash,
    restricted = account.passwordChangeRequired,
  ): Account => {
    return reduceAccountCredentials(
      account,
      store.authenticator(account),
      after,
      updateId,
      passwordHash,
      restricted,
    );
  };
  const prepareAccount = async (
    purpose: PreparationPurpose,
    source: AccountPreparationAuthority | OfflineRecoveryAuthority,
    input: AccountPreparationRequest,
    signal?: AbortSignal,
  ) => {
    const request: unknown = structuredClone(input);
    if (
      !record(request) ||
      !fields(request, [
        "login",
        "password",
        "updateId",
        ...(purpose === "initial" && Object.hasOwn(request, "authenticator")
          ? ["authenticator"]
          : []),
      ]) ||
      typeof request.login !== "string" ||
      typeof request.password !== "string" || !request.password ||
      !identity(request.updateId) ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) throw new IdentityStateError();
    const admitted = purpose === "offline"
      ? {
        owner: credentials,
        purpose,
        lease: assertOfflineRecovery(
          source as OfflineRecoveryAuthority,
          store.root,
        ),
        completion: undefined,
      }
      : preparationAuthorities.get(source as AccountPreparationAuthority);
    if (
      !admitted || admitted.owner !== credentials ||
      admitted.purpose !== purpose
    ) throw new IdentityStateError();
    const snapshot = store.capture();
    const validation = { transferred: false };
    let enrollment: InitialEnrollmentAttempt | undefined;
    const enrollmentGuard = () => {
      if (!enrollment) return;
      if (
        initialEnrollment !== enrollment || enrollment.phase !== "ready" ||
        enrollment.source !== source
      ) {
        throw new StoredConfigConflict();
      }
      assertOperationLease(enrollment.operation.lease, "live");
    };
    const operation = createOperationLease("live", [() => {
      if (signal?.aborted) throw new AuthenticationError();
      // Once transferred, the native candidate owns exact snapshot/CAS checks.
      // Public repository reads are intentionally fenced during set assembly.
      if (!validation.transferred) store.assertSnapshot(snapshot);
      enrollmentGuard();
      if (
        purpose === "initial"
          ? snapshot.value.initialized || snapshot.value.accounts.length !== 0
          : purpose === "recipient"
          ? !snapshot.value.initialized
          : !snapshot.value.initialized && snapshot.persistence.raw !== null
      ) throw new StoredConfigConflict();
      return undefined;
    }], [lifetime.lease, admitted.lease]);
    const guard = (): undefined => {
      assertOperationLease(operation.lease, "live");
    };
    // The handle owns this lease only once it is returned; every earlier
    // failure retires it here, like verifyCurrent's unadmitted operation.
    let issued = false;
    try {
      guard();
      const login = store.normalizeLogin(request.login);
      if (snapshot.value.accounts.some((account) => account.login === login)) {
        throw new StoredConfigConflict();
      }
      let confirmed:
        | { key: string; encoding?: "base32" | null; step: number }
        | undefined;
      if (Object.hasOwn(request, "authenticator")) {
        const input = request.authenticator;
        if (
          !record(input) || !fields(input, ["key", "code"]) ||
          typeof input.key !== "string" || typeof input.code !== "string"
        ) throw new IdentityStateError();
        const attempt = initialEnrollment;
        if (
          !attempt || attempt.source !== source || attempt.login !== login ||
          attempt.phase !== "ready" || attempt.key !== input.key
        ) throw new IdentityStateError();
        enrollment = attempt;
        enrollmentGuard();
        const step = matchingStoredTotpStep(input.code, attempt.secret, now());
        enrollmentGuard();
        if (step === null) throw new IdentityStateError();
        confirmed = { ...serializeStoredTotpSecret(attempt.secret), step };
      }
      const id = createUuid();
      const passwordHash = await hash(request.password);
      guard();
      const account: Account = Object.freeze(
        store.validateAccount({
          id,
          login,
          passwordHash,
          totpKey: confirmed?.key ?? null,
          ...(confirmed ? { totpKeyEncoding: confirmed.encoding } : {}),
          lastTotpStep: confirmed?.step ?? null,
          credentialRevision: 0,
          passwordChangeRequired: purpose !== "initial",
          credentialUpdateId: null,
        }),
      );
      const prepared = Object.freeze({}) as PreparedAccount;
      const result = Object.freeze({
        prepared,
        identity: store.identity(account),
      });
      preparedAccounts.set(prepared, {
        account,
        snapshot,
        updateId: request.updateId,
        guard,
        operation,
        purpose,
        validation,
        completion: admitted.completion,
        signal,
        enrollment,
        phase: "prepared",
      });
      guard();
      issued = true;
      return result;
    } finally {
      if (!issued) operation.retire();
    }
  };
  const recoveryGuard = (
    authority: OfflineRecoveryAuthority,
    signal?: AbortSignal,
    snapshot?: AccountSnapshot,
  ) => {
    const recovery = assertOfflineRecovery(authority, store.root);
    const operation = createOperationLease("live", [() => {
      if (signal?.aborted) throw new AuthenticationError();
      store.assertBound();
      if (snapshot) store.assertSnapshot(snapshot);
    }], [lifetime.lease, recovery]);
    const guard = (): undefined => {
      assertOperationLease(operation.lease, "live");
    };
    return { guard, operation };
  };
  const recoverAccount = async (
    kind: "reset" | "disable",
    authority: OfflineRecoveryAuthority,
    input: OfflineAccountRequest | OfflinePasswordRequest,
    signal?: AbortSignal,
  ): Promise<AccountIdentity> => {
    const request: unknown = structuredClone(input);
    if (
      !record(request) ||
      !fields(request, [
        "accountId",
        "credentialRevision",
        "updateId",
        ...(kind === "reset" ? ["password"] : []),
      ]) || !identity(request.accountId) ||
      !integer(request.credentialRevision) || !identity(request.updateId) ||
      (kind === "reset" &&
        (typeof request.password !== "string" || !request.password)) ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) throw new IdentityStateError();
    const { guard, operation } = recoveryGuard(authority, signal);
    // The operation is owned from creation: a stale request retires it too.
    let proof: ProofRecord | undefined;
    let token: PreparedCredentialTransition | undefined;
    try {
      guard();
      const account = store.byId(request.accountId);
      if (
        !account || account.credentialRevision !== request.credentialRevision
      ) throw new StoredConfigConflict();
      proof = { account, operation, phase: "claimed" };
      const passwordHash = kind === "reset"
        ? await hash(request.password as string)
        : account.passwordHash;
      current(proof);
      const next = derive(
        account,
        kind === "disable"
          ? Object.freeze({ kind: "none" })
          : store.authenticator(account),
        request.updateId,
        passwordHash,
        kind === "reset" ? true : account.passwordChangeRequired,
      );
      const result = store.identity(next);
      token = Object.freeze({}) as PreparedCredentialTransition;
      transitions.set(token, { next, proof, guard, phase: "publishing" });
      store.publish(token);
      return result;
    } finally {
      if (token) transitions.get(token)!.phase = "finished";
      if (proof) close(proof);
      else operation.retire();
    }
  };
  const credentials = Object.freeze({
    async beginInitialEnrollment(
      source: AccountPreparationAuthority,
      inputLogin: string,
      signal?: AbortSignal,
    ) {
      const admitted = preparationAuthorities.get(source);
      if (
        !admitted || admitted.owner !== credentials ||
        admitted.purpose !== "initial" ||
        typeof inputLogin !== "string" ||
        (signal !== undefined && !(signal instanceof AbortSignal))
      ) throw new IdentityStateError();
      const login = store.normalizeLogin(inputLogin);
      const snapshot = store.capture();
      if (snapshot.value.initialized || snapshot.value.accounts.length !== 0) {
        throw new StoredConfigConflict();
      }
      const operation = createOperationLease("live", [() => undefined], [
        lifetime.lease,
        admitted.lease,
      ]);
      // Rendering is request work; the successfully issued candidate is
      // setup work, consumed by a *different* request. HTTP completion retires
      // the former, not the latter.
      const rendering = createOperationLease("live", [() => {
        if (signal?.aborted) throw new AuthenticationError();
        return undefined;
      }], [operation.lease]);
      let attempt: InitialEnrollmentAttempt | undefined;
      try {
        rendering.lease.assertCurrent();
        store.assertSnapshot(snapshot);
        const secret = createTotpCandidate();
        if (initialEnrollment) retireInitialEnrollment(initialEnrollment);
        attempt = { source, login, secret, operation, phase: "rendering" };
        initialEnrollment = attempt;
        const bundle = await renderAccountTotpEnrollment(
          login,
          secret,
          renderQr,
        );
        assertOperationLease(rendering.lease, "live");
        store.assertSnapshot(snapshot);
        if (initialEnrollment !== attempt || attempt.phase !== "rendering") {
          throw new StoredConfigConflict();
        }
        attempt.key = bundle.key;
        attempt.phase = "ready";
        assertOperationLease(rendering.lease, "live");
        return bundle;
      } catch (error) {
        if (attempt) retireInitialEnrollment(attempt);
        else operation.retire();
        throw error;
      } finally {
        rendering.retire();
      }
    },
    /** Privileged append-only historical import, never ordinary account creation. */
    importAccount(
      authority: OfflineRecoveryAuthority,
      input: unknown,
    ): AccountIdentity {
      const snapshot = store.capture();
      const { guard, operation } = recoveryGuard(
        authority,
        undefined,
        snapshot,
      );
      // Publication takes custody of the operation with the handle; any
      // earlier rejection retires it here.
      const prepared = Object.freeze({}) as PreparedAccount;
      let issued = false;
      try {
        guard();
        const account = Object.freeze(
          store.validateAccount(structuredClone(input)),
        );
        if (
          snapshot.value.accounts.some((a) =>
            a.id === account.id || a.login === account.login
          )
        ) throw new StoredConfigConflict();
        guard();
        preparedAccounts.set(prepared, {
          account,
          snapshot,
          updateId: createUuid(),
          guard,
          operation,
          purpose: "import",
          validation: { transferred: false },
          phase: "prepared",
        });
        issued = true;
      } finally {
        if (!issued) operation.retire();
      }
      return credentials.publishPreparedAccount(prepared);
    },
    prepareInitialAccount(
      authority: AccountPreparationAuthority,
      request: InitialAccountPreparationRequest,
      signal?: AbortSignal,
    ) {
      return prepareAccount("initial", authority, request, signal);
    },
    preparePasswordOnlyRecipient(
      authority: AccountPreparationAuthority,
      request: AccountPreparationRequest,
      signal?: AbortSignal,
    ) {
      return prepareAccount("recipient", authority, request, signal);
    },
    /** Explicit offline creation is its own purpose, never web initial admission
     * or Admin recipient authority. The CLI still classifies signing/legacy state
     * and initializes signing first before publishing this prepared account. */
    prepareOfflineAccount(
      authority: OfflineRecoveryAuthority,
      request: AccountPreparationRequest,
      signal?: AbortSignal,
    ) {
      return prepareAccount("offline", authority, request, signal);
    },
    publishPreparedAccount(
      prepared: PreparedAccount,
      configured?: true,
    ): AccountIdentity {
      const value = preparedAccounts.get(prepared);
      // Confirmed setup credentials are published with the creator ACL, never
      // through the pre-existing credential-only path.
      if (
        !value || value.phase !== "prepared" || value.enrollment ||
        configured && value.purpose !== "initial"
      ) {
        throw new IdentityStateError();
      }
      value.phase = "publishing";
      try {
        value.guard();
        const result = store.identity(value.account);
        store.create(prepared, configured);
        return result;
      } finally {
        value.phase = "finished";
        value.operation.retire();
      }
    },
    prepareAccountParticipant(
      prepared: PreparedAccount,
      setId: string,
      receipt?: AccountParticipantReceipt,
    ): PublicationParticipant {
      const value = preparedAccounts.get(prepared);
      if (!value || value.phase !== "prepared" || !identity(setId)) {
        throw new IdentityStateError();
      }
      if (value.purpose === "offline") throw new IdentityStateError();
      value.phase = "publishing";
      let issued = false;
      try {
        assertPublicationAuthority(value.operation.lease, store.root, setId);
        if (
          value.purpose === "import" ||
          (value.purpose === "recipient" && receipt === undefined)
        ) {
          throw new IdentityStateError();
        }
        let peer: PublicationParticipant | undefined;
        if (receipt !== undefined) {
          if (
            !record(receipt) ||
            !fields(receipt, [
              "acl",
              "operationId",
              "actorId",
              "payloadHash",
            ])
          ) throw new IdentityStateError();
          const { acl, operationId, actorId, payloadHash } = receipt;
          if (
            value.purpose !== "recipient" || !identity(operationId) ||
            !identity(actorId) ||
            typeof payloadHash !== "string" ||
            !/^[0-9a-f]{64}$/.test(payloadHash) ||
            !value.snapshot.value.accounts.find((account) =>
              account.id === actorId
            ) ||
            value.snapshot.value.provisioning.find((r) =>
              r.operationId === operationId
            )
          ) throw new IdentityStateError();
          const grant = accountAclParticipant(
            acl,
            credentials,
            value.account.id,
          );
          if (grant.kind !== "grant" || grant.actorId !== actorId) {
            throw new IdentityStateError();
          }
          value.receipt = Object.freeze({
            operationId,
            actorId,
            payloadHash,
            accountId: value.account.id,
            vaultId: grant.vaultId,
            level: grant.level,
            aclUpdateId: grant.updateId,
            committed: true,
          });
          peer = acl;
        }
        assertPublicationAuthority(value.operation.lease, store.root, setId);
        value.validation.transferred = true;
        const participant = store.participant(prepared, setId);
        if (peer) registerRecipientAccountParticipant(participant, peer);
        else {
          registerInitialAccountParticipant(participant, {
            credentials,
            accountId: value.account.id,
          });
        }
        value.phase = "participating";
        accountParticipants.set(participant, value);
        issued = true;
        return participant;
      } finally {
        if (!issued) {
          value.phase = "finished";
          value.operation.retire();
        }
      }
    },
    resetPassword(
      authority: OfflineRecoveryAuthority,
      request: OfflinePasswordRequest,
      signal?: AbortSignal,
    ) {
      return recoverAccount("reset", authority, request, signal);
    },
    disableAuthenticator(
      authority: OfflineRecoveryAuthority,
      request: OfflineAccountRequest,
      signal?: AbortSignal,
    ) {
      return recoverAccount("disable", authority, request, signal);
    },
    async authenticate(
      login: string,
      password: string,
      code?: string,
      signal?: AbortSignal,
    ): Promise<LoginProof> {
      const verified = await verifyCurrent(login, password, code, signal);
      if (verified.kind === "authenticator_required") {
        try {
          // Recheck after the verifier's async return; issue no LoginProof and
          // retire the private operation even when this final check rejects.
          current(verified.record);
          throw new AuthenticationError("authenticator_required");
        } finally {
          close(verified.record);
        }
      }
      const proof = Object.freeze({}) as LoginProof;
      proofs.set(proof, verified.record);
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
      ) throw new CredentialInputError();
      let attempt: EnrollmentAttempt | undefined;
      let confirmed: StoredAuthenticator | undefined;
      if (request.authenticator.kind === "enroll") {
        attempt = enrollments.get(initial.id);
        if (
          !attempt || attempt.accountId !== initial.id ||
          attempt.revision !== initial.credentialRevision ||
          attempt.phase !== "ready" ||
          attempt.key !== request.authenticator.key
        ) throw new CredentialInputError();
        const step = matchingStoredTotpStep(
          request.authenticator.code,
          attempt.secret,
          now(),
        );
        if (step === null) throw new CredentialInputError();
        const old = store.authenticator(initial);
        if (
          old.kind === "totp" &&
          sameStoredTotpSecret(old.secret, attempt.secret) &&
          old.lastTotpStep !== null && step <= old.lastTotpStep
        ) throw new CredentialInputError();
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
      const verified = await verifyCurrent(
        initial.login,
        request.current.password,
        request.current.code,
        signal,
        candidateGuard,
        initial,
        [lease],
      );
      if (verified.kind !== "verified") {
        close(verified.record);
        throw new AuthenticationError();
      }
      const proof = verified.record;
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
    initialAccountProof(
      participant: PublicationParticipant,
      acl: PublicationParticipant,
    ): InitialAccountProof {
      const value = accountParticipants.get(participant);
      if (
        !value || value.purpose !== "initial" ||
        value.phase !== "participating" || !value.completion
      ) {
        throw new AuthenticationError();
      }
      const assertPair = (): undefined => {
        if (value.signal?.aborted) throw new AuthenticationError();
        assertSettledInitialAccountPair(
          participant,
          acl,
          credentials,
          value.account.id,
        );
        assertSnapshot(value.account);
        return undefined;
      };
      let operation:
        | ReturnType<typeof createOperationLease<"live">>
        | undefined;
      value.phase = "claiming";
      try {
        // Admission freshness ended at decision. The separately captured owner
        // remains the parent of this completion, not permission for another write.
        operation = createOperationLease("live", [assertPair], [
          lifetime.lease,
          value.completion,
        ]);
        const proof = Object.freeze({}) as InitialAccountProof;
        initialProofs.set(proof, {
          account: value.account,
          operation,
          phase: "prepared",
        });
        value.phase = "finished";
        value.operation.retire();
        if (value.enrollment) retireInitialEnrollment(value.enrollment);
        return proof;
      } catch {
        operation?.retire();
        value.phase = "participating";
        throw new AuthenticationError();
      }
    },
    beginLogin(proof: LoginProof | InitialAccountProof): LoginClaim {
      // Separate maps are the purpose checks. Neither stored records nor a
      // caller-selected tag can change one proof kind into another.
      const record = proofs.get(proof as LoginProof) ??
        initialProofs.get(proof as InitialAccountProof);
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
    resolvePreparedAccount(prepared: PreparedAccount, setId?: string) {
      const value = preparedAccounts.get(prepared);
      if (!value || value.phase !== "publishing") {
        throw new IdentityStateError();
      }
      if (setId !== undefined) {
        assertPublicationAuthority(value.operation.lease, store.root, setId);
      } else value.guard();
      return Object.freeze({
        account: value.account,
        snapshot: value.snapshot,
        updateId: value.updateId,
        lease: value.operation.lease,
        receipt: value.receipt,
      });
    },
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
    retire(): boolean {
      const retired = lifetime.retire();
      if (initialEnrollment) retireInitialEnrollment(initialEnrollment);
      for (const attempt of enrollments.values()) attempt.phase = "retired";
      enrollments.clear();
      return retired;
    },
  });
}
export type AccountCredentials = ReturnType<
  typeof bindAccountCredentials
>["credentials"];
