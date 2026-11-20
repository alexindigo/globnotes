// SPDX-License-Identifier: LGPL-3.0-only
import type { OperationLease } from "../../operation_lease.ts";
import type {
  PreparedStoredPublication,
  StoredConfigSnapshot,
} from "../file_store.ts";

type Prepare = (
  raw: string,
  expected: StoredConfigSnapshot,
  lease: OperationLease<"live">,
  install: (snapshot: StoredConfigSnapshot) => undefined,
) => PreparedStoredPublication;
// The writer's private method never escapes on its public instance/prototype.
// Only registered modules may acquire this exact-instance preparation port.
const writers = new WeakMap<object, Prepare>();
export function registerPublicationWriter(
  store: object,
  prepare: Prepare,
): void {
  if (writers.has(store)) {
    throw new TypeError("Publication writer already registered.");
  }
  writers.set(store, prepare);
}
export function prepareStoredPublication(
  store: object,
  ...args: Parameters<Prepare>
): PreparedStoredPublication {
  const prepare = writers.get(store);
  if (!prepare) {
    throw new TypeError("Publication requires an issued bound writer.");
  }
  return prepare(...args);
}
