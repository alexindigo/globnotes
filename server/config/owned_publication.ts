// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import {
  BoundFileStore,
  type PublicationOutcome,
  PublicationRecoveryRequired,
  type StoredConfigSnapshot,
} from "./file_store.ts";
import {
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import {
  prepareStoredPublication,
  type RecordedCandidate,
  recordedWriter,
} from "./internal/publication_port.ts";
import {
  PublicationSetUnavailable,
  StoredConfigConflict,
} from "./publication_outcome.ts";
import { createOwnershipScope } from "../../shared/ownership.js";
import {
  matchesPublicationValidation,
  publicationValidation,
  setValidation,
  withPublicationValidation,
} from "../internal/publication_validation.ts";
import {
  assertPublicationPeers,
  registerParticipantCompletion,
  type SettledPublicationSet,
} from "./internal/participant_completion.ts";

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

/** Inspect pending results once and observe rejection without awaiting work that
 * cannot be part of synchronous installation or notification. */
function synchronousResult(value: unknown): void {
  if (value === undefined) return;
  if (
    value !== null && (typeof value === "object" || typeof value === "function")
  ) {
    const then = (value as { then?: unknown }).then;
    if (typeof then === "function") {
      Reflect.apply(then, value, [() => undefined, () => undefined]);
    }
  }
  throw new TypeError("Publication callbacks must finish synchronously.");
}

declare const participantBrand: unique symbol;
export interface PublicationParticipant {
  readonly [participantBrand]: true;
  discard(): void;
}
type SetPhase =
  | "prepared"
  | "decided"
  | "publishing"
  | "installed"
  | "settled"
  | "discarding"
  | "discarded"
  | "recovery-required";
interface SetFence {
  root?: string;
  setId?: string;
  phase: SetPhase;
  decided: boolean;
  validating?: boolean;
  completion?: SettledPublicationSet;
}
interface ParticipantState {
  readonly owner: object;
  readonly decided: boolean;
  readonly candidate: RecordedCandidate;
  readonly install: () => undefined;
  readonly notify: () => undefined;
  readonly writes: WriteReservation;
  available(): void;
  hold(fence: SetFence): void;
  fence?: SetFence;
}
const participants = new WeakMap<PublicationParticipant, ParticipantState>();

interface ReservationJournal {
  readonly path: string;
  readonly members: ReadonlySet<WriteReservation>;
}

/** The registry owns the native write hold, independently of candidate
 * descriptors and participant handles. Recovery can validate a candidate
 * without displacing the current fence; only a complete set can take custody. */
class WriteReservation {
  static readonly #active = new Map<string, WriteReservation>();
  #key: string;
  #release: () => void;
  #fence?: SetFence;
  #validatingRecovery = false;
  #record?: RecordedCandidate["record"];
  #journal?: ReservationJournal;

  private constructor(key: string, release: () => void, fence?: SetFence) {
    this.#key = key;
    this.#release = release;
    this.#fence = fence;
  }

  static claim(
    expected: StoredConfigSnapshot,
    setId: string,
    role: string,
    fence: SetFence | undefined,
    acquire: () => () => void,
    record?: RecordedCandidate["record"],
  ): WriteReservation {
    const key = JSON.stringify([expected.binding.target, setId, role]);
    const existing = this.#active.get(key);
    if (existing) {
      const original = existing.#record;
      if (
        !record || !original || record.root !== original.root ||
        record.candidate !== original.candidate ||
        record.before.raw !== original.before.raw ||
        record.after.raw !== original.after.raw || !existing.canRecover()
      ) throw new PublicationSetUnavailable();
      return existing;
    }
    const writes = new WriteReservation(key, acquire(), fence);
    writes.#record = record;
    this.#active.set(key, writes);
    return writes;
  }

  record(candidate: RecordedCandidate) {
    this.#record = candidate.record;
  }

  ownedBy(fence: SetFence): boolean {
    return this.#fence === fence && this.#isActive() &&
      !this.#validatingRecovery;
  }

  #isActive(): boolean {
    return WriteReservation.#active.get(this.#key) === this;
  }

  canRecover(): boolean {
    return this.#isActive() && !this.#validatingRecovery &&
      !this.#fence?.validating &&
      (!this.#fence ||
        ["prepared", "decided", "installed", "recovery-required"].includes(
          this.#fence.phase,
        ));
  }

  validateRecovery<T>(validate: () => T): T {
    this.#validatingRecovery = true;
    try {
      return validate();
    } finally {
      this.#validatingRecovery = false;
    }
  }

  acceptsJournal(journal: ReservationJournal): boolean {
    const previous = this.#journal;
    return !previous || (previous.path === journal.path &&
      previous.members.size === journal.members.size &&
      [...previous.members].every((member) => journal.members.has(member)));
  }

  seal(fence: SetFence, journal: ReservationJournal) {
    this.#fence = fence;
    this.#journal = journal;
  }

  release(fence: SetFence) {
    if (!this.ownedBy(fence)) throw new PublicationSetUnavailable();
    this.#release();
    WriteReservation.#active.delete(this.#key);
  }
}

function journalRetired(filename: string): boolean {
  try {
    Deno.lstatSync(filename);
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
}

/** Storage set protocol only. Its trusted caller owns journal publication,
 * logical decision, registration/exclusion and durable journal retirement. Bind
 * its configured journal now so release cannot mistake another path for it. */
export function createPublicationSet(
  setId: string,
  handles: readonly PublicationParticipant[],
  journalPath: string,
) {
  if (typeof journalPath !== "string" || !journalPath) {
    throw new TypeError("Publication set requires a configured journal path.");
  }
  const journal = resolve(journalPath);
  if (!Array.isArray(handles)) {
    throw new TypeError("Publication set requires an array.");
  }
  const capturedHandles = Array.from(handles);
  const entries = capturedHandles.map((handle) => participants.get(handle));
  if (!entries.length || entries.some((entry) => !entry || entry.fence)) {
    throw new TypeError("Publication set requires unused issued participants.");
  }
  const members = entries as ParticipantState[];
  assertPublicationPeers(capturedHandles);
  for (const member of members) member.available();
  const records = members.map((m) => m.candidate.record);
  const binding: ReservationJournal = {
    path: journal,
    members: new Set(members.map((member) => member.writes)),
  };
  if (
    records.some((r) => r.setId !== setId) ||
    new Set(records.map((r) => r.role)).size !== members.length ||
    new Set(records.map((r) => r.after.binding.target)).size !==
      members.length ||
    new Set(members.map((m) => m.owner)).size !== members.length ||
    members.some((m) =>
      m.decided !== members[0].decided || !m.writes.acceptsJournal(binding)
    )
  ) {
    throw new StoredConfigConflict();
  }
  const lifetime = createOwnershipScope();
  const fence: SetFence = { phase: "prepared", decided: members[0].decided };
  const validation = setValidation(fence);
  fence.completion = Object.freeze({
    identity: lifetime.identity,
    members: Object.freeze(capturedHandles),
  });
  for (const member of members) {
    member.fence = fence;
    member.writes.seal(fence, binding);
    member.hold(fence);
  }
  const ownsWrites = () => members.every((m) => m.writes.ownedBy(fence));
  let warning = false, notificationFailed = false;
  const receipt = (
    state: "committed" | "recovery-required",
  ): PublicationOutcome =>
    Object.freeze({
      operation: lifetime.identity,
      committed: true,
      state,
      warning: warning ? "stored-durability-unconfirmed" : null,
      notificationFailed,
    });
  const validate = () => {
    if (fence.phase !== "prepared" || fence.validating || !ownsWrites()) {
      throw new PublicationSetUnavailable();
    }
    fence.validating = true;
    try {
      // All authority callbacks precede ALL set storage checks, followed by the
      // shared lease engine's final pure lifetime fences. Per-member lease checks
      // here would allow a later parent's witness to alter an earlier member.
      const check = withPublicationValidation(
        validation,
        () =>
          createOperationLease("live", [() => {
            for (const member of members) member.candidate.validateStorage();
            return undefined;
          }], members.map((member) => member.candidate.authority)),
      );
      check.retire();
    } catch (error) {
      if (fence.decided) fence.phase = "recovery-required";
      throw error;
    } finally {
      fence.validating = false;
    }
    if (fence.phase !== "prepared") throw new PublicationSetUnavailable();
  };
  return Object.freeze({
    records: Object.freeze(records),
    validate,
    decide() {
      validate();
      // Transfer before attempting the domain's durable decision. An uncertain
      // decision is resolved from its journal, never by ordinary scope cleanup.
      fence.decided = true;
      fence.phase = "decided";
    },
    publish(): PublicationOutcome {
      if (fence.phase !== "decided" || !ownsWrites()) {
        throw new PublicationSetUnavailable();
      }
      fence.phase = "publishing";
      try {
        for (const member of members) {
          warning = withPublicationValidation(validation, () =>
            member.candidate.apply()).warning || warning;
        }
        for (const member of members) {
          synchronousResult(member.install());
        }
        fence.phase = "installed";
        return receipt("committed");
      } catch {
        fence.phase = "recovery-required";
        return receipt("recovery-required");
      }
    },
    release(): PublicationOutcome {
      if (
        fence.phase !== "installed" || !ownsWrites() || !journalRetired(journal)
      ) {
        throw new PublicationSetUnavailable();
      }
      // Required runtime installation is complete and the bound journal is
      // absent. The transaction owns confirmation of durable retirement.
      fence.phase = "settled";
      for (const member of members) member.writes.release(fence);
      lifetime.retire();
      for (const member of members) {
        try {
          synchronousResult(member.notify());
        } catch {
          notificationFailed = true;
        }
      }
      return receipt("committed");
    },
    discard() {
      if (fence.decided || fence.phase === "discarding" || !ownsWrites()) {
        return;
      }
      const errors: unknown[] = [];
      // Revoke synchronously without admitting recovery during cleanup.
      fence.phase = "discarding";
      for (const member of members) {
        try {
          member.candidate.discard();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        fence.phase = "recovery-required";
        throw new AggregateError(errors, "Publication set cleanup failed.");
      }
      fence.phase = "discarded";
      for (const member of members) member.writes.release(fence);
      lifetime.retire();
    },
  });
}

/** Internal metadata owner binding. Installation is bound once, never supplied
 * by an operation's consumer. It includes required runtime/permission state,
 * without reentrant observers; notify is only an optional observer afterwards.
 * Consumers fence reads through assertAvailable after installation failure.
 * This is not an HTTP authority, durable idempotency ledger or transaction owner. */
export function createOwnedPublication<T>(
  file: BoundFileStore | string,
  install: (value: T, persistence: StoredConfigSnapshot) => undefined,
  notify: () => undefined = () => undefined,
  root?: string,
) {
  for (const callback of [install, notify]) {
    if (
      typeof callback !== "function" ||
      Object.prototype.toString.call(callback) === "[object AsyncFunction]"
    ) {
      throw new TypeError("Publication callbacks must be synchronous.");
    }
  }
  let unavailable: PublicationOutcome | undefined;
  let held: SetFence | undefined;
  const ownerIdentity = {};
  const store = typeof file === "string"
    ? new BoundFileStore(file, root)
    : file;
  const assertAvailable = () => {
    if (unavailable) throw new PublicationRecoveryRequired(unavailable);
    if (held && held.phase !== "settled" && held.phase !== "discarded") {
      throw new PublicationSetUnavailable();
    }
  };
  const participant = (
    candidate: RecordedCandidate,
    captured: T,
    reservation: SetFence,
    writes: WriteReservation,
    recovered = false,
  ): PublicationParticipant => {
    const state: ParticipantState = {
      owner: ownerIdentity,
      decided: reservation.decided,
      candidate,
      install: () => install(captured, candidate.record.after),
      notify,
      writes,
      available: () => {
        if (
          unavailable || held !== reservation ||
          reservation.phase !== "prepared" ||
          !(recovered ? writes.canRecover() : writes.ownedBy(reservation))
        ) throw new PublicationSetUnavailable();
      },
      hold: (fence) => {
        held = fence;
      },
    };
    const handle = Object.freeze({
      discard() {
        if (
          state.fence || reservation.phase === "discarding" ||
          (!recovered && !writes.ownedBy(reservation))
        ) return;
        reservation.phase = "discarding";
        try {
          // A sibling's failed recovery must never delete a journal participant.
          if (recovered) candidate.detach();
          else candidate.discard();
        } finally {
          reservation.phase = "recovery-required";
        }
        if (!recovered) {
          reservation.phase = "discarded";
          writes.release(reservation);
        }
      },
    }) as PublicationParticipant;
    participants.set(handle, state);
    registerParticipantCompletion(handle, () => {
      if (state.fence?.phase !== "settled" || !state.fence.completion) {
        throw new PublicationSetUnavailable();
      }
      assertAvailable();
      // A settled historical set is not authority to disclose a later account
      // or ACL replacement. Recheck the exact published binding as well.
      store.assertUnchanged(candidate.record.after);
      return state.fence.completion;
    });
    return handle;
  };
  return Object.freeze({
    assertAvailable,
    assertValidationAvailable(context: object | undefined) {
      if (unavailable) throw new PublicationRecoveryRequired(unavailable);
      if (held && held.phase !== "settled" && held.phase !== "discarded") {
        if (
          !matchesPublicationValidation(context, held, held.root, held.setId) ||
          !["prepared", "decided", "publishing"].includes(held.phase)
        ) throw new PublicationSetUnavailable();
        return true;
      }
      return false;
    },
    prepareParticipant(
      value: T,
      expected: StoredConfigSnapshot,
      lease: OperationLease<"live">,
      setId: string,
      role: string,
    ) {
      assertAvailable();
      const captured = immutable(structuredClone(value));
      const raw = JSON.stringify(captured) + "\n";
      assertAvailable();
      const reservation: SetFence = {
        phase: "prepared",
        decided: false,
        root: store.root,
        setId,
      };
      const validation = publicationValidation(store.root, setId);
      const writer = recordedWriter(store);
      const writes = WriteReservation.claim(
        expected,
        setId,
        role,
        reservation,
        () => writer.reserveOrdinaryWrites(expected),
      );
      held = reservation;
      let candidate: RecordedCandidate;
      try {
        candidate = withPublicationValidation(
          validation,
          () => writer.prepare(raw, expected, lease, setId, role),
        );
      } catch (error) {
        held = undefined;
        writes.release(reservation);
        throw error;
      }
      writes.record(candidate);
      try {
        return participant(candidate, captured, reservation, writes);
      } catch (error) {
        reservation.phase = "recovery-required";
        try {
          candidate.discard();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Participant preparation and cleanup failed.",
            { cause: error },
          );
        }
        held = undefined;
        writes.release(reservation);
        throw error;
      }
    },
    recoverParticipant(
      input: unknown,
      authority: object,
      setId: string,
      role: string,
      validate: (value: unknown) => T,
      decision: "prepared" | "decided",
    ) {
      assertAvailable();
      if (decision !== "prepared" && decision !== "decided") {
        throw new TypeError("Recovery requires the recorded decision phase.");
      }
      const reservation: SetFence = {
        phase: "prepared",
        decided: decision === "decided",
      };
      held = reservation;
      let candidate: RecordedCandidate;
      const writer = recordedWriter(store);
      try {
        candidate = writer.recover(input, authority, setId, role);
      } catch (error) {
        reservation.phase = "recovery-required";
        throw error;
      }
      try {
        const writes = WriteReservation.claim(
          candidate.record.after,
          setId,
          role,
          undefined,
          () => writer.reserveOrdinaryWrites(candidate.record.after),
          candidate.record,
        );
        return writes.validateRecovery(() => {
          const captured = immutable(
            structuredClone(validate(JSON.parse(candidate.record.after.raw!))),
          );
          // Recovery installs the exact recorded representation.
          if (JSON.stringify(captured) + "\n" !== candidate.record.after.raw) {
            throw new StoredConfigConflict();
          }
          return participant(candidate, captured, reservation, writes, true);
        });
      } catch (error) {
        // Recovery owns a descriptor but an unaccepted record must not be
        // discarded: a decided journal may still need its exact candidate.
        try {
          candidate.detach();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Recovery admission and descriptor release failed.",
            { cause: error },
          );
        } finally {
          reservation.phase = "recovery-required";
        }
        throw error;
      }
    },
    capture() {
      assertAvailable();
      return store.capture();
    },
    assertUnchanged(expected: StoredConfigSnapshot) {
      assertAvailable();
      store.assertUnchanged(expected);
    },
    prepareParents(expected: StoredConfigSnapshot) {
      assertAvailable();
      return store.prepareParents(expected);
    },
    prepare(
      value: T,
      expected: StoredConfigSnapshot,
      lease: OperationLease<"live">,
    ) {
      assertAvailable();
      const captured = immutable(structuredClone(value));
      const prepared = prepareStoredPublication(
        store,
        JSON.stringify(captured) + "\n",
        expected,
        lease,
        (persistence) => {
          try {
            if (install(captured, persistence) !== undefined) {
              throw new TypeError(
                "Publication installation must be synchronous.",
              );
            }
          } catch {
            // This callback runs only after the actual link/rename. Fence old
            // runtime state now, before cleanup diagnostics can reenter readers.
            unavailable = Object.freeze({
              operation: lease.identity,
              committed: true,
              state: "recovery-required",
              warning: null,
              notificationFailed: false,
            });
            throw new PublicationRecoveryRequired(unavailable);
          }
          return undefined;
        },
      );
      return Object.freeze({
        discard: prepared.discard,
        publish(): PublicationOutcome {
          try {
            assertAvailable();
          } catch (error) {
            try {
              prepared.discard();
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                "Publication rejection and cleanup failed.",
                { cause: error },
              );
            }
            throw error;
          }
          const outcome = prepared.publish();
          if (outcome.state === "recovery-required") {
            unavailable = outcome;
            return outcome;
          }
          try {
            if (notify() !== undefined) {
              throw new TypeError("Asynchronous observer");
            }
            return outcome;
          } catch {
            return Object.freeze({ ...outcome, notificationFailed: true });
          }
        },
      });
    },
  });
}
