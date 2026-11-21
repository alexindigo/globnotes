// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureScope } from "./fixture_scope.ts";
import { isPromise } from "./fixture_coordination.ts";
import { workMilestone } from "./product_settlement.ts";
import { done, pending, waitUntil } from "./wait.ts";

/** Product work keeps its existing deadline. A deliberately held external or
 * manually clocked operation instead needs fixture containment: its product
 * clock cannot make progress on its own. Neither mode changes product budgets. */
export type OperationProgress =
  | { kind: "product" }
  | { kind: "controlled"; clock: "manual" | "external" };

export interface HeldOperationOptions {
  label: string;
  progress: OperationProgress;
  /** Cancellation of the resource whose effects the caller has admitted. */
  signal?: AbortSignal;
  /** The real request/resource/generation at the starting boundary. This is
   * not permission to borrow another operation's completion or recapture work. */
  owner: () => object | undefined;
}

export interface HeldOperation<T> {
  /** Early rejection propagates; successful completion without entry rejects. */
  reached(): Promise<void>;
  release(): void;
  /** Release the held boundary and observe this exact operation's result. */
  result(): Promise<T>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** One captured subscription to the actual request, shared by both surfaces. */
function subscribeStarted<T>(
  start: () => T | Promise<T>,
  record: (outcome: Outcome<T>) => void,
) {
  try {
    const started = start();
    const source = isPromise(started)
      ? started as Promise<T>
      : Promise.resolve(started);
    const then = source.then;
    then.call(
      source,
      (value) => record({ ok: true, value }),
      (error) => record({ ok: false, error }),
    );
  } catch (error) {
    record({ ok: false, error });
  }
}

export interface BoundOperationOptions<T> {
  signal: AbortSignal;
  /** Invoked for every received result, including after cancellation. Disposal
   * rejection is observed, but its completion cannot delay the observation. */
  dispose(value: T): unknown;
}

/** Observe one started IO operation within its caller's cancellation lifetime.
 * Unlike heldOperation, this does not join cancellation-ignoring IO or disposal.
 * Late completions retain their response disposer, not the caller's admission.
 * The caller supplies its existing readiness bound; no clock or retry is added. */
export async function boundOperation<T>(
  options: BoundOperationOptions<T>,
  start: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const signal = options.signal;
  signal.throwIfAborted();
  const dispose = options.dispose.bind(options);
  const { addEventListener, removeEventListener } = signal;
  return await fixtureScope(async (scope) => {
    const observation = Promise.withResolvers<Outcome<T>>();
    const cancel = () =>
      observation.resolve({ ok: false, error: signal.reason });
    scope.defer(() => removeEventListener.call(signal, "abort", cancel));
    addEventListener.call(signal, "abort", cancel, { once: true });
    if (signal.aborted) cancel();
    // Preserve deferred start and the pre-effect cancellation fence. This task
    // subscribes without waiting for the request, so it cannot retain admission.
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      subscribeStarted(() => start(signal), (outcome) => {
        if (outcome.ok) {
          try {
            Promise.resolve(dispose(outcome.value)).catch(() => {});
          } catch (error) {
            observation.resolve({ ok: false, error });
            return;
          }
        }
        observation.resolve(outcome);
      });
    }).catch((error) => observation.resolve({ ok: false, error }));
    const outcome = await observation.promise;
    signal.throwIfAborted();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
}

/** Start and hold together, registering release/drain before invoking start.
 * The callback receives no bare entry promise or caller-selected completion.
 * This owns only the held boundary, not arbitrary uncooperative I/O: start must
 * honor release/the supplied abort signal if it creates additional pending I/O.
 * P03 owns the enclosing fixture's other resources; their effects must enter
 * through their admission port. This adapter keeps its own held-work scope. */
export async function heldOperation<T, R>(
  options: HeldOperationOptions,
  start: (hold: () => Promise<void>, signal: AbortSignal) => T | Promise<T>,
  use: (operation: HeldOperation<T>) => R | Promise<R>,
): Promise<R> {
  // Capture the ports once. Only the issued owner getter is called again to
  // check its current identity; mutable options cannot change an in-flight call.
  const parentSignal = options.signal;
  parentSignal?.throwIfAborted();
  const { label, owner: ownerPort, progress: inputProgress } = options;
  const owner = ownerPort.bind(options);
  const kind = inputProgress.kind;
  const clock = kind === "controlled" ? inputProgress.clock : undefined;
  if (
    kind !== "product" &&
    !(kind === "controlled" && (clock === "manual" || clock === "external"))
  ) throw new TypeError("Operation requires an explicit progress mode");
  const progress: OperationProgress = kind === "product"
    ? { kind }
    : { kind, clock: clock as "manual" | "external" };
  return await fixtureScope(async (scope) => {
    const signal = parentSignal
      ? AbortSignal.any([scope.signal, parentSignal])
      : scope.signal;
    signal.throwIfAborted();
    const identity = owner();
    signal.throwIfAborted();
    if (!identity) throw new Error(`${label}: operation owner absent`);
    const assertOwner = () => {
      scope.assertCurrent();
      signal.throwIfAborted();
      if (owner() !== identity) {
        throw new Error(`${label}: operation owner replaced`);
      }
    };
    const entry = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<Outcome<T>>();
    let outcome: Outcome<T> | undefined;
    let claimed = false;
    const record = (value: Outcome<T>) => {
      if (outcome) return;
      outcome = value;
      recorded.resolve(value);
    };
    const completion = recorded.promise.then((value) => {
      if (!value.ok) throw value.error;
      return value.value;
    });
    completion.catch(() => {});
    // Controlled work delegates containment to the existing single readiness
    // owner. Return an outcome rather than throwing inside its probe so operation
    // errors retain their exact identity instead of becoming ReadinessError causes.
    const contain = async <V>(
      completion: Promise<V>,
      phase: string,
    ): Promise<V> => {
      if (progress.kind === "product") return await completion;
      let observed: Outcome<V> | undefined;
      completion.then(
        (value) => observed = { ok: true, value },
        (error) => observed = { ok: false, error },
      );
      const result = await waitUntil(
        () => observed ? done(observed) : pending({ phase, clock: progress }),
        { label: `${label}: ${phase}` },
      );
      if (!result.ok) throw result.error;
      return result.value;
    };
    scope.onCancel(() => {
      gate.resolve();
    });
    // Parent cancellation must settle the held boundary before its admitted
    // work drains. Removing this listener is owned before installation.
    if (parentSignal) {
      const release = () => gate.resolve();
      const { addEventListener, removeEventListener } = parentSignal;
      scope.defer(() =>
        removeEventListener.call(parentSignal, "abort", release)
      );
      addEventListener.call(parentSignal, "abort", release, { once: true });
      if (parentSignal.aborted) release();
    }
    scope.defer(async () => {
      // Observe the same original work, even after rejection or owner replacement.
      // A result explicitly consumed by the callback can be an expected failure.
      await contain(recorded.promise, "drain");
      if (!claimed && outcome && !outcome.ok) throw outcome.error;
    });
    // Register first, then start before the scenario callback can run. A sync
    // rejection becomes the actual operation's rejection, not an orphan marker.
    subscribeStarted(() => {
      assertOwner();
      return start(() => {
        assertOwner();
        entry.resolve();
        return gate.promise;
      }, signal);
    }, record);
    const operation: HeldOperation<T> = Object.freeze({
      async reached() {
        assertOwner();
        try {
          await contain(
            workMilestone(completion, entry.promise, label),
            "entry",
          );
        } catch (error) {
          assertOwner();
          throw error;
        }
        assertOwner();
      },
      release() {
        assertOwner();
        gate.resolve();
      },
      async result() {
        assertOwner();
        gate.resolve();
        try {
          const result = await contain(completion, "result");
          assertOwner();
          claimed = true;
          return result;
        } catch (error) {
          // Only consuming the actual terminal error claims it; a containment
          // failure still leaves disposal responsible for the original work.
          assertOwner();
          if (outcome && !outcome.ok && outcome.error === error) claimed = true;
          throw error;
        }
      },
    });
    return await use(operation);
  });
}
