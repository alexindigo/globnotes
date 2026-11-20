// SPDX-License-Identifier: LGPL-3.0-only
import {
  createOwnershipScope,
  type OwnerIdentity,
} from "../../shared/ownership.js";

/** Private construction implementation. Public scenarios enter via fixture_scope.ts.
 * Allocation is reserved before invocation;
 * constructors must register each partial resource, not return an opaque factory.
 * LIFO ordering puts held-gate release before work join and runtimes before roots.
 */
export interface FixtureScope {
  readonly identity: OwnerIdentity;
  readonly size: number;
  assertCurrent(): void;
  acquire<T>(
    allocate: () => T | PromiseLike<T>,
    dispose: (value: T) => unknown,
  ): Promise<T>;
  adopt<T>(value: T, dispose: (value: T) => unknown): Promise<T>;
  defer(dispose: () => unknown): void;
}

/** Construction compatibility owner. Ordinary scenarios use fixtureScope instead.
 * prepare retains custody on success; a rejected constructor has no escaped owner.
 * close is idempotent; it adds neither a settlement algorithm nor a deadline.
 */
export function createFixtureScope() {
  const resources = createOwnershipScope();
  const scope: FixtureScope = Object.freeze({
    identity: resources.identity,
    get size() {
      return resources.size;
    },
    assertCurrent: () => resources.assertCurrent(),
    async acquire<T>(
      allocate: () => T | PromiseLike<T>,
      dispose: (value: T) => unknown,
    ) {
      return (await resources.acquire(allocate, dispose)).value;
    },
    async adopt<T>(value: T, dispose: (value: T) => unknown) {
      return (await resources.adopt(value, dispose)).value;
    },
    defer(dispose: () => unknown) {
      resources.defer(dispose);
    },
  });
  const close = async (...primary: [] | [unknown]) => {
    (await resources.releaseAll()).throwIfFailed(...primary);
  };
  return Object.freeze({
    scope,
    close,
    async prepare<T>(
      construct: (scope: FixtureScope) => T | PromiseLike<T>,
    ): Promise<T> {
      try {
        return await construct(scope);
      } catch (error) {
        await close(error);
        throw error;
      }
    },
    async run<T>(
      body: (scope: FixtureScope) => T | PromiseLike<T>,
      report?: () => unknown,
    ): Promise<T> {
      let primary: [] | [unknown] = [];
      try {
        return await body(scope);
      } catch (error) {
        primary = [error];
        throw error;
      } finally {
        resources.retire();
        // These are phase tasks, not a second resource registry. The common core
        // owns report-before-release, all-attempt execution and error propagation.
        const finalization = createOwnershipScope();
        finalization.defer(async () =>
          (await resources.releaseAll()).throwIfFailed()
        );
        if (report) finalization.defer(report);
        (await finalization.releaseAll()).throwIfFailed(...primary);
      }
    },
  });
}

/** Covers preparation as well as assertions; captures even thrown undefined. */
export function fixtureScope<T>(
  body: (scope: FixtureScope) => T | PromiseLike<T>,
  options: { report?: () => unknown } = {},
): Promise<T> {
  return createFixtureScope().run(body, options.report);
}
