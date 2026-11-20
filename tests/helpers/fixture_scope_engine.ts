// SPDX-License-Identifier: LGPL-3.0-only
import {
  createOwnershipScope,
  type OwnedResource,
  type OwnerIdentity,
  OwnershipError,
  type OwnershipRelease,
  type OwnershipScope,
} from "../../shared/ownership.js";

interface FixtureController {
  readonly work: OwnershipScope;
  readonly signal: AbortSignal;
  readonly settled: OwnershipScope;
  link(child: FixtureController, retired: () => void): void;
  cancel(): Promise<OwnershipRelease>;
  finish(): Promise<OwnershipRelease>;
}
const engines = new WeakMap<FixtureScope, FixtureController>();
const children = new WeakMap<FixtureScope, WeakSet<FixtureScope>>();

/** Private fixture construction port: a root closes its dedicated runtime
 * borrowers before deleting the root, including autonomous product work. */
export function ownFixtureScope(
  owner: FixtureScope,
  child: FixtureScope,
): void {
  if (owner === child) return;
  owner.assertCurrent();
  child.assertCurrent();
  const engine = engines.get(child);
  if (!engine) {
    throw new TypeError("Borrowed runtime requires an issued fixture scope");
  }
  let linked = children.get(owner);
  if (!linked) children.set(owner, linked = new WeakSet());
  if (linked.has(child)) return;
  engines.get(owner)!.link(engine, () => {
    linked!.delete(child);
  });
  linked.add(child);
}

/** Private construction implementation. Public scenarios enter via fixture_scope.ts.
 * Allocation is reserved before invocation;
 * constructors must register each partial resource, not return an opaque factory.
 * Cancellation is independent of registration order; only resource release is LIFO.
 */
export interface FixtureScope {
  readonly identity: OwnerIdentity;
  readonly size: number;
  /** Owned cancellation, fired synchronously when close starts. */
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Invoked synchronously on cancellation, before any admitted-work drain.
   * All hooks start even if another throws or returns a pending/rejected value.
   * Hook outcomes are joined before draining; hooks must not await scope close. */
  onCancel(cancel: (signal: AbortSignal) => unknown): void;
  /** Bind a fixture-issued effect to this exact scope, without resolving its result. */
  bind<Args extends unknown[], T>(
    effect: (...args: Args) => T,
  ): (...args: Args) => T;
  /** Keep owned values inside handles across awaits; read .value synchronously. */
  acquire<T>(
    allocate: () => T | PromiseLike<T>,
    dispose: (value: T) => unknown,
  ): Promise<OwnedResource<T>>;
  adopt<T>(value: T, dispose: (value: T) => unknown): Promise<OwnedResource<T>>;
  /** Admit work in the resource owner and all borrowers before its first effect.
   * Every owner drains it; completed work releases its reservations immediately.
   * Results remain wrapped across awaits, including thenable resource values. */
  admit<T>(
    effect: (signal: AbortSignal) => T | PromiseLike<T>,
    ...borrowers: FixtureScope[]
  ): Promise<Readonly<{ value: T }>>;
  defer(dispose: () => unknown): void;
}

/** Construction compatibility owner. Ordinary scenarios use fixtureScope instead.
 * prepare retains custody on success; a rejected constructor has no escaped owner.
 * close retires/cancels, drains admitted work, then releases resources. Each
 * phase uses the common core; no settlement algorithm or deadline is added.
 */
export function createFixtureScope() {
  const resources = createOwnershipScope();
  const work = createOwnershipScope();
  const cancellationResults = createOwnershipScope();
  const settled = createOwnershipScope();
  const controller = new AbortController();
  let cancelled: Promise<OwnershipRelease> | undefined;
  let finished: Promise<OwnershipRelease> | undefined;
  const cancel = (): Promise<OwnershipRelease> => {
    if (!cancelled) {
      // Fence every acquisition before firing user cancellation code. Cache the
      // phase before abort dispatch so reentrant close joins this same phase.
      resources.retire();
      work.retire();
      let complete!: (report: OwnershipRelease) => void;
      cancelled = new Promise((resolve) => {
        complete = resolve;
      });
      try {
        controller.abort(new OwnershipError("Fixture scope retired"));
      } catch (error) {
        cancellationResults.defer(() => {
          throw error;
        });
      }
      // Abort dispatch starts every hook synchronously. Only now may its captured
      // outcomes be awaited; a pending early hook cannot prevent later hooks.
      void cancellationResults.releaseAll().then(complete);
    }
    return cancelled;
  };
  const finish = (): Promise<OwnershipRelease> => {
    const cancelling = cancel();
    if (!finished) {
      const phases = createOwnershipScope();
      phases.defer(async () => (await settled.releaseAll()).throwIfFailed());
      phases.defer(async () => (await resources.releaseAll()).throwIfFailed());
      phases.defer(async () => (await work.releaseAll()).throwIfFailed());
      phases.defer(async () => (await cancelling).throwIfFailed());
      finished = phases.releaseAll();
    }
    return finished;
  };
  const observeCancellation = (hook: (signal: AbortSignal) => unknown) => {
    const pending = cancellationResults.acquire(async () => {
      try {
        await hook(controller.signal);
        return { failed: false as const };
      } catch (error) {
        return { failed: true as const, error };
      }
    }, (outcome) => {
      if (outcome.failed) throw outcome.error;
    });
    pending.catch(() => {});
  };
  const scope: FixtureScope = Object.freeze({
    identity: resources.identity,
    get size() {
      return resources.size + work.size + cancellationResults.size +
        settled.size;
    },
    signal: controller.signal,
    assertCurrent: () => resources.assertCurrent(),
    onCancel(cancel: (signal: AbortSignal) => unknown) {
      resources.assertCurrent();
      if (typeof cancel !== "function") {
        throw new TypeError("Cancellation hook must be callable");
      }
      const signal = controller.signal;
      const invoke = () => {
        // Observe each result immediately and resolve it exactly once, even if
        // another hook stays pending. The core report owns callback failures;
        // retirement of this phase's acquisition promise is expected, not lost IO.
        observeCancellation(cancel);
      };
      // Native abort dispatch is synchronous and all-attempt through invoke's
      // error capture. Listener removal is ordinary release, after IO drains.
      resources.defer(() => signal.removeEventListener("abort", invoke));
      signal.addEventListener("abort", invoke, { once: true });
    },
    bind<Args extends unknown[], T>(effect: (...args: Args) => T) {
      return (...args: Args): T => {
        resources.assertCurrent();
        return effect(...args);
      };
    },
    acquire<T>(
      allocate: () => T | PromiseLike<T>,
      dispose: (value: T) => unknown,
    ) {
      return resources.acquire(allocate, dispose);
    },
    adopt<T>(value: T, dispose: (value: T) => unknown) {
      return resources.adopt(value, dispose);
    },
    async admit<T>(
      effect: (signal: AbortSignal) => T | PromiseLike<T>,
      ...borrowers: FixtureScope[]
    ) {
      const owners = [...new Set([scope, ...borrowers])].map((owner) => {
        const engine = engines.get(owner);
        if (!engine) {
          throw new TypeError(
            "Work admission requires an issued fixture scope",
          );
        }
        return engine;
      });
      const signal = owners.length === 1
        ? owners[0].signal
        : AbortSignal.any(owners.map((owner) => owner.signal));
      const enter = async (index: number): Promise<Readonly<{ value: T }>> => {
        const owner = owners[index].work;
        if (index === owners.length - 1) {
          const handle = await owner.acquire(() => effect(signal), () => {});
          await owner.release(handle);
          return handle;
        }
        const handle = await owner.acquire(() => enter(index + 1), () => {});
        await owner.release(handle);
        return handle.value;
      };
      return await enter(0);
    },
    defer(dispose: () => unknown) {
      resources.defer(dispose);
    },
  });
  engines.set(scope, {
    work,
    signal: controller.signal,
    settled,
    cancel,
    finish,
    link(child, retired) {
      let joining = false, drained = false;
      const invoke = () => observeCancellation(() => child.cancel());
      // One owned edge includes cancellation and drain custody. Settlement of
      // the child releases that edge, unless the root is already joining it.
      const edge = resources.defer(async () => {
        joining = true;
        const cleanup = createOwnershipScope();
        cleanup.defer(async () => {
          if (!drained) (await child.finish()).throwIfFailed();
        });
        cleanup.defer(() =>
          controller.signal.removeEventListener("abort", invoke)
        );
        (await cleanup.releaseAll()).throwIfFailed();
      });
      child.settled.defer(async () => {
        drained = true;
        retired();
        if (!joining) await resources.release(edge);
      });
      controller.signal.addEventListener("abort", invoke, { once: true });
    },
  });
  const close = async (...primary: [] | [unknown]) => {
    (await finish()).throwIfFailed(...primary);
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
        cancel();
        // These are phase tasks, not a second resource registry. The common core
        // owns report-before-release, all-attempt execution and error propagation.
        const finalization = createOwnershipScope();
        finalization.defer(async () => (await finish()).throwIfFailed());
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
