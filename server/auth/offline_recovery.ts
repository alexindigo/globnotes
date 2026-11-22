// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import { acquireIdentityOwnership } from "./ownership.ts";
import { IdentityStateError } from "./records.ts";
import { registerPublicationRecovery } from "../config/internal/publication_port.ts";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";

declare const recoveryBrand: unique symbol;
export interface OfflineRecoveryAuthority {
  readonly [recoveryBrand]: true;
}
const issued = new WeakMap<
  OfflineRecoveryAuthority,
  { root: string; lease: OperationLease<"recovery"> }
>();

/** Offline integration only. P01 forbids acquisition from ordinary HTTP code.
 * There is no callback/boolean substitute for the actual exclusive lock. */
export function acquireOfflineRecovery(root: string) {
  const canonical = resolve(root);
  const ownership = acquireIdentityOwnership(canonical);
  try {
    const operation = createOperationLease("recovery", [() => {
      ownership.assertCurrent();
      return undefined;
    }]);
    const authority = Object.freeze({}) as OfflineRecoveryAuthority;
    issued.set(
      authority,
      Object.freeze({ root: canonical, lease: operation.lease }),
    );
    registerPublicationRecovery(authority, canonical, operation.lease);
    return Object.freeze({
      authority,
      close() {
        operation.retire();
        ownership.close();
      },
    });
  } catch (error) {
    ownership.close();
    throw error;
  }
}

/** Private aggregate integration: validates provenance, root and lock lifetime. */
export function assertOfflineRecovery(
  authority: OfflineRecoveryAuthority,
  root: string,
): OperationLease<"recovery"> {
  const binding = issued.get(authority);
  if (!binding || binding.root !== resolve(root)) {
    throw new IdentityStateError();
  }
  assertOperationLease(binding.lease, "recovery");
  return binding.lease;
}
