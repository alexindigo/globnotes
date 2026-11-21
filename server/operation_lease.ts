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
interface IssuedLease {
  readonly parents: readonly IssuedLease[];
  readonly validate: OperationWitness;
  readonly fence: OperationWitness;
}
const issued = new WeakMap<object, IssuedLease>();
function check(root: IssuedLease, operationId?: string): undefined {
  const chain = new Set<IssuedLease>();
  const visit = (owner: IssuedLease) => {
    if (chain.has(owner)) return;
    for (const parent of owner.parents) visit(parent);
    chain.add(owner);
  };
  visit(root);
  for (const owner of chain) owner.fence(operationId);
  for (const owner of chain) owner.validate(operationId);
  // Only pure lifetime fences remain after callbacks and value inspection.
  for (const owner of chain) owner.fence(operationId);
}

/** No effect callback is public on a lease. Only the domain owner holds retire;
 * consumers receive the opaque lease, never a resource/settlement scheduler. */
export function createOperationLease<M extends OperationMode>(
  mode: M,
  witnesses: readonly [OperationWitness, ...OperationWitness[]],
  parents: readonly OperationLease[] = [],
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
  const dependencies = Object.freeze(parents.map((parent) => {
    const dependency = issued.get(parent);
    if (!dependency) {
      throw new TypeError("Operation parent must be an issued lease");
    }
    return dependency;
  }));
  const owner: IssuedLease = {
    parents: dependencies,
    fence: () => {
      scope.assertCurrent();
    },
    validate: (operationId) => {
      for (const witness of captured) {
        if (witness(operationId) !== undefined) {
          throw new TypeError(
            "Operation witnesses must be synchronous assertions",
          );
        }
      }
    },
  };
  const assertCurrent = (operationId?: string): undefined =>
    check(owner, operationId);
  const lease = Object.freeze({
    identity: scope.identity,
    mode,
    assertCurrent,
  }) as OperationLease<M>;
  issued.set(lease, owner);
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
  const owner = issued.get(lease);
  if (!owner || lease.mode !== mode) {
    throw new TypeError("Sink requires an issued operation lease of its mode");
  }
  check(owner, operationId);
}
