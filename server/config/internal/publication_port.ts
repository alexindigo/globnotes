// SPDX-License-Identifier: LGPL-3.0-only
import type { OperationLease } from "../../operation_lease.ts";
import type {
  PreparedStoredPublication,
  StoredConfigSnapshot,
} from "../file_store.ts";

/** Durable data is not a live capability. Only the private writer can admit it
 * again, under an issued exclusive recovery owner for this root. */
export interface RecordedCandidateData {
  readonly version: 1;
  readonly setId: string;
  readonly role: string;
  readonly root: string;
  readonly before: StoredConfigSnapshot;
  readonly after: StoredConfigSnapshot;
  readonly candidate: string;
}
export interface RecordedCandidate {
  readonly record: RecordedCandidateData;
  readonly authority: OperationLease<"live"> | OperationLease<"recovery">;
  validateStorage(): void;
  validate(): void;
  apply(): {
    readonly snapshot: StoredConfigSnapshot;
    readonly warning: boolean;
  };
  discard(): void;
  detach(): void;
}
interface NativeRecordedWriter {
  prepare(
    raw: string,
    expected: StoredConfigSnapshot,
    lease: OperationLease<"live">,
    setId: string,
    role: string,
  ): RecordedCandidate;
  recover(
    input: unknown,
    lease: OperationLease<"recovery">,
    setId: string,
    role: string,
  ): RecordedCandidate;
}
const recordedWriters = new WeakMap<
  object,
  { root: string; writer: NativeRecordedWriter }
>();
const recoveryOwners = new WeakMap<object, {
  root: string;
  lease: OperationLease<"recovery">;
}>();

/** Called only by the actual exclusive offline owner, not ordinary consumers. */
export function registerPublicationRecovery(
  authority: object,
  root: string,
  lease: OperationLease<"recovery">,
): void {
  if (recoveryOwners.has(authority)) {
    throw new TypeError("Recovery already bound.");
  }
  recoveryOwners.set(authority, { root, lease });
}
export function registerRecordedWriter(
  store: object,
  root: string,
  writer: NativeRecordedWriter,
): void {
  if (recordedWriters.has(store)) {
    throw new TypeError("Recorded writer already bound.");
  }
  recordedWriters.set(store, { root, writer });
}
export function recordedWriter(store: object) {
  const binding = recordedWriters.get(store);
  if (!binding) {
    throw new TypeError("Recorded publication requires an issued writer.");
  }
  return Object.freeze({
    prepare: binding.writer.prepare,
    recover(input: unknown, authority: object, setId: string, role: string) {
      return binding.writer.recover(
        input,
        publicationRecoveryLease(authority, binding.root),
        setId,
        role,
      );
    },
  });
}
function publicationRecoveryLease(authority: object, root: string) {
  const owner = recoveryOwners.get(authority);
  if (!owner || owner.root !== root) {
    throw new TypeError(
      "Publication recovery requires the exclusive root owner.",
    );
  }
  return owner.lease;
}

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
