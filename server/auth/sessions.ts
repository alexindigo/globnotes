// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { jwtVerify, SignJWT } from "jose";
import { type Account, AccountRepository, normalizeLogin } from "./accounts.ts";
import { matchingTotpStep, totpSecretFromRawKey } from "./credentials.ts";
import {
  fields,
  identity,
  IdentityFile,
  IdentityStateError,
  integer,
  record,
} from "./records.ts";
import { verifyPassword } from "../helpers.ts";
import type { SessionSettings } from "../config/consumers.ts";

interface SessionState {
  readonly version: 1;
  readonly revision: number;
  readonly signingRevision: number;
  readonly signingKey: string | null;
}
function validate(value: unknown): SessionState {
  if (
    !record(value) ||
    !fields(value, ["version", "revision", "signingRevision", "signingKey"]) ||
    value.version !== 1 || !integer(value.revision) ||
    !integer(value.signingRevision) ||
    !(value.signingKey === null ||
      (typeof value.signingKey === "string" &&
        /^[0-9a-f]{64}$/.test(value.signingKey)))
  ) throw new IdentityStateError();
  return value as unknown as SessionState;
}
export class AuthenticationError extends Error {
  constructor() {
    super("Invalid authentication credentials.");
  }
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
  }
  capture() {
    return this.#file.capture();
  }
  prepareParents(): void {
    this.#file.prepareParents();
  }
  initialize(): void {
    const expected = this.capture();
    if (expected.persistence.raw !== null) throw new IdentityStateError();
    const signingKey = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    this.#file.commit({
      version: 1,
      revision: 1,
      signingRevision: 1,
      signingKey,
    }, expected);
  }
  current(): SessionState & { readonly signingKey: string } {
    const state = this.capture().value;
    if (!state.signingKey) throw new AuthenticationError();
    return state as SessionState & { readonly signingKey: string };
  }
}

export class InstanceSessions {
  readonly #now: () => number;
  readonly #verify: typeof verifyPassword;
  constructor(
    readonly accounts: AccountRepository,
    readonly signing: SessionRepository,
    readonly settings: SessionSettings,
    options: { now?: () => number; verify?: typeof verifyPassword } = {},
  ) {
    if (
      !Number.isSafeInteger(settings.expirySeconds) ||
      settings.expirySeconds <= 0
    ) {
      throw new IdentityStateError();
    }
    // Expiry is real wall time; callers inject the clock for deterministic tests.
    this.#now = options.now ?? Date.now;
    this.#verify = options.verify ?? verifyPassword;
  }
  /** An absent credential is guest; an explicitly submitted bad one never is. */
  async resolve(token: string | null): Promise<Principal> {
    return token === null ? GUEST : await this.validateToken(token);
  }
  assertCurrent(principal: AccountPrincipal): void {
    const account = this.accounts.byId(principal.accountId),
      signing = this.signing.current();
    if (
      !account || account.credentialRevision !== principal.credentialRevision ||
      account.passwordChangeRequired !== principal.passwordChangeRequired ||
      signing.signingRevision !== principal.signingRevision ||
      !Number.isFinite(principal.expiresAt) ||
      this.#now() >= principal.expiresAt
    ) throw new AuthenticationError();
  }
  /** Proofs pending async work are fenced; already issued sessions are not. */
  assertCredentialProof(account: Account): void {
    try {
      this.accounts.assertCredentialProof(account);
    } catch {
      throw new AuthenticationError();
    }
  }
  async confirmCredentials(
    login: string,
    password: string,
    code?: string,
  ): Promise<Account> {
    let account: Account | null;
    try {
      account = this.accounts.byLogin(normalizeLogin(login));
    } catch {
      throw new AuthenticationError();
    }
    if (
      !account || typeof password !== "string" ||
      !await this.#verify(password, account.passwordHash)
    ) {
      throw new AuthenticationError();
    }
    const live = this.accounts.byId(account.id);
    if (!live || live.credentialRevision !== account.credentialRevision) {
      throw new AuthenticationError();
    }
    if (account.totpKey) {
      const step = matchingTotpStep(
        code ?? "",
        totpSecretFromRawKey(account.totpKey),
        this.#now(),
      );
      if (step === null) throw new AuthenticationError();
      try {
        return this.accounts.consumeTotp(
          account.id,
          account.credentialRevision,
          step,
        );
      } catch {
        throw new AuthenticationError();
      }
    } else if (code !== undefined && code !== "") {
      throw new AuthenticationError();
    }
    return live;
  }
  async login(
    input: unknown,
  ): Promise<
    { access_token: string; token_type: "bearer"; principal: AccountPrincipal }
  > {
    if (
      !record(input) ||
      Object.keys(input).some((key) =>
        !["username", "password", "totp"].includes(key)
      ) ||
      typeof input.username !== "string" ||
      typeof input.password !== "string" ||
      (input.totp !== undefined && typeof input.totp !== "string")
    ) throw new AuthenticationError();
    const account = await this.confirmCredentials(
      input.username,
      input.password,
      input.totp as string | undefined,
    );
    const signing = this.signing.current(),
      seconds = Math.floor(this.#now() / 1000);
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
    this.assertCredentialProof(account);
    this.assertCurrent(principal);
    return { access_token, token_type: "bearer", principal };
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
          currentDate: new Date(this.#now()),
        },
      );
      if (
        !identity(payload.sub) || !integer(payload.credentialRevision) ||
        !integer(payload.signingRevision) || !integer(payload.exp) ||
        !Number.isSafeInteger(payload.exp * 1000)
      ) throw new AuthenticationError();
      const account = this.accounts.byId(payload.sub);
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
