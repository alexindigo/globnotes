// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import type { AccountIdentity } from "./accounts.ts";
import type { AuthenticatorChange } from "./account_credentials.ts";
import { bindCredentialAuthority } from "./internal/account_credentials.ts";
import { InstanceAuthority } from "./authority.ts";
import { identity, integer, record } from "./records.ts";
import { readRequestJson } from "./request_json.ts";
import type { Principal } from "./sessions.ts";
import { createOperationLease } from "../operation_lease.ts";
import { StoredConfigConflict } from "../config/publication_outcome.ts";

export function accountView(account: AccountIdentity) {
  return Object.freeze({
    id: account.id,
    login: account.login,
    totpEnabled: account.totpEnabled,
    credentialRevision: account.credentialRevision,
    passwordChangeRequired: account.passwordChangeRequired,
    lastUpdateId: account.credentialUpdateId,
  });
}
function invalid(): never {
  throw new HttpError(422, "Invalid account change.");
}
/** Only wire validation/mapping lives here. The aggregate owns verification,
 * enrollment custody, hashing, replay state and credential publication. */
function command(input: unknown) {
  if (!record(input)) invalid();
  const keys = Object.keys(input);
  const {
    revision,
    updateId,
    currentPassword,
    currentTotp,
    newPassword,
    totp,
  } = input;
  if (
    keys.some((key) =>
      ![
        "revision",
        "updateId",
        "currentPassword",
        "currentTotp",
        "newPassword",
        "totp",
      ].includes(key)
    ) || !integer(revision) || !identity(updateId) ||
    typeof currentPassword !== "string" ||
    (currentTotp !== undefined && typeof currentTotp !== "string") ||
    (newPassword !== undefined &&
      (typeof newPassword !== "string" || !newPassword)) ||
    (newPassword === undefined && totp === undefined)
  ) invalid();
  let authenticator: AuthenticatorChange = Object.freeze({ kind: "keep" });
  if (totp !== undefined) {
    if (!record(totp)) invalid();
    const fields = Object.keys(totp), { enabled, key, code } = totp;
    if (enabled === false && fields.length === 1) {
      authenticator = Object.freeze({ kind: "remove" });
    } else if (
      enabled === true && fields.length === 3 &&
      fields.every((field) => ["enabled", "key", "code"].includes(field)) &&
      typeof key === "string" && typeof code === "string"
    ) {
      authenticator = Object.freeze({ kind: "enroll", key, code });
    } else invalid();
  }
  return Object.freeze({
    credentialRevision: revision,
    updateId,
    current: Object.freeze({
      password: currentPassword,
      ...(currentTotp === undefined ? {} : { code: currentTotp }),
    }),
    ...(newPassword === undefined ? {} : { newPassword }),
    authenticator,
  });
}

function ownOperation(
  authority: InstanceAuthority,
  principal: Principal,
  signal?: AbortSignal,
) {
  const sessions = authority.sessions, lifetime = authority.lifetime;
  const completion = new InstanceAuthority(sessions, () => null, lifetime);
  const operation = createOperationLease("live", [() => {
    signal?.throwIfAborted();
  }], [lifetime]);
  const instance = new InstanceAuthority(
    sessions,
    () => null,
    operation.lease,
  ).instanceLease(principal, "manageOwnAccount");
  operation.lease.assertCurrent();
  // instance admission establishes an account principal without vault access.
  if (instance.principal.kind !== "account") invalid();
  const accounts = sessions.accounts;
  const account = accounts.identityById(instance.principal.accountId)!;
  const credential = bindCredentialAuthority(
    accounts.credentials,
    account,
    instance.lease,
  );
  return {
    instance,
    completion,
    lifetime,
    operation,
    accounts,
    account,
    credential,
  };
}

/** Prepared instance workflow. It never selects a target account or vault, and
 * only lease-bound response bodies leave it, including the self-revoking ACK. */
export class OwnAccount {
  readonly #authority: InstanceAuthority;
  constructor(authority: InstanceAuthority) {
    this.#authority = authority;
  }
  view(principal: Principal, signal?: AbortSignal) {
    const own = ownOperation(this.#authority, principal, signal);
    return own.instance.body(own.instance.prepare(accountView(own.account)));
  }
  async enrolment(principal: Principal, signal?: AbortSignal) {
    const own = ownOperation(this.#authority, principal, signal);
    try {
      const bundle = await own.accounts.credentials.beginEnrollment(
        own.credential,
        signal,
      );
      own.operation.lease.assertCurrent();
      return own.instance.body(own.instance.prepare(bundle));
    } catch (error) {
      own.operation.retire();
      throw error;
    }
  }
  async change(principal: Principal, input: unknown, signal?: AbortSignal) {
    return await this.#change(
      ownOperation(this.#authority, principal, signal),
      input,
      signal,
    );
  }
  async patch(principal: Principal, request: Request) {
    const signal = request.signal;
    const own = ownOperation(this.#authority, principal, signal);
    try {
      return await this.#change(own, await readRequestJson(request), signal);
    } finally {
      own.operation.retire();
    }
  }
  async #change(
    own: ReturnType<typeof ownOperation>,
    input: unknown,
    signal?: AbortSignal,
  ) {
    try {
      const request = command(input);
      if (
        request.credentialRevision !== own.account.credentialRevision ||
        request.updateId === own.account.credentialUpdateId
      ) throw new StoredConfigConflict();
      const admitted = Object.freeze({
        actor: own.account.id,
        updateId: request.updateId,
      });
      const next = await own.accounts.credentials.changeOwn(
        own.credential,
        request,
        signal,
      );
      // This exact publication revoked the live credential lease. A historical
      // ACK has composition lifetime, not permission for another credential edit.
      const outcome = createOperationLease("outcome", [() => {
        signal?.throwIfAborted();
        if (
          next.id !== admitted.actor ||
          next.credentialUpdateId !== admitted.updateId
        ) invalid();
      }], [own.lifetime]);
      const disclosure = own.completion.acknowledgment(outcome.lease);
      return disclosure.body(disclosure.prepare(Object.freeze({
        account: accountView(next),
        requiresLogin: true,
        updateId: admitted.updateId,
      })));
    } finally {
      own.operation.retire();
    }
  }
}

/** Injection-only adapters, not discovered on the active legacy route tree. */
export function ownAccountHandlers(
  workflow: OwnAccount,
  principal: (request: Request) => Promise<Principal>,
) {
  const response = (body: ReadableStream) =>
    new Response(body, { headers: { "content-type": "application/json" } });
  return Object.freeze({
    async get(request: Request) {
      return response(workflow.view(await principal(request), request.signal));
    },
    async patch(request: Request) {
      return response(await workflow.patch(await principal(request), request));
    },
    async enrolment(request: Request) {
      return response(
        await workflow.enrolment(await principal(request), request.signal),
      );
    },
  });
}
