// SPDX-License-Identifier: LGPL-3.0-only
import {
  BoundFileStore,
  type PublicationOutcome,
  PublicationRecoveryRequired,
  type StoredConfigSnapshot,
} from "./file_store.ts";
import type { OperationLease } from "../operation_lease.ts";
import { prepareStoredPublication } from "./internal/publication_port.ts";

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
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
  const store = typeof file === "string" ? new BoundFileStore(file) : file;
  const assertAvailable = () => {
    if (unavailable) throw new PublicationRecoveryRequired(unavailable);
  };
  return Object.freeze({
    assertAvailable,
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
