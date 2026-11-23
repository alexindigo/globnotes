// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { jwtVerify, SignJWT } from "jose";
import { AccountRepository } from "./accounts.ts";
import type { AuthorityReadContext } from "./authority_context.ts";
import {
  assertAuthorityContext,
  withAuthorityContext,
} from "./internal/authority_context.ts";
import {
  authorityRead,
  registerAuthorityReader,
} from "./internal/authority_read.ts";
import {
  type AccountCredentials,
  AuthenticationError,
  type InitialAccountProof,
  type LoginProof,
} from "./account_credentials.ts";
export { AuthenticationError };
import { bindGuardedSink } from "../internal/guarded_sink.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import {
  fields,
  identity,
  IdentityFile,
  IdentityStateError,
  integer,
  record,
} from "./records.ts";
import type { SessionSettings } from "../config/consumers.ts";

interface SessionState {
  readonly version: 1;
  readonly revision: number;
  readonly signingRevision: number;
  readonly signingKey: string | null;
  readonly configuredSeedId?: string;
}
function validate(value: unknown): SessionState {
  if (
    !record(value) ||
    !fields(value, [
      "version",
      "revision",
      "signingRevision",
      "signingKey",
      ...(Object.hasOwn(value, "configuredSeedId") ? ["configuredSeedId"] : []),
    ]) ||
    value.version !== 1 || !integer(value.revision) ||
    !integer(value.signingRevision) ||
    (Object.hasOwn(value, "configuredSeedId") &&
      (!identity(value.configuredSeedId) || value.revision !== 1 ||
        value.signingRevision !== 1 || value.signingKey === null)) ||
    !(value.signingKey === null ||
      (typeof value.signingKey === "string" &&
        /^[0-9a-f]{64}$/.test(value.signingKey)))
  ) throw new IdentityStateError();
  return value as unknown as SessionState;
}
export interface AccountPrincipal {
  readonly kind: "account";
  readonly accountId: string;
  readonly credentialRevision: number;
  readonly signingRevision: number;
  readonly expiresAt: number;
  readonly passwordChangeRequired: boolean;
}
export interface GuestPrincipal {
  readonly kind: "guest";
}
/** Signed bytes stay private until this guarded response body is consumed. */
export interface IssuedSession {
  readonly principal: AccountPrincipal;
  readonly body: ReadableStream<Uint8Array>;
}
export type Principal = AccountPrincipal | GuestPrincipal;
export const GUEST: GuestPrincipal = Object.freeze({ kind: "guest" });

/** Instance signing state is created explicitly during account bootstrap/import,
 * never as a side effect of a missing-key read on a configured instance. */
export class SessionRepository {
  readonly #file: IdentityFile<SessionState>;
  constructor(root: string) {
    this.#file = new IdentityFile(join(root, "sessions.json"), validate, {
      version: 1,
      revision: 0,
      signingRevision: 0,
      signingKey: null,
    });
    const saved = this.#file.capture();
    if (saved.persistence.raw !== null && saved.value.signingKey === null) {
      throw new IdentityStateError();
    }
    registerAuthorityReader(this, (native) => {
      const state = native
        ? authorityRead<{ value: SessionState }>(this.#file, native).value
        : this.capture().value;
      return Object.freeze({
        initialized: state.signingKey !== null,
        signingRevision: state.signingRevision,
      });
    });
  }
  capture() {
    return this.#file.capture();
  }
  assertUnchanged(expected = this.capture()): void {
    this.#file.assertUnchanged(expected);
  }
  prepareParents(): void {
    this.#file.prepareParents();
  }
  initialize(configuredSeedId?: string, lease?: OperationLease<"live">): void {
    const expected = this.capture();
    if (expected.persistence.raw !== null) throw new IdentityStateError();
    const signingKey = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    this.#file.commit(
      {
        version: 1,
        revision: 1,
        signingRevision: 1,
        signingKey,
        ...(configuredSeedId === undefined ? {} : { configuredSeedId }),
      },
      expected,
      undefined,
      lease ? [lease] : [],
    );
  }
  current(): SessionState & { readonly signingKey: string } {
    const state = this.capture().value;
    if (!state.signingKey) throw new AuthenticationError();
    return state as SessionState & { readonly signingKey: string };
  }
}

export class InstanceSessions {
  readonly #now: (context: AuthorityReadContext) => number;
  readonly #credentials: AccountCredentials;
  constructor(
    readonly accounts: AccountRepository,
    readonly signing: SessionRepository,
    readonly settings: SessionSettings,
    options: { now?: (context: AuthorityReadContext) => number } = {},
  ) {
    if (
      !Number.isSafeInteger(settings.expirySeconds) ||
      settings.expirySeconds <= 0
    ) {
      throw new IdentityStateError();
    }
    // Expiry is real wall time; callers inject the clock for deterministic tests.
    this.#now = options.now ?? Date.now;
    this.#credentials = accounts.credentials;
  }
  /** An absent credential is guest; an explicitly submitted bad one never is. */
  async resolve(token: string | null): Promise<Principal> {
    return token === null ? GUEST : await this.validateToken(token);
  }
  /** Public ordinary assertions deliberately do not inherit a native check.
   * AuthorityPrincipalCheck is the required-context validation callback form. */
  assertCurrent(principal: AccountPrincipal): void;
  assertCurrent(
    principal: AccountPrincipal,
    context: AuthorityReadContext,
  ): void;
  assertCurrent(
    principal: AccountPrincipal,
    context?: AuthorityReadContext,
  ): void {
    if (context) this.#assertCurrent(principal, context);
    else {withAuthorityContext(undefined, (ordinary) =>
        this.#assertCurrent(principal, ordinary));}
  }
  #assertCurrent(
    principal: AccountPrincipal,
    context: AuthorityReadContext,
  ): void {
    assertAuthorityContext(context);
    const now = this.#now(context);
    const account = context.accounts(this.accounts).value.accounts.find((a) =>
        a.id === principal.accountId
      ),
      signing = context.signing(this.signing);
    if (
      !signing.initialized || !account ||
      account.credentialRevision !== principal.credentialRevision ||
      account.passwordChangeRequired !== principal.passwordChangeRequired ||
      signing.signingRevision !== principal.signingRevision ||
      !Number.isFinite(principal.expiresAt) ||
      now >= principal.expiresAt
    ) throw new AuthenticationError();
  }
  async login(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<IssuedSession> {
    if (
      !record(input) ||
      Object.keys(input).some((key) =>
        !["username", "password", "totp"].includes(key)
      ) ||
      typeof input.username !== "string" ||
      typeof input.password !== "string" ||
      (input.totp !== undefined && typeof input.totp !== "string")
    ) throw new AuthenticationError();
    // Preserve the aggregate's safe missing-authenticator step. It carries no
    // proof/session; issue still accepts only a fully verified LoginProof.
    const proof = await this.#credentials.authenticate(
      input.username,
      input.password,
      input.totp as string | undefined,
      signal,
    );
    return await this.issue(proof);
  }
  async issue(
    proof: LoginProof | InitialAccountProof,
  ): Promise<IssuedSession> {
    const credentials = this.#credentials;
    const claim = credentials.beginLogin(proof);
    let transferred = false;
    try {
      const account = claim.identity;
      const signingSnapshot = this.signing.capture();
      const signing = this.signing.current(),
        seconds = Math.floor(withAuthorityContext(undefined, this.#now) / 1000);
      const expiry = seconds + this.settings.expirySeconds;
      if (!Number.isSafeInteger(expiry)) throw new AuthenticationError();
      const access_token = await new SignJWT({
        credentialRevision: account.credentialRevision,
        signingRevision: signing.signingRevision,
      }).setSubject(account.id).setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(seconds).setExpirationTime(expiry)
        .sign(new TextEncoder().encode(signing.signingKey));
      const principal: AccountPrincipal = Object.freeze({
        kind: "account",
        accountId: account.id,
        credentialRevision: account.credentialRevision,
        signingRevision: signing.signingRevision,
        expiresAt: expiry * 1000,
        passwordChangeRequired: account.passwordChangeRequired,
      });
      // Serialization and all user callbacks precede the final owner fences.
      const bytes = new TextEncoder().encode(
        JSON.stringify({ access_token, token_type: "bearer", principal }),
      );
      const delivery = createOperationLease("live", [() => {
        this.assertCurrent(principal);
        this.signing.assertUnchanged(signingSnapshot);
        // assertCurrent samples the injected clock. Recheck cancellation and the
        // exact account snapshot after that callback, before the native enqueue.
        // The parent check still rejects an already-aborted sign-in early.
        assertOperationLease(claim.lease, "live");
      }], [claim.lease]);
      const close = () => {
        delivery.retire();
        credentials.closeLogin(claim);
      };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const enqueue = controller.enqueue.bind(controller),
            finish = controller.close.bind(controller);
          try {
            bindGuardedSink(
              delivery.lease,
              "live",
              () => ({ value: bytes }),
              ({ value }) => {
                enqueue(value);
                finish();
                return undefined;
              },
            )(undefined);
          } catch {
            controller.error(new AuthenticationError());
          } finally {
            close();
          }
        },
        cancel: close,
      }, { highWaterMark: 0 });
      assertOperationLease(delivery.lease, "live");
      transferred = true;
      return Object.freeze({ principal, body });
    } catch {
      throw new AuthenticationError();
    } finally {
      if (!transferred) credentials.closeLogin(claim);
    }
  }
  async validateToken(token: string): Promise<AccountPrincipal> {
    try {
      const signing = this.signing.current();
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(signing.signingKey),
        {
          algorithms: ["HS256"],
          requiredClaims: [
            "sub",
            "exp",
            "credentialRevision",
            "signingRevision",
          ],
          currentDate: new Date(withAuthorityContext(undefined, this.#now)),
        },
      );
      if (
        !identity(payload.sub) || !integer(payload.credentialRevision) ||
        !integer(payload.signingRevision) || !integer(payload.exp) ||
        !Number.isSafeInteger(payload.exp * 1000)
      ) throw new AuthenticationError();
      const account = this.accounts.identityById(payload.sub);
      if (!account) throw new AuthenticationError();
      const principal: AccountPrincipal = Object.freeze({
        kind: "account",
        accountId: payload.sub,
        credentialRevision: payload.credentialRevision,
        signingRevision: payload.signingRevision,
        expiresAt: payload.exp * 1000,
        passwordChangeRequired: account.passwordChangeRequired,
      });
      this.assertCurrent(principal);
      return principal;
    } catch {
      throw new AuthenticationError();
    }
  }
}
