// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { StoredConfigConflict } from "../config/publication_outcome.ts";
import { AccessLoginConflict } from "./access_login_conflict.ts";
import { OperationError } from "../plugins/errors.ts";
import { createOperationLease } from "../operation_lease.ts";
import type { VaultAccess } from "./access.ts";
import { type AccessLevel, isAccessLevel } from "./acl.ts";
import { type AccountRepository, normalizeLogin } from "./accounts.ts";
import { bindAccountPreparationAuthority } from "./internal/account_credentials.ts";
import {
  fields,
  identity,
  IdentityStateError,
  integer,
  record,
} from "./records.ts";
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
import { IdentityTransactionUnavailable } from "./transaction_outcome.ts";

type Terminal = ReturnType<
  AccountRepository["capture"]
>["value"]["provisioning"][number];
interface Pending {
  readonly actorId: string;
  readonly vaultId: string;
  readonly waiters: Set<() => void>;
  unavailable?: IdentityTransactionUnavailable;
}
type Operation =
  | { state: "unknown" }
  | { state: "pending"; pending: Pending }
  | { state: "committed"; receipt: Extract<Terminal, { committed: true }> }
  | { state: "failed"; receipt: Extract<Terminal, { committed: false }> };

// A repository's durable receipt IDs are instance-wide, so its pending IDs
// must share that same namespace across all of its vault workflows.
const pendingByRepository = new WeakMap<
  AccountRepository,
  Map<string, Pending>
>();

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
  if (!record(input) || !fields(input, FIELDS)) invalid();
  const {
    login: rawLogin,
    temporaryPassword,
    level,
    operationId,
    revision,
    signature,
  } = input;
  if (
    typeof rawLogin !== "string" ||
    typeof temporaryPassword !== "string" || !temporaryPassword ||
    !isAccessLevel(level) || !identity(operationId) || !integer(revision) ||
    typeof signature !== "string"
  ) invalid();
  let login: string;
  try {
    login = normalizeLogin(rawLogin);
  } catch (error) {
    if (error instanceof IdentityStateError) invalid();
    throw error;
  }
  return Object.freeze({
    login,
    password: temporaryPassword,
    level,
    operationId,
    revision,
    signature,
  });
}

/** Create-and-add publishes the temporary account, its actor/target/payload
 * receipt and the named grant as one recorded identity decision. Replies only
 * acknowledge historical completion, never permission to repeat a grant. */
export class AccountProvisioning {
  readonly access: VaultAccess;
  readonly #transaction: IdentityTransaction;
  readonly #pending: Map<string, Pending>;
  constructor(access: VaultAccess, transaction: IdentityTransaction) {
    this.access = access;
    this.#transaction = transaction;
    const accounts = access.authority.sessions.accounts;
    this.#pending = pendingByRepository.get(accounts) ?? new Map();
    pendingByRepository.set(accounts, this.#pending);
  }
  #join(pending: Pending, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (pending.unavailable) throw pending.unavailable;
    const { waiters } = pending;
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(settle);
        reject(signal!.reason);
      };
      waiters.add(settle);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async createAndAdd(
    principal: Principal,
    input: unknown,
    signal?: AbortSignal,
  ) {
    const actor = this.access.admit(principal).principal as AccountPrincipal;
    const data = capture(input);
    const { operationId } = data;
    signal?.throwIfAborted();
    let operation = this.#operation(operationId);
    if (operation.state === "pending") {
      if (!this.#owns(actor, operation.pending)) {
        throw new StoredConfigConflict();
      }
      await this.#join(operation.pending, signal);
      operation = this.#operation(operationId);
      // Joiners can observe a terminal result, never become the worker.
      if (operation.state === "unknown" || operation.state === "pending") {
        throw new IdentityTransactionUnavailable();
      }
    }
    if (operation.state !== "unknown") {
      const { receipt } = operation;
      if (!this.#owns(actor, receipt)) throw new StoredConfigConflict();
      if (!receipt.committed) {
        throw new HttpError(
          409,
          "This account creation failed; use a new operation ID.",
        );
      }
      const admin = this.access.admit(actor);
      const hash = await this.#payloadHash(actor, data);
      admin.assertCurrent(operationId);
      if (receipt.payloadHash === hash) {
        return this.#acknowledge(actor, operationId, receipt.accountId, signal);
      }
      throw new StoredConfigConflict();
    }
    const pending: Pending = {
      actorId: actor.accountId,
      vaultId: this.access.vault.id,
      waiters: new Set(),
    };
    this.#pending.set(operationId, pending);
    try {
      return await this.#create(actor, data, signal);
    } catch (error) {
      // Neither an unreadable store nor a decision awaiting recovery proves
      // failure. Retain the slot and never hand it to a queued POST.
      try {
        this.#transaction.assertReady();
        if (
          !readAuthorityState((context) => this.#receipt(operationId, context))
        ) {
          this.#transaction.recordProvisioningFailure(
            {
              operationId,
              actorId: pending.actorId,
              vaultId: pending.vaultId,
              committed: false,
            },
          );
        }
      } catch (cause) {
        pending.unavailable = error instanceof IdentityTransactionUnavailable
          ? error
          : new IdentityTransactionUnavailable({
            cause: new AggregateError(
              [error, cause],
              "Provisioning outcome unavailable.",
            ),
          });
        throw pending.unavailable;
      }
      throw error;
    } finally {
      if (!pending.unavailable) this.#pending.delete(operationId);
      for (const settle of pending.waiters) settle();
      pending.waiters.clear();
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
  #owns(
    principal: AccountPrincipal,
    owner: { actorId: string; vaultId: string },
  ) {
    return owner.actorId === principal.accountId &&
      owner.vaultId === this.access.vault.id;
  }
  #operation(operationId: string): Operation {
    this.#transaction.assertReady();
    const receipt = readAuthorityState((context) =>
      this.#receipt(operationId, context)
    );
    if (receipt) {
      return receipt.committed
        ? { state: "committed", receipt }
        : { state: "failed", receipt };
    }
    const pending = this.#pending.get(operationId);
    return pending ? { state: "pending", pending } : { state: "unknown" };
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
    const expected = acl.capture();
    const view = await acl.view();
    if (view.revision !== data.revision || view.signature !== data.signature) {
      throw new StoredConfigConflict();
    }
    signal?.throwIfAborted();
    admin.assertCurrent(data.operationId);
    if (accounts.byLogin(data.login)) throw new AccessLoginConflict();
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
    return (await this.#review(principal, operationId, signal)).body;
  }
  async reviewResponse(
    principal: Principal,
    operationId: unknown,
    signal?: AbortSignal,
  ) {
    const { body, settled } = await this.#review(
      principal,
      operationId,
      signal,
    );
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    // Only a durable terminal outcome qualifies the existing receipt body.
    if (settled) headers.set("globnotes-creation-settled", "true");
    return new Response(body, { headers });
  }
  async #review(
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
    let operation = this.#operation(operationId);
    if (
      operation.state === "pending" && this.#owns(principal, operation.pending)
    ) {
      await this.#join(operation.pending, signal);
      operation = this.#operation(operationId);
      if (operation.state === "pending") {
        throw operation.pending.unavailable ??
          new IdentityTransactionUnavailable();
      }
    }
    if (
      operation.state === "committed" &&
      this.#owns(principal, operation.receipt)
    ) {
      return {
        body: this.#acknowledge(
          principal,
          operationId,
          operation.receipt.accountId,
          signal,
        ),
        settled: true,
      };
    }
    const snapshot = sessions.accounts.capture();
    const body = this.#disclose(
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
    return {
      body,
      settled: operation.state === "failed" &&
        this.#owns(principal, operation.receipt),
    };
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
          !receipt?.committed || receipt.accountId !== accountId ||
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
    const { authority, vault } = this.access;
    const disclosure = authority.vaultDisclosure(
      actor,
      vault,
      vault.acl.capture(),
      { signal, exact },
    );
    return disclosure.body(disclosure.prepare(value));
  }
}
