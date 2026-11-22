// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { StoredConfigConflict } from "../config/publication_outcome.ts";
import { OperationError } from "../plugins/errors.ts";
import { createOperationLease } from "../operation_lease.ts";
import type { VaultAccess } from "./access.ts";
import { ACCESS_LEVELS, type AccessLevel } from "./acl.ts";
import { normalizeLogin } from "./accounts.ts";
import { bindAccountPreparationAuthority } from "./internal/account_credentials.ts";
import { identity, IdentityStateError, integer, record } from "./records.ts";
import type { AccountPrincipal, Principal } from "./sessions.ts";
import {
  type AuthorityCallback,
  type AuthorityReadContext,
  readAuthorityState,
} from "./authority_context.ts";
import type {
  IdentityParticipants,
  IdentityTransaction,
} from "./transaction.ts";

interface ProvisioningInput {
  readonly login: string;
  readonly password: string;
  readonly level: AccessLevel;
  readonly operationId: string;
  readonly revision: number;
  readonly signature: string;
}
const FIELDS = [
  "login",
  "temporaryPassword",
  "level",
  "operationId",
  "revision",
  "signature",
];
function invalid(): never {
  throw new HttpError(422, "Invalid create-and-add request.");
}
function capture(input: unknown): ProvisioningInput {
  const value: unknown = structuredClone(input);
  if (
    !record(value) || Object.keys(value).length !== FIELDS.length ||
    Object.keys(value).some((key) => !FIELDS.includes(key)) ||
    typeof value.login !== "string" ||
    typeof value.temporaryPassword !== "string" || !value.temporaryPassword ||
    !ACCESS_LEVELS.includes(value.level as AccessLevel) ||
    !identity(value.operationId) || !integer(value.revision) ||
    typeof value.signature !== "string"
  ) invalid();
  let login: string;
  try {
    login = normalizeLogin(value.login);
  } catch (error) {
    if (error instanceof IdentityStateError) invalid();
    throw error;
  }
  return Object.freeze({
    login,
    password: value.temporaryPassword,
    level: value.level as AccessLevel,
    operationId: value.operationId,
    revision: value.revision,
    signature: value.signature,
  });
}

/** Create-and-add publishes the temporary account, its actor/target/payload
 * receipt and the named grant as one recorded identity decision. Replies only
 * acknowledge historical completion, never permission to repeat a grant. */
export class AccountProvisioning {
  readonly access: VaultAccess;
  readonly #transaction: IdentityTransaction;
  /** Admitted work by operation ID until its actual settlement. */
  readonly #pending = new Map<string, Promise<void>>();
  constructor(access: VaultAccess, transaction: IdentityTransaction) {
    this.access = access;
    this.#transaction = transaction;
  }
  async createAndAdd(
    principal: Principal,
    input: unknown,
    signal?: AbortSignal,
  ) {
    this.access.admit(principal);
    const actor = principal as AccountPrincipal;
    const data = capture(input);
    for (
      let prior = this.#pending.get(data.operationId);
      prior;
      prior = this.#pending.get(data.operationId)
    ) await prior;
    const work = this.#create(actor, data, signal);
    const settled = work.then(() => undefined, () => undefined);
    this.#pending.set(data.operationId, settled);
    try {
      return await work;
    } finally {
      if (this.#pending.get(data.operationId) === settled) {
        this.#pending.delete(data.operationId);
      }
    }
  }
  /** Keyed by the signing secret: receipts never hold the password or an
   * unkeyed digest of it. */
  async #payloadHash(actor: AccountPrincipal, data: ProvisioningInput) {
    const { sessions } = this.access.authority;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(sessions.signing.current().signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(JSON.stringify([
        actor.accountId,
        this.access.vault.id,
        data.operationId,
        data.login,
        data.password,
        data.level,
      ])),
    );
    return [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }
  #receipt(operationId: string, context: AuthorityReadContext) {
    return context.accounts(this.access.authority.sessions.accounts).value
      .provisioning
      .find((receipt) => receipt.operationId === operationId);
  }
  async #create(
    actor: AccountPrincipal,
    data: ProvisioningInput,
    signal?: AbortSignal,
  ) {
    const admin = this.access.admit(actor);
    const { sessions } = this.access.authority;
    const accounts = sessions.accounts, acl = this.access.vault.acl;
    const vaultId = this.access.vault.id;
    const payloadHash = await this.#payloadHash(actor, data);
    admin.assertCurrent(data.operationId);
    const previous = readAuthorityState((context) =>
      this.#receipt(data.operationId, context)
    );
    if (previous) {
      // Historical completion only: no reset, no grant reapplication.
      if (
        previous.actorId !== actor.accountId || previous.vaultId !== vaultId ||
        previous.payloadHash !== payloadHash
      ) throw new StoredConfigConflict();
      return this.#acknowledge(
        actor,
        data.operationId,
        previous.accountId,
        signal,
      );
    }
    if (accounts.byLogin(data.login)) throw new StoredConfigConflict();
    const view = await acl.view();
    if (view.revision !== data.revision || view.signature !== data.signature) {
      throw new StoredConfigConflict();
    }
    const pending = (): undefined => {
      signal?.throwIfAborted();
      return undefined;
    };
    // The target Admin lease is a parent of preparation and of every participant
    // through decision, where G1 validates it against the retained committed
    // pair. The journal record is not a participant: public authority reads are
    // fenced then, so its writer carries only the composition lifetime.
    const operation = createOperationLease("live", [pending], [admin.lease]);
    const journal = createOperationLease("live", [pending], [
      this.access.authority.lifetime,
    ]);
    let parts: IdentityParticipants | undefined;
    try {
      const expected = acl.capture();
      admin.assertCurrent(data.operationId);
      const prepared = await accounts.credentials.preparePasswordOnlyRecipient(
        bindAccountPreparationAuthority(
          accounts.credentials,
          "recipient",
          operation.lease,
        ),
        {
          login: data.login,
          password: data.password,
          updateId: data.operationId,
        },
        signal,
      ).catch((error) => {
        // Attribute an Admin/policy change to this exact pending operation.
        if (error instanceof OperationError) {
          admin.assertCurrent(data.operationId);
        }
        throw error;
      });
      admin.assertCurrent(data.operationId);
      parts = this.#transaction.prepareRecipient(
        acl,
        prepared,
        data.level,
        expected,
        { actorId: actor.accountId, payloadHash },
        operation.lease,
        data.operationId,
      );
      this.#transaction.commit(
        {
          kind: "create-and-add",
          operationId: data.operationId,
          actorId: actor.accountId,
          vaultId,
        },
        parts,
        journal.lease,
      );
      return this.#acknowledge(
        actor,
        data.operationId,
        prepared.identity.id,
        signal,
      );
    } finally {
      try {
        parts?.discard();
      } finally {
        journal.retire();
        operation.retire();
      }
    }
  }
  /** Known-ID read for a lost reply. It waits for the admitted operation's real
   * settlement; absence while it hashes is not noncommit. Actor-bound only. */
  async review(
    principal: Principal,
    operationId: unknown,
    signal?: AbortSignal,
  ) {
    const { sessions } = this.access.authority;
    if (principal.kind !== "account" || principal.passwordChangeRequired) {
      throw new HttpError(401, "Sign in required.");
    }
    if (!identity(operationId)) {
      throw new HttpError(422, "Invalid operation identity.");
    }
    sessions.assertCurrent(principal);
    for (
      let prior = this.#pending.get(operationId);
      prior;
      prior = this.#pending.get(operationId)
    ) await prior;
    this.#transaction.assertReady();
    const receipt = readAuthorityState((context) =>
      this.#receipt(operationId, context)
    );
    if (
      receipt?.actorId === principal.accountId &&
      receipt.vaultId === this.access.vault.id
    ) {
      return this.#acknowledge(
        principal,
        operationId,
        receipt.accountId,
        signal,
      );
    }
    const snapshot = sessions.accounts.capture();
    return this.#disclose(
      principal,
      Object.freeze({
        operationId,
        committed: false as const,
      }),
      signal,
      () => {
        this.#transaction.assertReady();
        sessions.accounts.assertUnchanged(snapshot);
      },
    );
  }
  #acknowledge(
    actor: AccountPrincipal,
    operationId: string,
    accountId: string,
    signal: AbortSignal | undefined,
  ) {
    const vaultId = this.access.vault.id;
    return this.#disclose(
      actor,
      Object.freeze({
        operationId,
        accountId,
        committed: true as const,
      }),
      signal,
      (context) => {
        const receipt = this.#receipt(operationId, context);
        if (
          receipt?.accountId !== accountId ||
          receipt.actorId !== actor.accountId || receipt.vaultId !== vaultId
        ) throw new StoredConfigConflict();
      },
    );
  }
  /** Separate exact outcome lease: the composition lifetime remains a parent,
   * but a self-demoted or no-longer-Admin actor keeps only its own receipt. */
  #disclose(
    actor: AccountPrincipal,
    value: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    exact: AuthorityCallback<void>,
  ) {
    const { authority } = this.access;
    const outcome = createOperationLease("outcome", [
      () =>
        readAuthorityState((context) => {
          signal?.throwIfAborted();
          context.assertPrincipal(authority.sessions, actor);
          exact(context);
          return undefined;
        }),
    ], [authority.lifetime]);
    const disclosure = authority.acknowledgment(outcome.lease);
    return disclosure.body(disclosure.prepare(value));
  }
}
