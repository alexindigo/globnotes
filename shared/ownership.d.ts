// SPDX-License-Identifier: LGPL-3.0-only

declare const ownerBrand: unique symbol;
declare const resourceBrand: unique symbol;

/** Stable factory-issued witness, not an allocating projection or authorization. */
export interface OwnerIdentity {
  readonly [ownerBrand]: true;
}

/** Opaque custody handle. Reading value does not grant authority to use it. */
export interface OwnedResource<T> {
  readonly [resourceBrand]: true;
  readonly value: T;
}

export interface OwnershipRelease {
  /** Disposer failures in release order. Allocation failures belong to acquire. */
  readonly errors: readonly unknown[];
  /** Throw the exact primary alone, or an AggregateError with it as cause first. */
  throwIfFailed(...primary: [] | [unknown]): void;
}

export interface OwnershipScope {
  readonly identity: OwnerIdentity;
  readonly retired: boolean;
  /** Pending acquisitions and registered, not-yet-released resources only. */
  readonly size: number;
  assertCurrent(identity?: OwnerIdentity): void;
  /** Synchronous fence. Does not release resources or settle operations. */
  retire(): boolean;
  /** Synchronously reserves future cleanup, without acquiring a resource. A
   * retired owner rejects without invoking the callback. Use adopt for an
   * already-acquired value so rejected adoption can await its rollback. */
  defer(dispose: () => unknown): OwnedResource<undefined>;
  /** Registers immediately; rejected adoption awaits rollback before rejection. */
  adopt<T>(value: T, dispose: (value: T) => unknown): Promise<OwnedResource<T>>;
  /** Reserves custody before calling allocate; late returns roll back on retirement.
   * A rejecting allocator owns its own partial internals, which it never returns. */
  acquire<T>(
    allocate: () => T | PromiseLike<T>,
    dispose: (value: T) => unknown,
  ): Promise<OwnedResource<T>>;
  /** Exactly once, including when concurrent with releaseAll. Foreign/stale handles reject. */
  release<T>(resource: OwnedResource<T>): Promise<void>;
  /** Atomic custody move between live issued owners, invalidating the old handle.
   * Rejected transfer leaves source custody unchanged. */
  transfer<T>(
    resource: OwnedResource<T>,
    target: OwnershipScope,
  ): OwnedResource<T>;
  /** Retires synchronously, then releases in reverse acquisition order, attempting all.
   * Joins pending acquisitions; adds no timeout. Idempotently returns one immutable
   * result. Late rejected adoptions await their own rollback even after this settles.
   * A disposer must not await its own release or its enclosing releaseAll. */
  releaseAll(): Promise<OwnershipRelease>;
}

export class OwnershipError extends Error {}
export function createOwnershipScope(
  options?: { failureMessage?: string },
): OwnershipScope;
