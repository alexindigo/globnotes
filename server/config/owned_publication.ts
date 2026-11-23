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
  | "discarded"
  | "recovery-required";
interface SetFence {
  root?: string;
  setId?: string;
  phase: SetPhase;
  decided: boolean;
}
interface ParticipantState {
  readonly owner: object;
  readonly decided: boolean;
  readonly candidate: RecordedCandidate;
  readonly install: () => undefined;
  readonly notify: () => undefined;
  readonly releaseWrites: () => void;
  available(): void;
  hold(fence: SetFence): void;
  fence?: SetFence;
}
const participants = new WeakMap<PublicationParticipant, ParticipantState>();

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
  const entries = Array.from(handles, (handle) => participants.get(handle));
  if (!entries.length || entries.some((entry) => !entry || entry.fence)) {
    throw new TypeError("Publication set requires unused issued participants.");
  }
  const members = entries as ParticipantState[];
  for (const member of members) member.available();
  const records = members.map((m) => m.candidate.record);
  if (
    records.some((r) => r.setId !== setId) ||
    new Set(records.map((r) => r.role)).size !== members.length ||
    new Set(records.map((r) => r.after.binding.target)).size !==
      members.length ||
    new Set(members.map((m) => m.owner)).size !== members.length ||
    members.some((m) => m.decided !== members[0].decided)
  ) {
    throw new StoredConfigConflict();
  }
  const lifetime = createOwnershipScope();
  const fence: SetFence = { phase: "prepared", decided: members[0].decided };
  const validation = setValidation(fence);
  for (const member of members) {
    member.fence = fence;
    member.hold(fence);
  }
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
  let validating = false;
  let cleaning = false;
  const validate = () => {
    if (fence.phase !== "prepared" || validating) {
      throw new PublicationSetUnavailable();
    }
    validating = true;
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
    } finally {
      validating = false;
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
      if (fence.phase !== "decided") throw new PublicationSetUnavailable();
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
      if (fence.phase !== "installed" || !journalRetired(journal)) {
        throw new PublicationSetUnavailable();
      }
      // Required runtime installation is complete and the bound journal is
      // absent. The transaction owns confirmation of durable retirement.
      fence.phase = "settled";
      for (const member of members) member.releaseWrites();
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
      if (fence.decided) return;
      if (validating) {
        // Revocation is synchronous even when a validation witness reenters.
        fence.phase = "discarded";
      }
      const errors: unknown[] = [];
      fence.phase = "recovery-required";
      if (cleaning) return;
      cleaning = true;
      try {
        for (const member of members) {
          try {
            member.candidate.discard();
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        cleaning = false;
      }
      if (errors.length) {
        throw new AggregateError(errors, "Publication set cleanup failed.");
      }
      fence.phase = "discarded";
      for (const member of members) member.releaseWrites();
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
    releaseWrites: () => void,
    recovered = false,
  ): PublicationParticipant => {
    const state: ParticipantState = {
      owner: ownerIdentity,
      decided: reservation.decided,
      candidate,
      install: () => install(captured, candidate.record.after),
      notify,
      releaseWrites,
      available: () => {
        if (
          unavailable || held !== reservation ||
          reservation.phase !== "prepared"
        ) throw new PublicationSetUnavailable();
      },
      hold: (fence) => {
        held = fence;
      },
    };
    const handle = Object.freeze({
      discard() {
        if (state.fence) return; // Set custody is no longer ordinary scratch.
        reservation.phase = "recovery-required";
        // Before the whole recovery set is admitted, release read custody only.
        // A sibling's failed recovery must never delete a journal participant.
        if (recovered) candidate.detach();
        else candidate.discard();
        if (!recovered) {
          reservation.phase = "discarded";
          releaseWrites();
        }
      },
    }) as PublicationParticipant;
    participants.set(handle, state);
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
      const releaseWrites = writer.reserveOrdinaryWrites(expected);
      held = reservation;
      let candidate: RecordedCandidate;
      try {
        candidate = withPublicationValidation(
          validation,
          () => writer.prepare(raw, expected, lease, setId, role),
        );
      } catch (error) {
        held = undefined;
        releaseWrites();
        throw error;
      }
      try {
        return participant(candidate, captured, reservation, releaseWrites);
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
        releaseWrites();
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
        const releaseWrites = writer.reserveOrdinaryWrites(
          candidate.record.after,
        );
        const captured = immutable(
          structuredClone(validate(JSON.parse(candidate.record.after.raw!))),
        );
        // Validation must not silently normalize recorded bytes into a different
        // runtime value. Recovery installs the exact recorded representation.
        if (JSON.stringify(captured) + "\n" !== candidate.record.after.raw) {
          throw new StoredConfigConflict();
        }
        return participant(
          candidate,
          captured,
          reservation,
          releaseWrites,
          true,
        );
      } catch (error) {
        reservation.phase = "recovery-required";
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
