// SPDX-License-Identifier: LGPL-3.0-only
import {
  createOwnershipScope,
  type OwnerIdentity,
} from "../shared/ownership.js";

/** The domain owner chooses witnesses. Modes do not evaluate authority or share
 * cancellation: an outcome/recovery owner is not permission for another write. */
export type OperationMode = "live" | "retained" | "outcome" | "recovery";
declare const operationBrand: unique symbol;
export interface OperationLease<M extends OperationMode = OperationMode> {
  readonly [operationBrand]: true;
  readonly identity: OwnerIdentity;
  readonly mode: M;
  assertCurrent(operationId?: string): void;
}
export type OperationWitness = (operationId?: string) => undefined;
const issued = new WeakMap<object, OperationWitness>();

/** No effect callback is public on a lease. Only the domain owner holds retire;
 * consumers receive the opaque lease, never a resource/settlement scheduler. */
export function createOperationLease<M extends OperationMode>(
  mode: M,
  witnesses: readonly [OperationWitness, ...OperationWitness[]],
): Readonly<{ lease: OperationLease<M>; retire(): boolean }> {
  if (!["live", "retained", "outcome", "recovery"].includes(mode)) {
    throw new TypeError("Unknown operation lease mode");
  }
  const captured = Object.freeze([...witnesses]);
  if (!captured.length || captured.some((w) => typeof w !== "function")) {
    throw new TypeError("Operation lease requires captured owner witnesses");
  }
  if (
    captured.some((witness) =>
      Object.prototype.toString.call(witness) === "[object AsyncFunction]"
    )
  ) {
    throw new TypeError("Operation witnesses must be synchronous");
  }
  const scope = createOwnershipScope();
  const assertCurrent = (operationId?: string): undefined => {
    scope.assertCurrent();
    for (const witness of captured) {
      if (witness(operationId) !== undefined) {
        throw new TypeError(
          "Operation witnesses must be synchronous assertions",
        );
      }
    }
    // Witnesses can synchronously retire their own owner.
    scope.assertCurrent();
  };
  const lease = Object.freeze({
    identity: scope.identity,
    mode,
    assertCurrent,
  }) as OperationLease<M>;
  issued.set(lease, assertCurrent);
  assertCurrent();
  return Object.freeze({ lease, retire: scope.retire });
}

/** Internal sink validation. Import topology is protected by the ownership
 * contract: importing a facade does not permit constructing an unchecked sink. */
export function assertOperationLease<M extends OperationMode>(
  lease: OperationLease<M>,
  mode: NoInfer<M>,
  operationId?: string,
): void {
  const check = issued.get(lease);
  if (!check || lease.mode !== mode) {
    throw new TypeError("Sink requires an issued operation lease of its mode");
  }
  check(operationId);
}
