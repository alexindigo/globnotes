// SPDX-License-Identifier: LGPL-3.0-only
import type { Account, AccountIdentity } from "../accounts.ts";
import { verifyPassword } from "../../helpers.ts";
import { AuthenticationError } from "../account_credentials.ts";
import {
  matchingStoredTotpStep,
  sameStoredTotpSecret,
  type StoredAuthenticator,
} from "../credentials.ts";
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
}
interface ProofRecord {
  readonly account: Account;
  readonly operation: ReturnType<typeof createOperationLease<"live">>;
  phase: "prepared" | "claimed" | "finished";
  claimOwner?: ReturnType<typeof createOperationLease<"live">>;
}

/** One aggregate per repository. A stored value is not proof of sign-in, and a
 * proof is not reusable account data. No caller supplies a matched code step. */
export function bindAccountCredentials(
  store: CredentialStore,
  options: CredentialOptions = {},
) {
  const now = options.now ?? Date.now,
    verify = options.verify ?? verifyPassword;
  const lifetime = createOperationLease("live", [() => undefined]);
  const proofs = new WeakMap<LoginProof, ProofRecord>();
  const claims = new WeakMap<LoginClaim, ProofRecord>();
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
  return Object.freeze({
    credentials: Object.freeze({
      async authenticate(
        login: string,
        password: string,
        code?: string,
        signal?: AbortSignal,
      ): Promise<LoginProof> {
        if (
          typeof login !== "string" || typeof password !== "string" ||
          (code !== undefined && typeof code !== "string") ||
          (signal !== undefined && !(signal instanceof AbortSignal))
        ) throw new AuthenticationError();
        let operation: ReturnType<typeof createOperationLease<"live">>;
        try {
          operation = createOperationLease("live", [() => {
            if (signal?.aborted) throw new AuthenticationError();
            return undefined;
          }], [lifetime.lease]);
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
          // Password verification may await. Re-read the owner's current record
          // before matching/consuming a code, without an await between them.
          const live = store.byId(account.id);
          if (
            !live || live.credentialRevision !== account.credentialRevision ||
            live.passwordHash !== account.passwordHash
          ) throw new AuthenticationError();
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
          const proof = Object.freeze({}) as LoginProof;
          proofs.set(proof, {
            account: verified,
            operation,
            phase: "prepared",
          });
          admitted = true;
          return proof;
        } catch {
          throw new AuthenticationError();
        } finally {
          if (!admitted) operation.retire();
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
    }),
    retire: lifetime.retire,
  });
}
export type AccountCredentials = ReturnType<
  typeof bindAccountCredentials
>["credentials"];
