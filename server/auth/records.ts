// SPDX-License-Identifier: LGPL-3.0-only
import {
  BoundFileStore,
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "../config/file_store.ts";

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
  readonly #file: BoundFileStore;
  #snapshot: IdentitySnapshot<T>;
  constructor(
    filename: string,
    readonly validate: (value: unknown) => T,
    empty: T,
  ) {
    this.#file = new BoundFileStore(filename);
    const persistence = this.#file.capture();
    let value: T;
    try {
      value = validate(
        persistence.raw === null ? empty : JSON.parse(persistence.raw),
      );
    } catch {
      throw new IdentityStateError();
    }
    this.#snapshot = freeze({ value: structuredClone(value), persistence });
  }
  capture(): IdentitySnapshot<T> {
    return this.#snapshot;
  }
  assertUnchanged(expected: IdentitySnapshot<T> = this.capture()): void {
    if (expected !== this.#snapshot) throw new StoredConfigConflict();
    this.#file.assertUnchanged(expected.persistence);
  }
  prepareParents(): void {
    const before = this.#snapshot;
    const persistence = this.#file.prepareParents(before.persistence);
    this.#snapshot = freeze({ value: before.value, persistence });
  }
  commit(
    next: T,
    expected: IdentitySnapshot<T> = this.capture(),
    guard: () => void = () => {},
  ): T {
    const value = freeze(structuredClone(this.validate(next)));
    this.assertUnchanged(expected);
    guard();
    this.#file.replace(
      JSON.stringify(value) + "\n",
      expected.persistence,
      () => {
        const persistence = this.#file.capture();
        if (persistence.raw !== JSON.stringify(value) + "\n") {
          throw new StoredConfigConflict();
        }
        this.#snapshot = freeze({ value, persistence });
      },
    );
    return this.#snapshot.value;
  }
}
