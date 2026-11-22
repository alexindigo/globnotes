// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertOperationLease,
  type OperationLease,
  type OperationMode,
} from "../operation_lease.ts";

export type Synchronous<T> = T extends PromiseLike<unknown> ? never
  : [T] extends [void] ? undefined
  : T;
export type Disclosure<T> = T extends (...args: never[]) => unknown ? never
  : Synchronous<T>;

/** Completion of inspection is distinct from the payload, which may be thenable. */
interface Inspection<T> {
  readonly value: T;
  readonly then?: never;
}

/** Inspection may run getters. Delivery is a private synchronous native effect,
 * bound by the owner, never supplied by a public caller. No result or value
 * inspection is permitted after the final owner fences. Inspectors return plain
 * envelopes; delivery unwraps their data property without inspecting the payload. */
export function bindGuardedSink<I, V, M extends OperationMode>(
  lease: OperationLease<M>,
  mode: NoInfer<M>,
  inspect: (input: I) => Inspection<V>,
  deliver: (prepared: Inspection<V>) => undefined,
): (input: I) => void {
  assertOperationLease(lease, mode);
  if (typeof inspect !== "function" || typeof deliver !== "function") {
    throw new TypeError("Final operation sink must be callable");
  }
  if (
    Object.prototype.toString.call(inspect) === "[object AsyncFunction]" ||
    Object.prototype.toString.call(deliver) === "[object AsyncFunction]"
  ) {
    throw new TypeError("Final operation sink must be synchronous");
  }
  return (input) => {
    const prepared = inspect(input);
    if (
      !prepared || typeof prepared !== "object" ||
      typeof prepared.then === "function" || !("value" in prepared)
    ) {
      throw new TypeError("Final operation sink must be synchronous");
    }
    // A caller-owned envelope can have a getter too. Capture it before checking;
    // delivery sees only this inert own data property, never a reentrant accessor.
    const inspected = Object.freeze({ value: prepared.value });
    assertOperationLease(lease, mode);
    deliver(inspected);
  };
}
