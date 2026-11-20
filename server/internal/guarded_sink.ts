// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertOperationLease,
  type OperationLease,
  type OperationMode,
} from "../operation_lease.ts";

// Map void to undefined: TypeScript otherwise accepts async () => void.
export type Synchronous<T> = T extends PromiseLike<unknown> ? never
  : [T] extends [void] ? undefined
  : T;
export type Disclosure<T> = T extends (...args: never[]) => unknown ? never
  : Synchronous<T>;

/** Private effect-owner adapter, not a public commit(arbitraryCallback) API.
 * Bind the real consumer once; callers can only submit its data. Preparation
 * and locks belong before this function, never inside the final consumer. */
export function bindGuardedSink<I, O, M extends OperationMode>(
  lease: OperationLease<M>,
  mode: NoInfer<M>,
  consume: (input: I) => Synchronous<O>,
): (input: I) => Synchronous<O> {
  assertOperationLease(lease, mode);
  if (typeof consume !== "function") {
    throw new TypeError("Final operation sink must be callable");
  }
  // Reject an ordinary async callback before it can even begin its effect.
  if (Object.prototype.toString.call(consume) === "[object AsyncFunction]") {
    throw new TypeError("Final operation sink must be synchronous");
  }
  return (input: I): Synchronous<O> => {
    assertOperationLease(lease, mode);
    const value = consume(input);
    // Also reject thenables from untyped JS or a disguised Promise callback.
    // This detects an invalid owner implementation; it cannot undo an effect.
    if (
      value != null && typeof (value as { then?: unknown }).then === "function"
    ) {
      throw new TypeError("Final operation sink must be synchronous");
    }
    return value;
  };
}
