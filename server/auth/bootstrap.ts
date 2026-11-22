// SPDX-License-Identifier: LGPL-3.0-only
import { join, resolve } from "@std/path";
import { HttpError } from "@pathfinder/pathfinder";
import { AccountRepository } from "./accounts.ts";
import { AclRepository, type EverybodyLevel } from "./acl.ts";
import { InstanceSessions, type IssuedSession } from "./sessions.ts";
import { InstanceAuthority } from "./authority.ts";
import { bindAccountPreparationAuthority } from "./internal/account_credentials.ts";
import {
  IdentityTransaction,
  IdentityTransactionUnavailable,
} from "./transaction.ts";
import { BoundFileStore } from "../config/file_store.ts";
import { loadInstanceConfig, type Sources } from "../config/loader.ts";
import { instanceMetadataPath, vaultMetadataPath } from "../config/paths.ts";
import { singleVaultBindings } from "../config/single_vault.ts";
import { serviceSettings } from "../config/consumers.ts";
import { createUuid } from "../../shared/uuid.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import { fields, identity, IdentityStateError, record } from "./records.ts";
import type { OfflineRecoveryAuthority } from "./offline_recovery.ts";

export class IdentityRecoveryError extends Error {
  constructor() {
    super(
      "Identity state requires offline operator recovery or explicit migration; public setup is unavailable.",
    );
  }
}
/** Inert configuration selection, shared by boot and the offline command. */
export function identityPaths(sources: Sources) {
  const loaded = loadInstanceConfig({
    ...sources,
    vaults: singleVaultBindings,
  });
  const config = loaded.config;
  const notes = resolve(
    config.vaults.entries.globnotes?.path ||
      resolve(config.vaults.basepath, "globnotes"),
  );
  const instance = instanceMetadataPath(
    config.vaults.basepath,
    config.metadata.path,
  );
  const vault = vaultMetadataPath(notes, config.metadata.path, "globnotes");
  return {
    loaded,
    instance,
    vault,
    notes,
    legacyFiles: [
      ...new Set([join(instance, "config.json"), join(vault, "config.json")]),
    ],
    sessions: serviceSettings(config).sessions,
  };
}
/** Inspect names only. Legacy or malformed inputs are never imported or repaired. */
export function legacyIdentityPresent(files: readonly string[]): boolean {
  let recognized = false;
  for (const filename of files) {
    const raw = new BoundFileStore(filename).capture().raw;
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new IdentityRecoveryError();
    }
    if (!record(parsed)) throw new IdentityRecoveryError();
    recognized ||= [
      "auth_type",
      "username",
      "password_hash",
      "totp_key",
      "secret_key",
    ].some((key) => Object.hasOwn(parsed, key));
  }
  return recognized;
}

/** Resolve only this configured target. A journal may supply its recorded opaque
 * vault ID before the first ACL exists, never a destination/root. Call under the
 * real offline owner, before exposing accounts or the target to consumers. */
export function openIdentityTransaction(
  accounts: AccountRepository,
  vaultRoot: string,
  lease: OperationLease<"live">,
  authority: OfflineRecoveryAuthority,
  vaultId?: string,
) {
  IdentityTransaction.assertUnowned(accounts.root);
  const raw =
    new BoundFileStore(join(accounts.root, "identity-transaction.json"))
      .capture().raw;
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new IdentityRecoveryError();
  }
  if (
    !record(value) || !identity(value.vaultId) ||
    (vaultId !== undefined && vaultId !== value.vaultId)
  ) throw new IdentityRecoveryError();
  const acl = new AclRepository(vaultRoot, vaultId ?? value.vaultId, {
    accounts,
  });
  const transaction = new IdentityTransaction(accounts, acl, {
    vaultRoot,
    lease,
  });
  try {
    transaction.recover(authority);
  } catch (cause) {
    try {
      transaction.close();
    } catch (cleanup) {
      throw new IdentityTransactionUnavailable({
        cause: new AggregateError(
          [cause, cleanup],
          "Recovery could not close.",
        ),
      });
    }
    throw cause;
  }
  return transaction;
}

export class IdentityBootstrap {
  readonly transaction: IdentityTransaction | undefined;
  readonly #ownedTransaction: IdentityTransaction | undefined;
  readonly #lease: OperationLease<"live">;
  readonly #legacy: () => boolean;
  readonly #first: Readonly<{ login: string; password: string }> | undefined;
  readonly #target: Readonly<{ acl: AclRepository; root: string }> | undefined;
  #source: ReturnType<typeof bindAccountPreparationAuthority> | undefined;
  #initial: ReturnType<typeof createOperationLease<"live">> | undefined;
  #completion: ReturnType<typeof createOperationLease<"live">> | undefined;
  #busy = false;
  #publishing = false;
  #configured = false;
  #signing: ReturnType<InstanceSessions["signing"]["capture"]> | undefined;
  #settled:
    | Readonly<
      {
        accounts: ReturnType<AccountRepository["capture"]>;
        acl: ReturnType<AclRepository["capture"]>;
      }
    >
    | undefined;
  #signal: AbortSignal | undefined;
  constructor(
    readonly accounts: AccountRepository,
    readonly sessions: InstanceSessions,
    options: {
      lease: OperationLease<"live">;
      legacy: () => boolean;
      target?: { acl: AclRepository; root: string };
      first?: { login: string; password: string };
      transaction?: IdentityTransaction;
    },
  ) {
    if (sessions.accounts !== accounts) throw new IdentityRecoveryError();
    this.#lease = options.lease;
    this.#legacy = options.legacy.bind(options);
    this.#first = options.first
      ? Object.freeze(structuredClone(options.first))
      : undefined;
    if (
      this.#first &&
      (typeof this.#first.login !== "string" ||
        typeof this.#first.password !== "string" ||
        (this.#first.login === "") !== (this.#first.password === ""))
    ) throw new IdentityRecoveryError();
    this.#target = options.target
      ? Object.freeze({ ...options.target, root: resolve(options.target.root) })
      : undefined;
    this.#ownedTransaction = !options.transaction && this.#target
      ? new IdentityTransaction(accounts, this.#target.acl, {
        vaultRoot: this.#target.root,
        lease: this.#lease,
      })
      : undefined;
    this.transaction = options.transaction ?? this.#ownedTransaction;
  }
  state(): "fresh" | "ready" | "incomplete" {
    assertOperationLease(this.#lease, "live");
    this.transaction?.assertReady();
    this.accounts.assertUnchanged();
    this.sessions.signing.assertUnchanged();
    const account = this.accounts.capture();
    const signing = this.sessions.signing.capture();
    const acl = this.#target?.acl.capture();
    const initialized = account.value.initialized;
    const accountsAbsent =
      new BoundFileStore(join(this.accounts.root, "accounts.json")).capture()
        .raw === null;
    const signingAbsent = signing.persistence.raw === null;
    if (accountsAbsent && signingAbsent) {
      if (
        this.#legacy() ||
        (acl && acl.persistence.raw !== null)
      ) throw new IdentityRecoveryError();
      assertOperationLease(this.#lease, "live");
      this.accounts.assertUnchanged(account);
      this.sessions.signing.assertUnchanged(signing);
      if (acl) this.#target!.acl.assertUnchanged(acl);
      return "fresh";
    }
    return !accountsAbsent && initialized && !signingAbsent
      ? "ready"
      : "incomplete";
  }
  status() {
    const state = this.state();
    if (state === "incomplete" || (state === "fresh" && this.#first?.login)) {
      throw new IdentityRecoveryError();
    }
    return Object.freeze({ setupRequired: state === "fresh" });
  }
  #fresh(): void {
    if ((!this.#configured && this.#first?.login) || this.state() !== "fresh") {
      throw new IdentityRecoveryError();
    }
  }
  #authority() {
    if (this.#source) return this.#source;
    this.#completion = createOperationLease("live", [() => {
      this.#signal?.throwIfAborted();
      if (this.#signing) this.sessions.signing.assertUnchanged(this.#signing);
      if (this.#settled) {
        this.accounts.assertUnchanged(this.#settled.accounts);
        this.#target!.acl.assertUnchanged(this.#settled.acl);
      }
      return undefined;
    }], [this.#lease]);
    this.#initial = createOperationLease("live", [() => {
      if (this.#publishing) {
        this.sessions.signing.assertUnchanged(this.#signing!);
      } else this.#fresh();
      return undefined;
    }], [this.#lease]);
    this.#source = bindAccountPreparationAuthority(
      this.accounts.credentials,
      "initial",
      this.#initial.lease,
      this.#completion.lease,
    );
    return this.#source;
  }
  async enrolment(login: string, signal?: AbortSignal) {
    this.#fresh();
    if (this.#busy) throw new IdentityRecoveryError();
    return await this.accounts.credentials.beginInitialEnrollment(
      this.#authority(),
      login,
      signal,
    );
  }
  async setup(input: unknown, signal?: AbortSignal) {
    this.#fresh();
    if (this.#busy) throw new IdentityRecoveryError();
    const value: unknown = structuredClone(input);
    if (
      !record(value) ||
      !fields(value, [
        "username",
        "password",
        "everybody",
        "updateId",
        ...(Object.hasOwn(value, "totp") ? ["totp"] : []),
      ]) || typeof value.username !== "string" ||
      typeof value.password !== "string" || !value.password ||
      !identity(value.updateId) ||
      !["edit", "view", "none"].includes(String(value.everybody)) ||
      !this.#target || !this.transaction
    ) throw new HttpError(422, "Invalid first-account setup.");
    if (
      Object.hasOwn(value, "totp") &&
      (!record(value.totp) || !fields(value.totp, ["key", "code"]) ||
        typeof value.totp.key !== "string" ||
        typeof value.totp.code !== "string")
    ) throw new HttpError(422, "Confirm the new authenticator.");
    this.#busy = true;
    this.#signal = signal;
    let parts: import("./transaction.ts").IdentityParticipants | undefined;
    let failed = false, failure: unknown;
    const errors: unknown[] = [];
    let result:
      | Readonly<
        IssuedSession & {
          setupRequired: false;
          vaultId: string;
          everybody: EverybodyLevel;
        }
      >
      | undefined;
    try {
      this.accounts.prepareParents();
      this.sessions.signing.prepareParents();
      this.#target.acl.prepareParents();
      const source = this.#authority();
      const credentials = {
        login: value.username,
        password: value.password,
        updateId: value.updateId,
      };
      const prepared = await this.accounts.credentials.prepareInitialAccount(
        source,
        value.totp
          ? {
            ...credentials,
            authenticator: value.totp as { key: string; code: string },
          }
          : credentials,
        signal,
      ).catch((error) => {
        if (error instanceof IdentityStateError) {
          throw new HttpError(
            422,
            value.totp
              ? "Confirm the new authenticator."
              : "Invalid first-account setup.",
          );
        }
        throw error;
      });
      signal?.throwIfAborted();
      this.#fresh();
      this.sessions.signing.initialize();
      this.#signing = this.sessions.signing.capture();
      this.#publishing = true;
      parts = this.transaction.prepareInitial(
        prepared,
        value.everybody as EverybodyLevel,
        this.#target.acl.capture(),
        this.#initial!.lease,
        value.updateId,
      );
      this.transaction.commit(
        {
          kind: "setup",
          operationId: value.updateId,
          actorId: prepared.identity.id,
          vaultId: this.#target.acl.vaultId,
        },
        parts,
        this.#initial!.lease,
      );
      this.#settled = Object.freeze({
        accounts: this.accounts.capture(),
        acl: this.#target.acl.capture(),
      });
      const proof = this.accounts.credentials.initialAccountProof(
        parts.account,
        parts.access,
      );
      const issued = await this.sessions.issue(proof);
      try {
        const handoff = {
          setupRequired: false as const,
          vaultId: this.#target.acl.vaultId,
          everybody: value.everybody as EverybodyLevel,
        };
        // G2 signs and consumes its proof. G3 owns the final combined response;
        // exact account/ACL/signing/cancellation fences remain through enqueue.
        const disclosure = new InstanceAuthority(
          this.sessions,
          () => null,
          this.#completion!.lease,
        ).instanceLease(issued.principal, "manageOwnAccount");
        const body = disclosure.body(
          await disclosure.read(async () => ({
            ...await new Response(issued.body).json(),
            ...handoff,
          })),
        );
        result = Object.freeze({
          ...handoff,
          principal: issued.principal,
          body,
        });
      } finally {
        // G2's private body owns the issuance claim until consumed or cancelled.
        // If final handoff admission refused before reading, release that claim.
        if (!issued.body.locked) await issued.body.cancel();
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        parts?.discard();
      } catch (error) {
        errors.push(error);
      }
      this.#busy = false;
      this.#publishing = false;
    }
    if (errors.length) {
      throw new AggregateError(
        failed ? [failure, ...errors] : errors,
        "Setup participant cleanup failed.",
        { cause: failure },
      );
    }
    if (failed) throw failure;
    return result!;
  }
  async provisionConfigured(): Promise<void> {
    if (!this.#first?.login || this.state() === "ready") return;
    if (this.#busy || this.state() !== "fresh") {
      throw new IdentityRecoveryError();
    }
    this.#busy = true;
    this.#configured = true;
    try {
      this.accounts.prepareParents();
      this.sessions.signing.prepareParents();
      const prepared = await this.accounts.credentials.prepareInitialAccount(
        this.#authority(),
        {
          login: this.#first.login,
          password: this.#first.password,
          updateId: createUuid(),
        },
      );
      this.#fresh();
      this.sessions.signing.initialize();
      this.#signing = this.sessions.signing.capture();
      this.#publishing = true;
      this.accounts.credentials.publishPreparedAccount(prepared.prepared);
    } finally {
      this.#busy = false;
      this.#publishing = false;
      this.#configured = false;
    }
  }
  dispose(): void {
    this.#initial?.retire();
    this.#completion?.retire();
    this.#ownedTransaction?.close();
  }
}
export function bootstrapHandlers(workflow: IdentityBootstrap) {
  return Object.freeze({
    get: () => workflow.status(),
    async post(request: Request) {
      workflow.status();
      const issued = await workflow.setup(await request.json(), request.signal);
      return new Response(issued.body, {
        headers: { "content-type": "application/json" },
      });
    },
    async enrolment(request: Request) {
      workflow.status();
      const input = await request.json();
      if (
        !record(input) || !fields(input, ["username"]) ||
        typeof input.username !== "string"
      ) throw new HttpError(422, "Invalid enrollment.");
      return await workflow.enrolment(input.username, request.signal);
    },
  });
}
