// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  type MonotonicScheduler,
  OBSERVED_PERIOD_MS,
  ObservedClock,
} from "../server/observed_time.ts";
import { PLUGIN_LIMITS } from "../server/plugins/contracts.ts";
import {
  boundOperation,
  type HeldOperation,
  heldOperation,
  type OperationProgress,
} from "./helpers/owned_operation.ts";
import { READINESS_MS, ReadinessError } from "./helpers/wait.ts";
import { waitForCancellation } from "./helpers/fixture_coordination.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

for (const timing of ["live", "late"] as const) {
  for (const disposal of ["complete", "pending", "rejected"] as const) {
    Deno.test(`bound operation: ${timing} response has ${disposal} disposal without retaining admission`, async () => {
      const controller = new AbortController();
      const cancelled = new Error("request lifetime cancelled");
      const request = Promise.withResolvers<{ id: string }>();
      const entered = Promise.withResolvers<void>();
      const disposed = Promise.withResolvers<void>();
      const disposalObserved = Promise.withResolvers<void>();
      const pendingDisposal = Promise.withResolvers<void>();
      const value = { id: "actual response" };
      const events: string[] = [];
      const running = boundOperation({
        signal: controller.signal,
        dispose(response: typeof value) {
          assertStrictEquals(response, value);
          events.push("disposed");
          disposed.resolve();
          if (disposal === "pending") return pendingDisposal.promise;
          if (disposal === "rejected") {
            const releasing = Promise.reject(new Error("disposal failed"));
            const then = releasing.then.bind(releasing);
            Object.defineProperty(releasing, "then", {
              get() {
                events.push("disposal rejection observed");
                disposalObserved.resolve();
                return then;
              },
            });
            return releasing;
          }
        },
      }, (signal) => {
        assertStrictEquals(signal, controller.signal);
        events.push("started");
        entered.resolve();
        return request.promise;
      });
      await workMilestone(running, entered.promise, "bound request started");
      if (timing === "late") {
        controller.abort(cancelled);
        const error = await assertRejects(
          () => bounded(running, "cancelled bound observation"),
          Error,
          cancelled.message,
        );
        assertStrictEquals(error, cancelled);
        events.push("cancelled observation returned");
      }
      request.resolve(value);
      await bounded(disposed.promise, "actual response disposal invoked");
      if (disposal === "rejected") {
        await bounded(
          disposalObserved.promise,
          "actual disposal rejection observed",
        );
      }
      if (timing === "live") {
        assertStrictEquals(
          await bounded(running, "bound observation ignores pending disposal"),
          value,
        );
        events.push("live observation returned");
      }
      assertEquals(events, [
        "started",
        ...(timing === "late" ? ["cancelled observation returned"] : []),
        "disposed",
        ...(disposal === "rejected" ? ["disposal rejection observed"] : []),
        ...(timing === "live" ? ["live observation returned"] : []),
      ]);
    });
  }
}

for (const timing of ["live", "late"] as const) {
  Deno.test(`bound operation: ${timing} transport rejection remains observed on the original request`, async () => {
    const controller = new AbortController();
    const cancellation = new Error("bound lifetime cancelled");
    const failure = new Error("actual transport failure");
    const request = Promise.withResolvers<number>();
    const entered = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const then = request.promise.then.bind(request.promise);
    const events: string[] = [];
    let reads = 0;
    Object.defineProperty(request.promise, "then", {
      get() {
        reads++;
        return (
          success: (value: number) => unknown,
          rejected: (error: unknown) => unknown,
        ) =>
          then(success, (error) => {
            events.push("transport rejection observed");
            const result = rejected(error);
            observed.resolve();
            return result;
          });
      },
    });
    const running = boundOperation({
      signal: controller.signal,
      dispose() {
        events.push("unexpected disposal");
      },
    }, () => {
      entered.resolve();
      return request.promise;
    });
    await workMilestone(
      running,
      entered.promise,
      "rejecting bound request started",
    );
    if (timing === "late") controller.abort(cancellation);
    const checked = assertRejects(
      () => bounded(running, "bound transport rejection"),
      Error,
      timing === "late" ? cancellation.message : failure.message,
    );
    if (timing === "late") {
      await checked;
      events.push("cancelled observation returned");
    }
    request.reject(failure);
    await bounded(observed.promise, "original transport rejection callback");
    const error = await checked;
    assertStrictEquals(error, timing === "late" ? cancellation : failure);
    assertEquals([events, reads], [[
      ...(timing === "late" ? ["cancelled observation returned"] : []),
      "transport rejection observed",
    ], 1]);
  });
}

for (const preAborted of [false, true]) {
  Deno.test(`bound operation: ${preAborted ? "pre-aborted" : "immediate cancellation"} starts no request`, async () => {
    const controller = new AbortController();
    const cause = new Error("cancelled before effects");
    const effects: string[] = [];
    if (preAborted) controller.abort(cause);
    const running = boundOperation({
      signal: controller.signal,
      dispose() {
        effects.push("disposed");
      },
    }, () => {
      effects.push("started");
      return 7;
    });
    if (!preAborted) controller.abort(cause);
    const error = await assertRejects(() => running, Error, cause.message);
    assertStrictEquals(error, cause);
    assertEquals(effects, []);
  });
}

const identity = {};
const options = (progress: OperationProgress = { kind: "product" }) => ({
  label: "contract held work",
  owner: () => identity,
  progress,
});
async function caught(work: () => Promise<unknown>, expected: Error) {
  const error = await assertRejects(
    work,
    expected.constructor as ErrorConstructor,
    expected.message,
  );
  assertEquals(error, expected);
  return error;
}

for (
  const progress of [
    { kind: "product" },
    { kind: "controlled", clock: "external" },
    { kind: "controlled", clock: "manual" },
  ] as const
) {
  const mode = progress.kind === "product" ? "product" : progress.clock;
  for (const synchronous of [true, false]) {
    Deno.test(`owned operation: ${mode} ${synchronous ? "sync" : "async"} rejection before entry preserves the actual cause`, async () => {
      const cause = new Error("request rejected before entry");
      const error = await caught(() =>
        heldOperation(options(progress), () => {
          if (synchronous) throw cause;
          return Promise.reject(cause);
        }, async (operation) => {
          await operation.reached();
        }), cause);
      assertEquals(error, cause);
    });
  }
  Deno.test(`owned operation: ${mode} fulfillment without a marker cannot pass or await later work`, async () => {
    await assertRejects(
      () =>
        heldOperation(
          options(progress),
          () => 42,
          (operation) => operation.reached(),
        ),
      Error,
      "contract held work: product work settled without the expected milestone",
    );
  });
  Deno.test(`owned operation: ${mode} callback failure releases then drains before returning`, async () => {
    const events: string[] = [];
    const cause = new Error("scenario callback failed");
    const error = await caught(
      () =>
        heldOperation(options(progress), async (hold) => {
          await hold();
          events.push("released");
          await Promise.resolve();
          events.push("drained");
        }, async (operation) => {
          await operation.reached();
          events.push("callback");
          throw cause;
        }),
      cause,
    );
    assertEquals(error, cause);
    assertEquals(events, ["callback", "released", "drained"]);
  });
  Deno.test(`owned operation: ${mode} unconsumed failure after entry cannot disappear in cleanup`, async () => {
    const cause = new Error("operation failed after entry");
    assertEquals(
      await caught(() =>
        heldOperation(options(progress), async (hold) => {
          await hold();
          throw cause;
        }, async (operation) => {
          await operation.reached();
        }), cause),
      cause,
    );
  });
  Deno.test(`owned operation: ${mode} explicitly asserted callback rejection is not host termination`, async () => {
    const cause = new Error("ordinary callback rejected");
    let drained = false;
    const result = await heldOperation(options(progress), async (hold) => {
      try {
        await hold();
        throw cause;
      } finally {
        drained = true;
      }
    }, async (operation) => {
      await operation.reached();
      assertEquals(await caught(() => operation.result(), cause), cause);
      return "expected rejection consumed";
    });
    assertEquals(result, "expected rejection consumed");
    assert(drained);
  });
}

Deno.test("owned operation: preserves primary plus distinct drain rejection through the common core", async () => {
  const primary = new Error("callback primary");
  const terminal = new Error("terminal operation rejection");
  const error = await assertRejects(
    () =>
      heldOperation(options(), async (hold) => {
        await hold();
        throw terminal;
      }, async (operation) => {
        await operation.reached();
        throw primary;
      }),
    AggregateError,
    "Owned resource release failed",
  );
  assert(error instanceof AggregateError);
  assertEquals(error.cause, primary);
  assertEquals(error.errors, [primary, terminal]);
});

Deno.test("owned operation: owner replacement rejects but still drains the original, never a replacement", async () => {
  let current = {}, drained = false, starts = 0;
  await assertRejects(
    () =>
      heldOperation({ ...options(), owner: () => current }, async (hold) => {
        starts++;
        await hold();
        drained = true;
        return "original bytes";
      }, async (operation) => {
        await operation.reached();
        current = {};
        return await operation.result();
      }),
    Error,
    "contract held work: operation owner replaced",
  );
  assertEquals(starts, 1);
  assert(drained);
});

Deno.test("owned operation: absent owner cannot start work", async () => {
  let started = false;
  await assertRejects(
    () =>
      heldOperation({ ...options(), owner: () => undefined }, () => {
        started = true;
      }, () => {}),
    Error,
    "contract held work: operation owner absent",
  );
  assertEquals(started, false);
});

Deno.test("owned operation: an issued handle and hold callback retire when their scope returns", async () => {
  let saved!: HeldOperation<number>, held!: () => Promise<void>;
  assertEquals(
    await heldOperation(options(), async (hold) => {
      held = hold;
      await hold();
      return 7;
    }, async (operation) => {
      saved = operation;
      await operation.reached();
      return await operation.result();
    }),
    7,
  );
  await assertRejects(
    () => saved.reached(),
    OwnershipError,
    "Owner is retired",
  );
  await assertRejects(() => saved.result(), OwnershipError, "Owner is retired");
  assertThrows(() => saved.release(), OwnershipError, "Owner is retired");
  await assertRejects(
    async () => {
      await held();
    },
    OwnershipError,
    "Owner is retired",
  );
});

Deno.test("owned operation: original result is fixed and release is idempotent", async () => {
  let starts = 0, releases = 0;
  await heldOperation(options(), async (hold) => {
    starts++;
    await hold();
    releases++;
    return { consumer: "original" };
  }, async (operation) => {
    await operation.reached();
    operation.release();
    operation.release();
    const result = await operation.result();
    assertEquals(await operation.result(), result);
    assertEquals(result, { consumer: "original" });
  });
  assertEquals(starts, 1);
  assertEquals(releases, 1);
});

Deno.test("owned operation: product-bounded work adds no readiness clock or deadline", async () => {
  const realNow = Date.now;
  Date.now = () => {
    throw new Error("competing readiness clock");
  };
  try {
    assertEquals(
      await heldOperation(options(), async (hold) => {
        await hold();
        return "bounded product result";
      }, async (operation) => {
        await operation.reached();
        return await operation.result();
      }),
      "bounded product result",
    );
  } finally {
    Date.now = realNow;
  }
});

Deno.test("owned operation: a manually stopped product clock retains fixture containment and abort/drain", async () => {
  const realNow = Date.now;
  let reads = 0, aborted = false, drained = false;
  // Move only the existing readiness clock. No added timer/deadline framework.
  Date.now = () => ++reads === 1 ? 0 : READINESS_MS;
  try {
    const error = await assertRejects(
      () =>
        heldOperation(
          options({ kind: "controlled", clock: "manual" }),
          (_hold, signal) => {
            const waiting = Promise.withResolvers<void>();
            signal.addEventListener("abort", () => {
              aborted = true;
              waiting.reject(signal.reason);
            }, { once: true });
            return waiting.promise.finally(() => {
              drained = true;
            });
          },
          async (operation) => {
            await operation.reached();
          },
        ),
      AggregateError,
      "Owned resource release failed",
    );
    // Disposal's abort is retained alongside the containment failure, not hidden.
    assert(error instanceof AggregateError);
    assertEquals(
      error.errors.map((error) =>
        error instanceof ReadinessError
          ? {
            type: error.constructor,
            label: error.label,
            reason: error.reason,
            state: error.state,
          }
          : { type: error.constructor, message: error.message }
      ),
      [
        {
          type: ReadinessError,
          label: "contract held work: entry",
          reason: "readiness bound exceeded",
          state: {
            phase: "entry",
            clock: { kind: "controlled", clock: "manual" },
          },
        },
        { type: OwnershipError, message: "Fixture scope retired" },
      ],
    );
    assert(aborted);
    assert(drained);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("owned operation: manual progress can advance while the exact held request remains owned", async () => {
  let clock = 100;
  const realNow = Date.now;
  let readinessReads = 0;
  Date.now = () => {
    readinessReads++;
    return realNow();
  };
  try {
    assertEquals(
      await heldOperation(
        options({ kind: "controlled", clock: "manual" }),
        async (hold) => {
          const admitted = clock;
          await hold();
          return { admitted, observed: clock };
        },
        async (operation) => {
          await operation.reached();
          clock += 30_000;
          return await operation.result();
        },
      ),
      { admitted: 100, observed: 30_100 },
    );
    assert(
      readinessReads > 0,
      "manual product time must retain the existing fixture containment clock",
    );
  } finally {
    Date.now = realNow;
  }
});

Deno.test("owned operation: release/drain registration precedes synchronous start and callback failure", async () => {
  let started = false, drained = false;
  const cause = new Error("callback before any await");
  assertEquals(
    await caught(() =>
      heldOperation(options(), async (hold) => {
        started = true;
        await hold();
        drained = true;
      }, () => {
        assert(started, "the real operation must already have started");
        throw cause;
      }), cause),
    cause,
  );
  assert(drained);
});

async function manualDeadlineControl(callbackFails: boolean) {
  let time = 0, requested = 0;
  let tick: (() => void) | undefined, wake: (() => void) | undefined;
  const timer = {} as ReturnType<MonotonicScheduler["setTimeout"]>;
  // Drive the existing production clock's scheduler port, not a new deadline
  // implementation. No host timer progresses this deliberately manual clock.
  const clock = new ObservedClock({
    now: () => time,
    setTimeout(callback, milliseconds) {
      wake = callback;
      requested = milliseconds;
      return timer;
    },
    clearTimeout() {
      wake = undefined;
    },
    setInterval(callback) {
      tick = callback;
      return timer;
    },
    clearInterval() {
      tick = undefined;
    },
  });
  const cause = new Error("actual product clock deadline");
  const primary = new Error("manual-clock scenario rejected");
  const run = () =>
    heldOperation(
      options({ kind: "controlled", clock: "manual" }),
      async (hold, signal) => {
        const terminal = Promise.withResolvers<void>();
        terminal.promise.catch(() => {});
        const abort = () => terminal.reject(signal.reason);
        let cancel = () => {};
        try {
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          cancel = clock.deadline(
            PLUGIN_LIMITS.serviceCallMs,
            () => terminal.reject(cause),
          );
          await hold();
          await terminal.promise;
        } finally {
          signal.removeEventListener("abort", abort);
          cancel();
        }
      },
      async (operation) => {
        await operation.reached();
        assertEquals(clock.now(), 0);
        assertEquals(requested, 30_000);
        if (callbackFails) throw primary;
        while (time < PLUGIN_LIMITS.serviceCallMs) {
          time += OBSERVED_PERIOD_MS;
          tick!();
        }
        const expire = wake!;
        wake = undefined;
        expire();
        assertEquals(await caught(() => operation.result(), cause), cause);
      },
    );
  if (callbackFails) {
    const error = await assertRejects(
      () => bounded(run(), "manual-clock callback cleanup"),
      AggregateError,
      "Owned resource release failed",
    );
    assertEquals(error.cause, primary);
    assertEquals(
      error.errors.map((error) => [error.constructor, error.message]),
      [
        [Error, primary.message],
        [OwnershipError, "Fixture scope retired"],
      ],
    );
  } else {
    await run();
  }
  assertEquals(tick, undefined);
  assertEquals(wake, undefined);
}

Deno.test("owned operation: manual mode retains the real observed-clock product deadline and cleanup", async () => {
  await manualDeadlineControl(false);
});
Deno.test("owned operation review: manual-clock callback failure cancels its deadline waiter before timer cleanup", async () => {
  await manualDeadlineControl(true);
});

Deno.test("owned operation: thrown undefined from the callback remains a primary failure", async () => {
  let rejected = false;
  try {
    await heldOperation(options(), async (hold) => {
      await hold();
    }, async (operation) => {
      await operation.reached();
      throw undefined;
    });
  } catch (error) {
    rejected = true;
    assertEquals(error, undefined);
  }
  assertEquals(rejected, true);
});

Deno.test("owned operation: cancellation precedes borrowed-work drain and resource release", async () => {
  const events: string[] = [];
  await bounded(
    fixtureScope(async (scope) => {
      const resource = (await scope.acquire(
        () => ({ alive: true }),
        (value) => {
          value.alive = false;
          events.push("resource released");
        },
      )).value;
      const result = await scope.admit(() =>
        heldOperation(
          { ...options(), owner: () => resource },
          async (hold, signal) => {
            events.push("admitted");
            signal.addEventListener("abort", () => {
              assertEquals(resource.alive, true);
              events.push("cancelled");
            }, { once: true });
            await hold();
            assertEquals(signal.aborted, true);
            assertEquals(resource.alive, true);
            events.push("drained");
            return resource;
          },
          async (operation) => {
            await operation.reached();
            events.push("callback complete");
            return "scenario result";
          },
        )
      );
      assertEquals(result.value, "scenario result");
    }),
    "held operation cancellation and borrowed resource release",
  );
  assertEquals(events, [
    "admitted",
    "callback complete",
    "cancelled",
    "drained",
    "resource released",
  ]);
});

Deno.test("owned operation review: options and original request subscription are captured once", async () => {
  const reads = { label: 0, owner: 0, progress: 0, kind: 0, clock: 0 };
  let subscriptions = 0;
  const progress = {
    get kind() {
      reads.kind++;
      return "controlled" as const;
    },
    get clock() {
      reads.clock++;
      return "external" as const;
    },
  };
  const input = {
    get label() {
      reads.label++;
      return "captured options";
    },
    get owner() {
      reads.owner++;
      return () => identity;
    },
    get progress() {
      reads.progress++;
      return progress;
    },
  };
  await bounded(
    heldOperation(input, (hold) => {
      const request = hold().then(() => ({ consumer: "original" }));
      const then = request.then.bind(request);
      Object.defineProperty(request, "then", {
        get() {
          subscriptions++;
          if (subscriptions !== 1) throw new Error("request subscribed twice");
          return then;
        },
      });
      return request;
    }, async (operation) => {
      await operation.reached();
      assertEquals(await operation.result(), { consumer: "original" });
      assertEquals(await operation.result(), { consumer: "original" });
    }),
    "single captured original request",
  );
  assertEquals([reads, subscriptions], [
    { label: 1, owner: 1, progress: 1, kind: 1, clock: 1 },
    1,
  ]);
});

Deno.test("owned operation review: the captured owner port retains its actual receiver", async () => {
  const input = {
    ...options(),
    current: identity,
    owner() {
      return this.current;
    },
  };
  assertEquals(
    await heldOperation(input, async (hold) => {
      await hold();
      return 7;
    }, async (operation) => {
      await operation.reached();
      return await operation.result();
    }),
    7,
  );
});

Deno.test("owned operation review: cancellation listener cleanup retains its captured ports", async () => {
  const parent = new AbortController();
  const add = parent.signal.addEventListener.bind(parent.signal);
  const remove = parent.signal.removeEventListener.bind(parent.signal);
  const events: string[] = [];
  parent.signal.addEventListener = (...args: Parameters<typeof add>) => {
    events.push("added");
    return add(...args);
  };
  parent.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    events.push("removed");
    return remove(...args);
  };
  await heldOperation({ ...options(), signal: parent.signal }, async (hold) => {
    await hold();
    return 7;
  }, async (operation) => {
    await operation.reached();
    parent.signal.removeEventListener = () => {
      throw new Error("mutated listener cleanup port reread");
    };
    assertEquals(await operation.result(), 7);
  });
  assertEquals(events, ["added", "removed"]);
});

for (const observation of ["reached", "result"] as const) {
  for (const rejected of [false, true]) {
    Deno.test(`owned operation review: ${observation} discards a stale ${rejected ? "failure" : "success"} after replacement`, async () => {
      let current = {};
      const terminal = Promise.withResolvers<number>();
      const failure = new Error("original request failed after replacement");
      const running = heldOperation(
        { ...options(), owner: () => current },
        () => terminal.promise,
        async (operation) => {
          const observing = operation[observation]();
          const checked = assertRejects(
            () => observing,
            Error,
            "contract held work: operation owner replaced",
          );
          current = {};
          if (rejected) terminal.reject(failure);
          else terminal.resolve(7);
          await checked;
        },
      );
      if (rejected) {
        const error = await assertRejects(
          () => bounded(running, "stale failure cleanup"),
          Error,
          failure.message,
        );
        assertEquals(error, failure);
      } else {
        await bounded(running, "stale success cleanup");
      }
    });
  }
}

Deno.test("owned operation review: cancelling admitted work settles extra IO before releasing its resource", async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  let checked!: Promise<Error>;
  await bounded(
    fixtureScope(async (scope) => {
      const resource =
        (await scope.acquire(() => ({ alive: true }), (resource) => {
          resource.alive = false;
          events.push("resource released");
        })).value;
      const running = scope.admit((signal) =>
        heldOperation({
          ...options(),
          owner: () => resource,
          signal,
        }, async (hold, signal) => {
          events.push("admitted");
          try {
            await hold();
            events.push("extra IO entered");
            entered.resolve();
            await waitForCancellation(signal);
          } finally {
            assertEquals(resource.alive, true);
            events.push("work drained");
          }
        }, async (operation) => {
          await operation.reached();
          return await operation.result();
        })
      );
      checked = assertRejects(
        () => running,
        OwnershipError,
        "Fixture scope retired",
      );
      await workMilestone(running, entered.promise, "admitted extra IO");
      events.push("scope body complete");
    }),
    "resource cancellation joins held-operation work",
  );
  await checked;
  assertEquals(events, [
    "admitted",
    "extra IO entered",
    "scope body complete",
    "work drained",
    "resource released",
  ]);
});

Deno.test("owned operation review: a pre-aborted resource starts no operation or owner capture", async () => {
  const controller = new AbortController();
  const cause = new Error("resource was already cancelled");
  controller.abort(cause);
  const effects: string[] = [];
  const error = await assertRejects(
    () =>
      heldOperation({
        ...options(),
        signal: controller.signal,
        get owner() {
          effects.push("owner captured");
          return () => identity;
        },
      }, () => {
        effects.push("started");
      }, () => {
        effects.push("used");
      }),
    Error,
    cause.message,
  );
  assertEquals(error, cause);
  assertEquals(effects, []);
});

Deno.test("owned operation review: resource cancellation releases a hold before the callback can return", async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  let checked!: Promise<Error>;
  await bounded(
    fixtureScope(async (scope) => {
      scope.defer(() => events.push("resource released"));
      let original!: Promise<number>;
      const running = scope.admit((signal) =>
        heldOperation({ ...options(), signal }, (hold) => {
          original = (async () => {
            events.push("started");
            await hold();
            events.push("hold released");
            return 7;
          })();
          return original;
        }, async (operation) => {
          await operation.reached();
          events.push("callback awaiting original");
          entered.resolve();
          assertEquals(await original, 7);
          events.push("callback complete");
        })
      );
      checked = assertRejects(
        () => running,
        OwnershipError,
        "Owner is retired",
      );
      await workMilestone(running, entered.promise, "held callback entered");
      events.push("scope body complete");
    }),
    "resource cancellation releases held callback dependency",
  );
  await checked;
  assertEquals(events, [
    "started",
    "callback awaiting original",
    "scope body complete",
    "hold released",
    "callback complete",
    "resource released",
  ]);
});
