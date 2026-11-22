// SPDX-License-Identifier: LGPL-3.0-only
/** Identity decisions and recovery. G1 owns every participant file effect. */
import { dirname, join, resolve } from "@std/path";
import {
  createOwnedPublication,
  createPublicationSet,
  type PublicationParticipant,
} from "../config/owned_publication.ts";
import {
  type StoredConfigSnapshot,
  syncOwnedStoredDirectory,
} from "../config/file_store.ts";
import { PublicationRecoveryRequired } from "../config/publication_outcome.ts";
import { physicalStateRoot } from "../config/state_root.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import {
  assertOfflineRecovery,
  type OfflineRecoveryAuthority,
} from "./offline_recovery.ts";
import { type AccountIdentity, type AccountRepository } from "./accounts.ts";
import {
  type AccessLevel,
  type AclRepository,
  type AclSnapshot,
  type EverybodyLevel,
} from "./acl.ts";
import type { PreparedAccount } from "./account_credentials.ts";
import { fields, identity, IdentityStateError, record } from "./records.ts";

export interface IdentityDecision {
  readonly kind: "setup" | "create-and-add";
  readonly operationId: string;
  readonly actorId: string;
  readonly vaultId: string;
}
interface Journal extends IdentityDecision {
  readonly version: 1;
  readonly phase: "prepared" | "decided";
  readonly participants: readonly unknown[];
}
type PublicationSet = ReturnType<typeof createPublicationSet>;
declare const identityParticipantsBrand: unique symbol;
export interface IdentityParticipants {
  readonly [identityParticipantsBrand]: true;
  readonly account: PublicationParticipant;
  readonly access: PublicationParticipant;
  discard(): void;
}
export class IdentityTransactionUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Identity publication requires recovery; no partial state is available.",
      options,
    );
  }
}

const ownedRoots = new Set<string>();

/** Construct and recover before exposing the repositories to normal consumers.
 * Each physical root has one owner in this process. Close before reopening a
 * surviving journal under exclusive recovery authority. If the journal was
 * already unlinked, its owner must finish retirement before it can close. */
export class IdentityTransaction {
  /** A missing journal is not an admission check while a root is owned. */
  static assertUnowned(root: string): void {
    if (ownedRoots.has(physicalStateRoot(root))) {
      throw new IdentityTransactionUnavailable();
    }
  }

  readonly #journal;
  readonly #accounts: AccountRepository;
  readonly #acl: AclRepository;
  readonly #root: string;
  readonly #physicalRoot: string;
  readonly #vaultRoot: string;
  readonly #lease: OperationLease<"live">;
  readonly #checkpoint: (phase: string) => void;
  #saved: StoredConfigSnapshot;
  #unlinked?: { set: PublicationSet; phase: Journal["phase"] };
  #ready = false;
  #active = false;
  #closed = false;
  #staging = 0;
  readonly #participants = new Map<IdentityParticipants, {
    readonly decision: IdentityDecision;
    readonly parts: readonly PublicationParticipant[];
    phase: "prepared" | "transferred" | "discarded";
  }>();
  constructor(
    accounts: AccountRepository,
    acl: AclRepository,
    options: {
      vaultRoot: string;
      lease: OperationLease<"live">;
      checkpoint?: (phase: string) => void;
    },
  ) {
    const { lease } = options;
    assertOperationLease(lease, "live");
    this.#accounts = accounts;
    this.#acl = acl;
    this.#root = accounts.root;
    this.#vaultRoot = resolve(options.vaultRoot);
    this.#lease = lease;
    const checkpoint = options.checkpoint?.bind(options);
    if (
      Object.prototype.toString.call(checkpoint) === "[object AsyncFunction]"
    ) {
      throw new TypeError("Identity checkpoints must be synchronous.");
    }
    this.#checkpoint = (phase) => {
      const result: unknown = checkpoint?.(phase);
      if (
        result != null &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new TypeError("Identity checkpoints must be synchronous.");
      }
    };
    this.#physicalRoot = physicalStateRoot(this.#root);
    if (ownedRoots.has(this.#physicalRoot)) {
      throw new IdentityTransactionUnavailable();
    }
    ownedRoots.add(this.#physicalRoot);
    try {
      this.#journal = createOwnedPublication<Journal>(
        join(this.#root, "identity-transaction.json"),
        (_value, saved) => {
          this.#saved = saved;
          return undefined;
        },
        undefined,
        this.#root,
      );
      this.#saved = this.#journal.capture();
      this.#assertJournal(this.#saved);
      this.#ready = this.#saved.raw === null;
    } catch (cause) {
      ownedRoots.delete(this.#physicalRoot);
      throw cause;
    }
  }
  close(): void {
    if (this.#closed) return;
    if (
      this.#active || this.#staging || this.#participants.size ||
      (!this.#ready && this.#saved.raw === null)
    ) throw new IdentityTransactionUnavailable();
    this.#closed = true;
    ownedRoots.delete(this.#physicalRoot);
  }
  readonly assertReady = () => {
    assertOperationLease(this.#lease, "live");
    if (this.#closed || !this.#ready || this.#active) {
      throw new IdentityTransactionUnavailable();
    }
    this.#journal.assertUnchanged(this.#saved);
  };
  #assertLiveCall(lease: OperationLease<"live">): void {
    assertOperationLease(lease, "live");
    this.assertReady();
  }
  #stage<T>(run: () => T): T {
    this.#staging++;
    try {
      return run();
    } finally {
      this.#staging--;
    }
  }
  /** Register participants by asking this transaction's exact repositories.
   * A matching pathname is not provenance for another repository's installer. */
  prepareInitial(
    prepared: Readonly<
      { prepared: PreparedAccount; identity: AccountIdentity }
    >,
    everybody: EverybodyLevel,
    expected: AclSnapshot,
    lease: OperationLease<"live">,
    operationId: string,
  ): IdentityParticipants {
    this.#assertLiveCall(lease);
    return this.#stage(() =>
      this.#prepareInitial(prepared, everybody, expected, lease, operationId)
    );
  }
  #prepareInitial(
    prepared: Readonly<
      { prepared: PreparedAccount; identity: AccountIdentity }
    >,
    everybody: EverybodyLevel,
    expected: AclSnapshot,
    lease: OperationLease<"live">,
    operationId: string,
  ): IdentityParticipants {
    const { prepared: candidate, identity: creator } = prepared;
    if (!identity(operationId)) throw new IdentityStateError();
    const access = this.#acl.prepareInitialParticipant(
      creator,
      everybody,
      expected,
      lease,
      operationId,
    );
    return this.#group(
      { kind: "setup", operationId, actorId: creator.id },
      access,
      () =>
        this.#accounts.credentials.prepareAccountParticipant(
          candidate,
          operationId,
        ),
    );
  }
  /** Create-and-add: the target ACL grant is staged first, then the temporary
   * recipient whose committed receipt names that exact grant participant. */
  prepareRecipient(
    acl: AclRepository,
    prepared: Readonly<
      { prepared: PreparedAccount; identity: AccountIdentity }
    >,
    level: AccessLevel,
    expected: AclSnapshot,
    receipt: Readonly<{ actorId: string; payloadHash: string }>,
    lease: OperationLease<"live">,
    operationId: string,
  ): IdentityParticipants {
    this.#assertLiveCall(lease);
    return this.#stage(() => {
      if (acl !== this.#acl || !identity(operationId)) {
        throw new IdentityStateError();
      }
      const { prepared: candidate, identity: recipient } = prepared;
      const { actorId, payloadHash } = receipt;
      const access = this.#acl.prepareGrantParticipant(
        recipient,
        level,
        expected,
        { updateId: operationId, actorId },
        lease,
        operationId,
      );
      return this.#group(
        { kind: "create-and-add", operationId, actorId },
        access,
        () =>
          this.#accounts.credentials.prepareAccountParticipant(
            candidate,
            operationId,
            { acl: access, operationId, actorId, payloadHash },
          ),
      );
    });
  }
  #group(
    decision: Omit<IdentityDecision, "vaultId">,
    access: PublicationParticipant,
    prepareAccount: () => PublicationParticipant,
  ): IdentityParticipants {
    let account: PublicationParticipant;
    try {
      account = prepareAccount();
    } catch (cause) {
      try {
        access.discard();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "Identity participant preparation and cleanup failed.",
          { cause },
        );
      }
      throw cause;
    }
    const binding = {
      decision: Object.freeze({ ...decision, vaultId: this.#acl.vaultId }),
      parts: Object.freeze([access, account]),
      phase: "prepared" as "prepared" | "transferred" | "discarded",
    };
    const group = Object.freeze({
      account,
      access,
      discard: () => {
        if (binding.phase !== "prepared") return;
        const errors: unknown[] = [];
        binding.phase = "discarded";
        for (const part of binding.parts) {
          try {
            part.discard();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          binding.phase = "prepared";
          throw new AggregateError(
            errors,
            "Identity participant cleanup failed.",
          );
        }
        this.#participants.delete(group);
      },
    }) as IdentityParticipants;
    this.#participants.set(group, binding);
    return group;
  }
  #assertJournal(saved: StoredConfigSnapshot): void {
    if (
      physicalStateRoot(this.#root) !== this.#physicalRoot ||
      saved.binding.target !==
        join(this.#physicalRoot, "identity-transaction.json")
    ) {
      throw new IdentityStateError();
    }
  }
  #read(input: unknown): Journal {
    if (
      !record(input) ||
      !fields(input, [
        "version",
        "phase",
        "kind",
        "operationId",
        "actorId",
        "vaultId",
        "participants",
      ]) ||
      input.version !== 1 ||
      (input.phase !== "prepared" && input.phase !== "decided") ||
      (input.kind !== "setup" && input.kind !== "create-and-add") ||
      !identity(input.operationId) || !identity(input.actorId) ||
      input.vaultId !== this.#acl.vaultId ||
      !Array.isArray(input.participants) || input.participants.length !== 2
    ) throw new IdentityStateError();
    const roles = new Set<string>();
    for (const part of input.participants) {
      if (
        !record(part) || (part.role !== "accounts" && part.role !== "access") ||
        roles.has(part.role) || part.setId !== input.operationId ||
        part.root !== this.#root || !record(part.before) ||
        !record(part.after) ||
        !record(part.before.binding) || !record(part.after.binding)
      ) throw new IdentityStateError();
      const filename = part.role === "accounts"
        ? join(this.#root, "accounts.json")
        : join(this.#vaultRoot, "access.json");
      if (
        part.before.binding.configured !== filename ||
        part.after.binding.configured !== filename
      ) throw new IdentityStateError();
      roles.add(part.role);
    }
    return input as unknown as Journal;
  }
  #write(value: Journal, lease: OperationLease<"live">): void {
    const operation = createOperationLease("live", [() => undefined], [
      this.#lease,
      lease,
    ]);
    try {
      const prepared = this.#journal.prepare(
        value,
        this.#saved,
        operation.lease,
      );
      const outcome = prepared.publish();
      if (outcome.state !== "committed") {
        throw new PublicationRecoveryRequired(outcome);
      }
    } finally {
      operation.retire();
    }
  }
  #retire(set: PublicationSet, phase: Journal["phase"]): void {
    assertOperationLease(this.#lease, "live");
    this.#assertJournal(this.#saved);
    this.#journal.assertUnchanged(this.#saved);
    if (this.#saved.raw !== null) {
      this.#checkpoint("retiring");
      // This is the exact domain journal, not a participant or candidate writer.
      this.#journal.assertUnchanged(this.#saved);
      assertOperationLease(this.#lease, "live");
      const binding = this.#saved.binding;
      const absent = {
        raw: null,
        binding: {
          ...binding,
          nodes: binding.nodes.map((node) =>
            node.location === binding.target
              ? { ...node, identity: null }
              : node
          ),
        },
      };
      Deno.removeSync(this.#saved.binding.target);
      this.#saved = absent;
      this.#unlinked = { set, phase };
    }
    if (this.#unlinked) {
      syncOwnedStoredDirectory(dirname(this.#saved.binding.target), this.#root);
      this.#journal.assertUnchanged(this.#saved);
    }
  }
  #discardPrepared(set: PublicationSet): void {
    set.discard(() => this.#retire(set, "prepared"));
    this.#unlinked = undefined;
    this.#ready = true;
  }
  #releaseDecided(set: PublicationSet) {
    this.#retire(set, "decided");
    const unlinked = this.#unlinked;
    this.#unlinked = undefined;
    this.#ready = true;
    this.#active = false;
    try {
      return set.release();
    } catch (cause) {
      this.#unlinked = unlinked;
      throw cause;
    }
  }
  recover(authority: OfflineRecoveryAuthority): void {
    assertOfflineRecovery(authority, this.#root);
    assertOperationLease(this.#lease, "live");
    if (
      this.#closed || this.#active || this.#staging || this.#participants.size
    ) {
      throw new IdentityTransactionUnavailable();
    }
    this.#active = true;
    this.#ready = false;
    const parts: PublicationParticipant[] = [];
    try {
      if (this.#unlinked) {
        const { set, phase } = this.#unlinked;
        if (phase === "prepared") this.#discardPrepared(set);
        else this.#releaseDecided(set);
        return;
      }
      this.#journal.assertUnchanged(this.#saved);
      if (this.#saved.raw === null) {
        this.#ready = true;
        return;
      }
      const value = this.#read(JSON.parse(this.#saved.raw));
      const accessRecord = value.participants.find((p) =>
        record(p) && p.role === "access"
      );
      const accountRecord = value.participants.find((p) =>
        record(p) && p.role === "accounts"
      );
      const access = this.#acl.recoverParticipant(
        accessRecord,
        authority,
        value.operationId,
        value.phase,
      );
      parts.push(access);
      const accounts = this.#accounts.recoverParticipant(
        accountRecord,
        authority,
        value.operationId,
        value.phase,
        access,
      );
      parts.push(accounts);
      const set = createPublicationSet(
        value.operationId,
        parts,
        this.#saved.binding.configured,
      );
      if (value.phase === "prepared") {
        set.validate();
        this.#discardPrepared(set);
      } else {
        set.decide();
        const outcome = set.publish();
        if (outcome.state !== "committed") {
          throw new PublicationRecoveryRequired(outcome);
        }
        this.#releaseDecided(set);
      }
    } catch (cause) {
      this.#ready = false;
      const errors: unknown[] = [cause];
      for (const part of parts) {
        try {
          part.discard();
        } catch (error) {
          errors.push(error);
        }
      }
      throw new IdentityTransactionUnavailable({
        cause: errors.length === 1 ? cause : new AggregateError(
          errors,
          "Recovery admission and release failed.",
          { cause },
        ),
      });
    } finally {
      this.#active = false;
    }
  }
  commit(
    meta: IdentityDecision,
    group: IdentityParticipants,
    lease: OperationLease<"live">,
  ) {
    this.#assertLiveCall(lease);
    const captured = structuredClone(meta);
    const binding = this.#participants.get(group);
    if (
      !binding || binding.phase !== "prepared" ||
      !record(captured) ||
      !fields(captured, ["kind", "operationId", "actorId", "vaultId"]) ||
      Object.entries(binding.decision).some(([key, value]) =>
        captured[key as keyof IdentityDecision] !== value
      )
    ) {
      throw new IdentityStateError();
    }
    this.#active = true;
    this.#ready = false;
    let set: PublicationSet | undefined;
    let decisionAttempted = false;
    try {
      set = createPublicationSet(
        captured.operationId,
        binding.parts,
        this.#saved.binding.configured,
      );
      binding.phase = "transferred";
      this.#participants.delete(group);
      const value = this.#read({
        version: 1,
        phase: "prepared",
        ...captured,
        participants: set.records,
      });
      set.validate();
      this.#write(value, lease);
      this.#checkpoint("prepared");
      set.decide();
      decisionAttempted = true;
      this.#checkpoint("decision-attempt");
      this.#write({ ...value, phase: "decided" }, lease);
      this.#checkpoint("decided");
      const outcome = set.publish();
      if (outcome.state !== "committed") {
        throw new PublicationRecoveryRequired(outcome);
      }
      this.#checkpoint("installed");
      return this.#releaseDecided(set);
    } catch (cause) {
      this.#ready = false;
      if (decisionAttempted) {
        throw new IdentityTransactionUnavailable({ cause });
      }
      try {
        if (set) this.#discardPrepared(set);
        else {
          group.discard();
          this.#ready = true;
        }
      } catch (cleanup) {
        throw new IdentityTransactionUnavailable({
          cause: new AggregateError(
            [cause, cleanup],
            "Identity preparation and cleanup failed.",
            { cause },
          ),
        });
      }
      throw cause;
    } finally {
      this.#active = false;
    }
  }
}
