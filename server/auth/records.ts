// SPDX-License-Identifier: LGPL-3.0-only
import {
  PublicationRecoveryRequired,
  StoredConfigConflict,
} from "../config/publication_outcome.ts";
import type { StoredConfigSnapshot } from "../config/file_store.ts";
import { createOwnedPublication } from "../config/owned_publication.ts";
import {
  createOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import { registerAuthorityReader } from "./internal/authority_read.ts";

export class IdentityStateError extends Error {
  constructor() {
    super("Invalid identity state; original bytes retained.");
  }
}
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export const identity = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function fields(
  value: Record<string, unknown>,
  names: string[],
): boolean {
  return Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export interface IdentitySnapshot<T> {
  readonly value: T;
  readonly persistence: StoredConfigSnapshot;
}

/** Internal validated JSON boundary, sharing configuration's bound-file CAS.
 * It never repairs invalid bytes or publishes a prospective write early. */
export class IdentityFile<T> {
  readonly #publication;
  #snapshot: IdentitySnapshot<T>;
  constructor(
    filename: string,
    readonly validate: (value: unknown) => T,
    empty: T,
    notify: () => undefined = () => undefined,
    publicationRoot?: string,
  ) {
    this.#publication = createOwnedPublication<T>(
      filename,
      (value, persistence) => {
        this.#snapshot = Object.freeze({ value, persistence });
        return undefined;
      },
      notify,
      publicationRoot,
    );
    const persistence = this.#publication.capture();
    let value: T;
    try {
      value = validate(
        persistence.raw === null ? empty : JSON.parse(persistence.raw),
      );
    } catch {
      throw new IdentityStateError();
    }
    this.#snapshot = freeze({ value: structuredClone(value), persistence });
    registerAuthorityReader(this, (context) => {
      if (!this.#publication.assertValidationAvailable(context)) {
        this.#publication.assertUnchanged(this.#snapshot.persistence);
      }
      return this.#snapshot;
    });
  }
  capture(): IdentitySnapshot<T> {
    this.#publication.assertAvailable();
    return this.#snapshot;
  }
  assertUnchanged(expected: IdentitySnapshot<T> = this.capture()): void {
    this.#publication.assertAvailable();
    if (expected !== this.#snapshot) throw new StoredConfigConflict();
    this.#publication.assertUnchanged(expected.persistence);
  }
  prepareParents(): void {
    this.#publication.assertAvailable();
    const before = this.#snapshot;
    const persistence = this.#publication.prepareParents(before.persistence);
    this.#snapshot = freeze({ value: before.value, persistence });
  }
  prepareParticipant(
    next: T,
    expected: IdentitySnapshot<T>,
    lease: OperationLease<"live">,
    setId: string,
    role: string,
  ) {
    const value = freeze(structuredClone(this.validate(next)));
    this.assertUnchanged(expected);
    return this.#publication.prepareParticipant(
      value,
      expected.persistence,
      lease,
      setId,
      role,
    );
  }
  recoverParticipant(
    input: unknown,
    authority: object,
    setId: string,
    role: string,
    decision: "prepared" | "decided",
  ) {
    return this.#publication.recoverParticipant(
      input,
      authority,
      setId,
      role,
      this.validate,
      decision,
    );
  }
  commit(
    next: T,
    expected: IdentitySnapshot<T> = this.capture(),
    guard: () => void = () => {},
    parents: readonly OperationLease<"live">[] = [],
  ): T {
    if (Object.prototype.toString.call(guard) === "[object AsyncFunction]") {
      throw new TypeError("Identity guards must be synchronous.");
    }
    const value = freeze(structuredClone(this.validate(next)));
    // Compatibility caller assertions become captured witnesses, not a no-op
    // lease default on the owned writer. This is storage authority, not HTTP.
    const operation = createOperationLease("live", [() => {
      this.assertUnchanged(expected);
      // void callers may return ordinary values. Only pending completion is
      // forbidden: the witness must finish before the writer's final fences.
      const result: unknown = guard();
      if (
        result != null &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new TypeError("Identity guards must be synchronous.");
      }
      return undefined;
    }], parents);
    try {
      const prepared = this.#publication.prepare(
        value,
        expected.persistence,
        operation.lease,
      );
      const outcome = prepared.publish();
      if (outcome.state === "recovery-required") {
        throw new PublicationRecoveryRequired(outcome);
      }
      return this.#snapshot.value;
    } finally {
      operation.retire();
    }
  }
}
