// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import type { Account } from "./accounts.ts";
import {
  AuthenticationError,
  type InstanceSessions,
  type Principal,
} from "./sessions.ts";
import { identity, integer, record } from "./records.ts";
import { matchingTotpStep, validTotpKey } from "./credentials.ts";
import { totpEnrolment } from "./totp_enrolment.ts";
import { hashPassword } from "../helpers.ts";
import { StoredConfigConflict } from "../config/file_store.ts";

export function accountView(account: Account) {
  return Object.freeze({
    id: account.id,
    login: account.login,
    totpEnabled: account.totpKey !== null,
    credentialRevision: account.credentialRevision,
    passwordChangeRequired: account.passwordChangeRequired,
    lastUpdateId: account.credentialUpdateId,
  });
}
function invalid(): never {
  throw new HttpError(422, "Invalid account change.");
}

/** Instance-scoped own-account workflow. The caller supplies an already verified
 * principal, never a target account ID. Slow work stays outside the commit. */
export class OwnAccount {
  constructor(
    readonly sessions: InstanceSessions,
    readonly options: { now?: () => number; hash?: typeof hashPassword } = {},
  ) {}
  #own(principal: Principal): Account {
    if (principal.kind !== "account") throw new AuthenticationError();
    this.sessions.assertCurrent(principal);
    return this.sessions.accounts.byId(principal.accountId)!;
  }
  view(principal: Principal) {
    return accountView(this.#own(principal));
  }
  async enrolment(principal: Principal) {
    const account = this.#own(principal);
    const candidate = await totpEnrolment(account.login);
    this.#own(principal);
    return candidate;
  }
  async change(principal: Principal, input: unknown, signal?: AbortSignal) {
    const account = this.#own(principal);
    if (
      !record(input) || Object.keys(input).some((key) =>
        ![
          "revision",
          "updateId",
          "currentPassword",
          "currentTotp",
          "newPassword",
          "totp",
        ].includes(key)
      ) || !integer(input.revision) || !identity(input.updateId) ||
      typeof input.currentPassword !== "string" ||
      (input.currentTotp !== undefined &&
        typeof input.currentTotp !== "string") ||
      (input.newPassword !== undefined &&
        (typeof input.newPassword !== "string" || !input.newPassword)) ||
      (input.newPassword === undefined && input.totp === undefined)
    ) invalid();
    if (
      input.revision !== account.credentialRevision ||
      input.updateId === account.credentialUpdateId
    ) {
      throw new StoredConfigConflict();
    }
    if (account.passwordChangeRequired && input.newPassword === undefined) {
      invalid();
    }
    let key: string | null | undefined;
    let confirmedTotpStep: number | undefined;
    if (input.totp !== undefined) {
      if (!record(input.totp)) invalid();
      if (
        input.totp.enabled === false && Object.keys(input.totp).length === 1
      ) key = null;
      else if (
        input.totp.enabled === true && Object.keys(input.totp).length === 3 &&
        validTotpKey(input.totp.key) &&
        typeof input.totp.code === "string"
      ) {
        key = input.totp.key;
        const step = matchingTotpStep(
          input.totp.code,
          key,
          (this.options.now ?? Date.now)(),
        );
        if (
          step === null ||
          (key === account.totpKey &&
            account.lastTotpStep !== null &&
            step <= account.lastTotpStep)
        ) invalid();
        confirmedTotpStep = step;
      } else invalid();
    }
    signal?.throwIfAborted();
    const proof = await this.sessions.confirmCredentials(
      account.login,
      input.currentPassword,
      input.currentTotp as string | undefined,
    );
    if (
      proof.id !== account.id ||
      proof.credentialRevision !== account.credentialRevision
    ) throw new StoredConfigConflict();
    const passwordHash = input.newPassword === undefined
      ? undefined
      : await (this.options.hash ?? hashPassword)(input.newPassword as string);
    const guard = () => {
      signal?.throwIfAborted();
      this.#own(principal);
    };
    guard();
    const next = this.sessions.accounts.changeCredentials(
      account.id,
      account.credentialRevision,
      {
        ...(passwordHash === undefined
          ? {}
          : { passwordHash, passwordChangeRequired: false }),
        ...(key === undefined ? {} : { totpKey: key }),
      },
      input.updateId,
      guard,
      confirmedTotpStep,
      proof,
    );
    // The old session is revoked by this commit; do not reauthorize it to acknowledge.
    return Object.freeze({
      account: accountView(next),
      requiresLogin: true,
      updateId: input.updateId,
    });
  }
  /** Lost replies are reviewed only by proving the account's current credentials.
   * No revoked-token exception and no replay of the original change. */
  async outcome(input: unknown) {
    if (
      !record(input) ||
      Object.keys(input).some((key) =>
        !["username", "password", "totp", "updateId"].includes(key)
      ) ||
      typeof input.username !== "string" ||
      typeof input.password !== "string" || !identity(input.updateId) ||
      (input.totp !== undefined && typeof input.totp !== "string")
    ) invalid();
    const account = await this.sessions.confirmCredentials(
      input.username,
      input.password,
      input.totp as string | undefined,
    );
    this.sessions.assertCredentialProof(account);
    return Object.freeze({
      matched: account.credentialUpdateId === input.updateId,
      account: accountView(account),
    });
  }
}

/** Prepared handlers, deliberately not discovered/registered on the v2 route tree. */
export function ownAccountHandlers(
  workflow: OwnAccount,
  principal: (request: Request) => Promise<Principal>,
) {
  return Object.freeze({
    async get(request: Request) {
      return workflow.view(await principal(request));
    },
    async patch(request: Request) {
      const admitted = await principal(request);
      return workflow.change(admitted, await request.json(), request.signal);
    },
    async enrolment(request: Request) {
      return workflow.enrolment(await principal(request));
    },
    async outcome(request: Request) {
      return workflow.outcome(await request.json());
    },
  });
}
