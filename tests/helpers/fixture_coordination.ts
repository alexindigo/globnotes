// SPDX-License-Identifier: LGPL-3.0-only
import { type FixtureScope, fixtureScope } from "./fixture_scope.ts";

export const isPromise = (value: unknown): value is Promise<unknown> =>
  value instanceof Promise;

export function fixtureTest(
  name: string,
  body: (scope: FixtureScope) => unknown | PromiseLike<unknown>,
) {
  Deno.test(name, async () => {
    await fixtureScope(body);
  });
}

/** Deliberately held IO has exactly one settlement: its actual owner's abort. */
export function waitForCancellation(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** A test milestone is owned work, not a promise outside cancellation's reach.
 * Values are primitives: resource values continue to cross awaits in envelopes. */
export function fixtureGate<T extends string | number | boolean | void = void>(
  scope: FixtureScope,
) {
  const pending = Promise.withResolvers<T>();
  const admitted = scope.admit((signal) =>
    fixtureScope((listeners) => {
      const abort = () => pending.reject(signal.reason);
      listeners.defer(() => signal.removeEventListener("abort", abort));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      return pending.promise;
    })
  );
  const promise = admitted.then((result) => result.value);
  promise.catch(() => {}); // A never-reached milestone is cancelled at scope exit.
  return Object.freeze({
    promise,
    resolve: pending.resolve,
    reject: pending.reject,
  });
}
