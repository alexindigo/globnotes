// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  createOwnershipScope,
  type OwnedResource,
  type OwnerIdentity,
  OwnershipError,
} from "../shared/ownership.js";
import { workMilestone } from "./helpers/product_settlement.ts";
import { isPromise } from "./helpers/fixture_coordination.ts";

// Low-level owner controls intentionally hold acquisition/disposal themselves.
// Ordinary scenarios will use the fixture adapter (P03), not this test harness.
for (const rejects of [false, true]) {
  Deno.test(`ownership review: disposer then is captured once (rejects=${rejects})`, async () => {
    const scope = createOwnershipScope();
    const failure = new Error("thenable cleanup failed");
    let reads = 0, runs = 0, remaining = 0;
    scope.defer(() => remaining++);
    scope.defer(() => ({
      get then() {
        reads++;
        return reads === 1
          ? (resolve: () => void, reject: (error: unknown) => void) => {
            runs++;
            if (rejects) reject(failure);
            else resolve();
          }
          : undefined;
      },
    }));
    const result = await scope.releaseAll();
    assertEquals(reads, 1);
    assertEquals(runs, 1);
    assertEquals(remaining, 1);
    assertEquals(result.errors, rejects ? [failure] : []);
    assertEquals(scope.size, 0);
  });
}

Deno.test("ownership review: then getter failures and sync/async disposer failures share one report", async () => {
  const scope = createOwnershipScope();
  const failures = [new Error("getter"), new Error("sync"), new Error("async")];
  const order: string[] = [];
  scope.defer(() => {
    order.push("async");
    return Promise.reject(failures[2]);
  });
  scope.defer(() => {
    order.push("sync");
    throw failures[1];
  });
  scope.defer(() => ({
    get then() {
      order.push("getter");
      throw failures[0];
    },
  }));
  const result = await scope.releaseAll();
  assertEquals(order, ["getter", "sync", "async"]);
  assertEquals(result.errors, failures);
  assertEquals(scope.size, 0);
});

Deno.test("ownership review: promise input errors reject and never throw at invocation", async () => {
  const scope = createOwnershipScope(), foreign = createOwnershipScope();
  const retired = createOwnershipScope();
  retired.retire();
  const value = await scope.adopt("owned", () => {});
  const stale = await scope.adopt("transferred", () => {});
  const moved = scope.transfer(stale, foreign);
  const badDisposer = undefined as unknown as () => unknown;
  const badAllocator = undefined as unknown as () => unknown;
  const primary = new Error("allocation rejected");
  const cases: [
    string,
    () => Promise<unknown>,
    new (message?: string) => Error,
  ][] = [
    [
      "acquire retired",
      () => retired.acquire(() => "no", () => {}),
      OwnershipError,
    ],
    [
      "acquire allocator",
      () => scope.acquire(badAllocator, () => {}),
      TypeError,
    ],
    [
      "acquire disposer",
      () => scope.acquire(() => "no", badDisposer),
      TypeError,
    ],
    ["acquire throws", () =>
      scope.acquire(() => {
        throw primary;
      }, () => {}), Error],
    [
      "acquire rejects",
      () => scope.acquire(() => Promise.reject(primary), () => {}),
      Error,
    ],
    ["adopt disposer", () => scope.adopt("no", badDisposer), TypeError],
    [
      "adopt retired",
      () => retired.adopt("rollback", () => {}),
      OwnershipError,
    ],
    [
      "release raw",
      () => scope.release({} as OwnedResource<unknown>),
      OwnershipError,
    ],
    ["release clone", () => scope.release({ ...value }), OwnershipError],
    ["release foreign", () => foreign.release(value), OwnershipError],
    ["release stale", () => scope.release(stale), OwnershipError],
    ["release transferred", () => foreign.release(stale), OwnershipError],
  ];
  try {
    for (const [name, invoke, error] of cases) {
      // Deliberately outside assertRejects: a synchronous throw fails the test.
      const promise = invoke();
      assertEquals(isPromise(promise), true, name);
      await assertRejects(() => promise, error);
    }
  } finally {
    await scope.releaseAll();
    await foreign.release(moved);
    await foreign.releaseAll();
    await retired.releaseAll();
  }
});

Deno.test("ownership review: releaseAll keeps its cached promise and reports disposer errors without throwing", async () => {
  const scope = createOwnershipScope();
  const failure = new Error("disposer input failed");
  scope.defer(() => {
    throw failure;
  });
  // releaseAll has no invalid input; its declared failure channel is result.errors.
  const releasing = scope.releaseAll();
  assertEquals(isPromise(releasing), true);
  assert(scope.retired);
  assertStrictEquals(scope.releaseAll(), releasing);
  assertEquals((await releasing).errors, [failure]);
  assertStrictEquals(await scope.releaseAll(), await releasing);
});

Deno.test("ownership review: allocator retires its scope and the caller owns finalization", async () => {
  const scope = createOwnershipScope();
  const order: string[] = [];
  const acquiring = scope.acquire(async () => {
    scope.defer(() => order.push("partial"));
    await Promise.resolve();
    assertEquals(scope.retire(), true);
    await Promise.resolve();
    return "allocated";
  }, (value) => order.push(value));
  await assertRejects(() => acquiring, OwnershipError, "retired");
  assertEquals(order, ["allocated"]);
  assertEquals((await scope.releaseAll()).errors, []);
  assertEquals(order, ["allocated", "partial"]);
  assertEquals(scope.size, 0);
});

Deno.test("ownership: opaque identities and handles reject forged/foreign/cloned use", async () => {
  const a = createOwnershipScope(), b = createOwnershipScope();
  const identity = a.identity;
  assertStrictEquals(a.identity, identity);
  assert(Object.isFrozen(identity));
  assertThrows(() => a.assertCurrent(b.identity), OwnershipError, "Foreign");
  assertThrows(() => a.assertCurrent({} as OwnerIdentity), OwnershipError);
  let released = 0;
  const resource = await a.adopt({ bytes: "owned" }, () => released++);
  assert(Object.isFrozen(resource));
  for (const forged of [{ ...resource }, Object.create(resource), {}]) {
    await assertRejects(() => a.release(forged), OwnershipError);
  }
  await assertRejects(() => b.release(resource), OwnershipError);
  assertEquals(released, 0);
  await a.release(resource);
  await a.release(resource);
  assertEquals(released, 1);
  assertEquals(a.size, 0);
});

Deno.test("ownership: declarations prevent accidental structural handles", () => {
  // This function is never run; deno check checks the negative type contracts.
  async function checkedCaller() {
    const scope = createOwnershipScope();
    // @ts-expect-error identity must be factory-issued
    scope.assertCurrent({});
    // @ts-expect-error a raw resource is not a custody handle
    await scope.release({ value: "raw" });
    // @ts-expect-error arbitrary objects cannot receive custody
    scope.transfer({} as OwnedResource<string>, {});
  }
  assertEquals(typeof checkedCaller, "function");
});

Deno.test("ownership: defer reserves synchronously, without running work on rejected registration", async () => {
  const scope = createOwnershipScope();
  let closed = 0;
  scope.defer(() => closed++);
  assertEquals(scope.size, 1);
  assertEquals(closed, 0);
  scope.retire();
  assertThrows(() => scope.defer(() => closed++), OwnershipError, "retired");
  await scope.releaseAll();
  assertEquals(closed, 1);
  assertEquals(scope.size, 0);
});

Deno.test("ownership: retirement fences in the releaseAll call turn", async () => {
  const scope = createOwnershipScope();
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  await scope.adopt("resource", async () => {
    entered.resolve();
    await held.promise;
  });
  const releasing = scope.releaseAll();
  assert(scope.retired);
  assertThrows(() => scope.assertCurrent(), OwnershipError, "retired");
  await assertRejects(
    () => scope.acquire(() => "no", () => {}),
    OwnershipError,
  );
  assertEquals(scope.retire(), false);
  assertStrictEquals(scope.releaseAll(), releasing);
  await entered.promise;
  assertEquals(scope.size, 1);
  held.resolve();
  assertEquals((await releasing).errors, []);
  assertEquals(scope.size, 0);
});

for (const asynchronous of [false, true]) {
  for (let failing = 0; failing < 3; failing++) {
    Deno.test(`ownership: allocation ${failing} fails (${asynchronous ? "async" : "sync"}) without losing earlier custody`, async () => {
      const scope = createOwnershipScope(), released: number[] = [];
      const primary = new Error(`allocation ${failing}`);
      const work = (async () => {
        for (let i = 0; i < 3; i++) {
          await scope.acquire(() => {
            if (i === failing) {
              if (asynchronous) return Promise.reject(primary);
              throw primary;
            }
            return i;
          }, (value) => released.push(value));
        }
      })();
      const error = await work.catch((error) => error);
      assertStrictEquals(error, primary);
      const result = await scope.releaseAll();
      assertStrictEquals(
        assertThrows(() => result.throwIfFailed(primary)),
        primary,
      );
      assertEquals(
        released,
        Array.from({ length: failing }, (_, i) => i).reverse(),
      );
      assertEquals(scope.size, 0);
    });
  }
}

for (const rollbackFails of [false, true]) {
  Deno.test(`ownership: retirement during pending acquisition joins exact late rollback (failure=${rollbackFails})`, async () => {
    const scope = createOwnershipScope(), foreign = createOwnershipScope();
    const allocation = Promise.withResolvers<object>();
    const cleanupFailure = new Error("late rollback failed");
    const value = { exact: "candidate" };
    const released: object[] = [];
    await foreign.adopt({}, (value) => released.push(value));
    const acquiring = scope.acquire(() => allocation.promise, (got) => {
      released.push(got);
      if (rollbackFails) throw cleanupFailure;
    });
    const observed = acquiring.catch((error) => error);
    const releasing = scope.releaseAll();
    let settled = false;
    releasing.then(() => settled = true);
    await Promise.resolve();
    assertEquals(settled, false);
    allocation.resolve(value);
    const error = await observed;
    const result = await releasing;
    if (rollbackFails) {
      assertInstanceOf(error, AggregateError);
      assertInstanceOf(error.cause, OwnershipError);
      assertStrictEquals(error.errors[1], cleanupFailure);
      assertEquals(result.errors, [cleanupFailure]);
    } else {
      assertInstanceOf(error, OwnershipError);
      assertEquals(result.errors, []);
    }
    assertEquals(released, [value]);
    assertEquals(scope.size, 0);
    assertEquals(foreign.size, 1);
    await foreign.releaseAll();
  });
}

Deno.test("ownership: synchronous reentrant retirement during allocation rolls back once", async () => {
  const scope = createOwnershipScope();
  let closed = 0;
  const acquiring = scope.acquire(() => {
    scope.retire();
    return "created before callback returned";
  }, () => closed++);
  await assertRejects(() => acquiring, OwnershipError, "retired");
  assertEquals(closed, 1);
  assertEquals((await scope.releaseAll()).errors, []);
});

Deno.test("ownership: reentrant finalization before acquisition returns still owns its exact value", async () => {
  const scope = createOwnershipScope(), value = {};
  let releasing: ReturnType<typeof scope.releaseAll> | undefined;
  const released: object[] = [];
  const acquiring = scope.acquire(() => {
    releasing = scope.releaseAll();
    return value;
  }, (value) => released.push(value));
  await assertRejects(() => acquiring, OwnershipError, "retired");
  assertEquals((await releasing)?.errors, []);
  assertEquals(released, [value]);
  assertEquals(scope.size, 0);
});

Deno.test("ownership: partial constructor resources register before later setup rejects", async () => {
  const scope = createOwnershipScope(),
    primary = new Error("setup after partial allocation");
  const released: string[] = [];
  const acquiring = scope.acquire(async () => {
    scope.defer(() => released.push("partial child"));
    await Promise.resolve();
    throw primary;
  }, () => released.push("unreturned fixture"));
  assertStrictEquals(await acquiring.catch((error) => error), primary);
  const result = await scope.releaseAll();
  assertStrictEquals(
    assertThrows(() => result.throwIfFailed(primary)),
    primary,
  );
  assertEquals(released, ["partial child"]);
  assertEquals(scope.size, 0);
});

Deno.test("ownership: rejected adoption cannot escape before its held rollback settles", async () => {
  const scope = createOwnershipScope(),
    held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  scope.retire();
  let settled = false, released = false;
  const adoption = scope.adopt("late", async () => {
    entered.resolve();
    await held.promise;
    released = true;
  }).catch((error) => {
    settled = true;
    return error;
  });
  await entered.promise;
  assertEquals(settled, false);
  assertEquals(released, false);
  const releasing = scope.releaseAll();
  held.resolve();
  assertInstanceOf(await adoption, OwnershipError);
  assert(released);
  assertEquals((await releasing).errors, []);
  assertEquals(scope.size, 0);
});

Deno.test("ownership: late and reentrant adoption finish rollback even after finalization", async () => {
  const scope = createOwnershipScope(), released: string[] = [];
  await scope.adopt("first", async (value) => {
    const late = scope.adopt("reentrant", (late) => released.push(late));
    await assertRejects(() => late, OwnershipError, "retired");
    released.push(value);
  });
  const result = await scope.releaseAll();
  const failure = new Error("late close");
  const late = scope.adopt("after", (value) => {
    released.push(value);
    throw failure;
  });
  const error = await late.catch((error) => error);
  assertInstanceOf(error, AggregateError);
  assertInstanceOf(error.cause, OwnershipError);
  assertStrictEquals(error.errors[1], failure);
  assertEquals(released, ["reentrant", "first", "after"]);
  assertEquals(scope.size, 0);
  assertStrictEquals(await scope.releaseAll(), result);
});

Deno.test("ownership: explicit transfer invalidates source handles and leaves foreign custody alone", async () => {
  const a = createOwnershipScope(),
    b = createOwnershipScope(),
    foreign = createOwnershipScope();
  const closed: string[] = [];
  const first = await a.adopt("transferred", (value) => closed.push(value));
  const other = await foreign.adopt("foreign", (value) => closed.push(value));
  const moved = a.transfer(first, b);
  assertStrictEquals(first.value, moved.value);
  await assertRejects(() => a.release(first), OwnershipError);
  await assertRejects(() => b.release(first), OwnershipError);
  assertThrows(() => a.transfer(other, b), OwnershipError);
  assertThrows(() => a.transfer(moved, b), OwnershipError);
  assertEquals((await a.releaseAll()).errors, []);
  assertEquals(closed, []);
  assertEquals([a.size, b.size, foreign.size], [0, 1, 1]);
  await b.release(moved);
  await b.releaseAll();
  assertEquals(closed, ["transferred"]);
  await foreign.release(other);
  assertEquals(closed, ["transferred", "foreign"]);
});

Deno.test("ownership: rejected transfers retain source custody", async () => {
  const source = createOwnershipScope(), retired = createOwnershipScope();
  retired.retire();
  let closed = 0;
  const handle = await source.adopt("candidate", () => closed++);
  assertThrows(
    () => source.transfer(handle, retired),
    OwnershipError,
    "retired",
  );
  assertThrows(
    () => source.transfer(handle, { ...retired }),
    OwnershipError,
    "issued",
  );
  assertEquals(source.size, 1);
  source.retire();
  assertThrows(
    () => source.transfer(handle, createOwnershipScope()),
    OwnershipError,
    "retired",
  );
  await source.releaseAll();
  assertEquals(closed, 1);
});

for (let failing = 0; failing < 4; failing++) {
  Deno.test(`ownership: every release attempted when disposer ${failing} fails, preserving primary`, async () => {
    const scope = createOwnershipScope(), released: number[] = [];
    const primary = new Error("original scenario failure"),
      cleanup = new Error(`disposer ${failing}`);
    for (let i = 0; i < 4; i++) {
      await scope.adopt(i, async (value) => {
        released.push(value);
        await Promise.resolve();
        if (value === failing) throw cleanup;
      });
    }
    const result = await scope.releaseAll();
    assertEquals(released, [3, 2, 1, 0]);
    assertEquals(scope.size, 0);
    const error = assertThrows(() => result.throwIfFailed(primary));
    assertInstanceOf(error, AggregateError);
    assertStrictEquals(error.cause, primary);
    assertEquals(error.errors, [primary, cleanup]);
    assertStrictEquals(await scope.releaseAll(), result);
    assertEquals(released, [3, 2, 1, 0]);
  });
}

Deno.test("ownership: reentrant and concurrent release share exactly one disposer", async () => {
  const scope = createOwnershipScope(),
    entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let runs = 0, reentrant: Promise<void> | undefined;
  const handle = await scope.adopt("value", async () => {
    runs++;
    reentrant = scope.release(handle);
    entered.resolve();
    await held.promise;
  });
  const releasing = scope.release(handle);
  await entered.promise;
  assertThrows(
    () => scope.transfer(handle, createOwnershipScope()),
    OwnershipError,
    "started",
  );
  const all = scope.releaseAll();
  held.resolve();
  await releasing;
  await reentrant;
  assertEquals((await all).errors, []);
  assertEquals(runs, 1);
  assertEquals(scope.size, 0);
});

Deno.test("ownership: all failures retain order, identity and even thrown undefined", async () => {
  const scope = createOwnershipScope(),
    first = new Error("first"),
    last = new Error("last");
  await scope.adopt(null, () => {
    throw last;
  });
  await scope.adopt(null, () => {
    throw first;
  });
  const result = await scope.releaseAll();
  assert(Object.isFrozen(result) && Object.isFrozen(result.errors));
  const error = assertThrows(() => result.throwIfFailed(undefined));
  assertInstanceOf(error, AggregateError);
  assertEquals(error.errors, [undefined, first, last]);
  assertStrictEquals(error.cause, undefined);
  const empty = await createOwnershipScope().releaseAll();
  let caught = false;
  try {
    empty.throwIfFailed(undefined);
  } catch (error) {
    caught = true;
    assertStrictEquals(error, undefined);
  }
  assert(caught);
});

for (
  const phase of [
    "before-marker",
    "after-marker",
    "cancellation",
    "finalization",
  ] as const
) {
  Deno.test(`ownership: ${phase} failure releases owned resources and preserves the operation's error`, async () => {
    const scope = createOwnershipScope(),
      marker = Promise.withResolvers<void>();
    const primary = new Error(phase),
      cleanup = new Error("cleanup also failed");
    const released: string[] = [];
    const cancel = new AbortController();
    const onAbort = () => scope.retire();
    cancel.signal.addEventListener("abort", onAbort);
    await scope.adopt(onAbort, (listener) => {
      cancel.signal.removeEventListener("abort", listener);
      released.push("listener");
    });
    await scope.adopt("root", (value) => released.push(value));
    await scope.adopt("child", (value) => {
      released.push(value);
      if (phase === "finalization") throw cleanup;
    });
    const completion = (async () => {
      if (phase === "before-marker") throw primary;
      marker.resolve();
      if (phase === "cancellation") {
        cancel.abort(primary);
        assertThrows(() => scope.assertCurrent(), OwnershipError);
      }
      await Promise.resolve();
      throw primary;
    })();
    // The existing settlement owner, not a new core wait/deadline algorithm.
    const observed = await workMilestone(completion, marker.promise, phase)
      .then(
        () => completion.catch((error) => error),
        (error) => error,
      );
    assertStrictEquals(observed, primary);
    const result = await scope.releaseAll();
    const error = assertThrows(() => result.throwIfFailed(observed));
    if (phase === "finalization") {
      assertInstanceOf(error, AggregateError);
      assertEquals(error.errors, [primary, cleanup]);
      assertStrictEquals(error.cause, primary);
    } else assertStrictEquals(error, primary);
    assertEquals(released, ["child", "root", "listener"]);
    assertEquals(scope.size, 0);
  });
}
