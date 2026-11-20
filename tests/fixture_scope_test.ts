// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
} from "./helpers/fixture_scope_engine.ts";
import { OwnershipError } from "../shared/ownership.js";
import { workMilestone } from "./helpers/product_settlement.ts";

async function caught(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}

Deno.test("fixture scope review: invocation errors reject through the adapter", async () => {
  const owner = createFixtureScope();
  const invalid = undefined as unknown as () => never;
  try {
    for (
      const invoke of [
        () => owner.scope.acquire(invalid, () => {}),
        () => owner.scope.acquire(() => "no", invalid),
        () => owner.scope.adopt("no", invalid),
      ]
    ) {
      const promise = invoke();
      assertInstanceOf(promise, Promise);
      await assertRejects(() => promise, TypeError);
    }
    await owner.close();
    const acquiring = owner.scope.acquire(() => "late", () => {});
    assertInstanceOf(acquiring, Promise);
    await assertRejects(() => acquiring, OwnershipError, "retired");
    let rolledBack = false;
    const adopting = owner.scope.adopt("late", () => {
      rolledBack = true;
    });
    assertInstanceOf(adopting, Promise);
    await assertRejects(() => adopting, OwnershipError, "retired");
    assert(rolledBack);
    assertEquals(owner.scope.size, 0);
  } finally {
    await owner.close();
  }
});

Deno.test("fixture scope review: thenable disposer is awaited once before scenario completion", async () => {
  const failure = new Error("fixture thenable cleanup");
  const events: string[] = [];
  let reads = 0;
  const error = await caught(() =>
    fixtureScope(async (scope) => {
      scope.defer(() => events.push("remaining"));
      await scope.adopt("owned", () => ({
        get then() {
          reads++;
          return reads === 1
            ? (_resolve: () => void, reject: (error: unknown) => void) => {
              events.push("dispose");
              reject(failure);
            }
            : undefined;
        },
      }));
    }, { report: () => events.push("report") })
  );
  assertStrictEquals(error, failure);
  assertEquals(reads, 1);
  assertEquals(events, ["report", "dispose", "remaining"]);
});

for (const asynchronous of [false, true]) {
  for (
    const failing of [
      "allocation-0",
      "allocation-1",
      "allocation-2",
      "setup",
      "body",
      "report",
      "close-0",
      "close-1",
      "close-2",
    ]
  ) {
    Deno.test(`fixture scope: ${failing} (${asynchronous ? "async" : "sync"}) retains cause and all remaining cleanup`, async () => {
      const primary = new Error(failing);
      const events: string[] = [];
      const live = new Set<number>();
      let owner!: FixtureScope;
      const result = await caught(() =>
        fixtureScope(async (scope) => {
          owner = scope;
          // This preparation deliberately precedes the scenario's own try block.
          for (let i = 0; i < 3; i++) {
            await scope.acquire(() => {
              events.push(`allocation-${i}`);
              if (failing === `allocation-${i}`) {
                if (asynchronous) return Promise.reject(primary);
                throw primary;
              }
              live.add(i);
              return asynchronous ? Promise.resolve(i) : i;
            }, (resource) => {
              events.push(`close-${resource}`);
              live.delete(resource);
              if (failing === `close-${resource}`) {
                if (asynchronous) return Promise.reject(primary);
                throw primary;
              }
            });
          }
          events.push("setup");
          if (failing === "setup") throw primary;
          try {
            events.push("body");
            if (failing === "body") throw primary;
          } finally {
            events.push("body-finally");
          }
        }, {
          report: () => {
            events.push("report");
            if (failing === "report") throw primary;
          },
        })
      );
      assertStrictEquals(result, primary);
      assertEquals(owner.size, 0);
      assertEquals([...live], []);
      const count = failing.startsWith("allocation-")
        ? Number(failing.at(-1))
        : 3;
      assertEquals(
        events.filter((event) => event.startsWith("close-")),
        Array.from({ length: count }, (_, i) => `close-${count - 1 - i}`),
      );
      assert(
        events.indexOf("report") <
          (events.findIndex((event) => event.startsWith("close-")) < 0
            ? events.length
            : events.findIndex((event) => event.startsWith("close-"))),
      );
      assertEquals(
        events.includes("body"),
        !failing.startsWith("allocation-") && failing !== "setup",
      );
    });
  }
}

Deno.test("fixture scope: report and all closes preserve an original body error", async () => {
  const primary = new Error("body"), report = new Error("report");
  const closes = [new Error("root"), new Error("runtime")];
  let scope!: FixtureScope;
  const error = await caught(() =>
    fixtureScope((owner) => {
      scope = owner;
      owner.defer(() => {
        throw closes[0];
      });
      owner.defer(() => {
        throw closes[1];
      });
      throw primary;
    }, {
      report: () => {
        throw report;
      },
    })
  );
  assert(error instanceof AggregateError);
  assertStrictEquals(error.cause, primary);
  assertStrictEquals(error.errors[0], primary);
  assertStrictEquals(error.errors[1], report);
  assert(error.errors[2] instanceof AggregateError);
  assertEquals(error.errors[2].errors, closes.toReversed());
  assertEquals(scope.size, 0);
});

Deno.test("fixture scope: success returns the body value; thrown undefined is not swallowed", async () => {
  let closed = 0;
  const result = await fixtureScope((scope) => {
    scope.defer(() => closed++);
    return 17;
  });
  assertEquals([result, closed], [17, 1]);
  let caughtUndefined = false;
  try {
    await fixtureScope(() => {
      throw undefined;
    });
  } catch (error) {
    caughtUndefined = true;
    assertStrictEquals(error, undefined);
  }
  assert(caughtUndefined);
});

Deno.test("fixture scope: constructor rejection releases before its owner can escape", async () => {
  const owner = createFixtureScope(), primary = new Error("prepare");
  let closed = false;
  const error = await caught(() =>
    owner.prepare(async (scope) => {
      await scope.acquire(() => "root", () => {
        closed = true;
      });
      throw primary;
    })
  );
  assertStrictEquals(error, primary);
  assert(closed);
  assertEquals(owner.scope.size, 0);
  await owner.close();
});

Deno.test("fixture scope: cleanup releases a held gate before joining owned work", async () => {
  const gate = Promise.withResolvers<void>(), primary = new Error("scenario");
  const events: string[] = [];
  const work = gate.promise.then(() => {
    events.push("drained");
  });
  const error = await caught(() =>
    fixtureScope((scope) => {
      scope.defer(() => work);
      scope.defer(() => {
        events.push("release");
        gate.resolve();
      });
      throw primary;
    })
  );
  assertStrictEquals(error, primary);
  assertEquals(events, ["release", "drained"]);
});

Deno.test("fixture scope: retirement during allocation and late adoption roll back before rejecting", async () => {
  const owner = createFixtureScope(), gate = Promise.withResolvers<string>();
  const events: string[] = [];
  const pending = owner.scope.acquire(() => gate.promise, (value) => {
    events.push(value);
  });
  const rejected = assertRejects(() => pending, OwnershipError, "retired");
  const closing = owner.close();
  gate.resolve("late allocation");
  await Promise.all([closing, rejected]);
  await assertRejects(
    () =>
      owner.scope.adopt("late adoption", (value) => {
        events.push(value);
      }),
    OwnershipError,
    "retired",
  );
  assertEquals(events, ["late allocation", "late adoption"]);
  assertEquals(owner.scope.size, 0);
});

Deno.test("fixture scope: synchronous reentrant registration remains owned", async () => {
  const owner = createFixtureScope();
  const events: string[] = [];
  await owner.prepare((scope) =>
    scope.acquire(() => {
      scope.defer(() => {
        events.push("nested");
      });
      return "outer";
    }, () => {
      events.push("outer");
    })
  );
  await owner.close();
  await owner.close();
  assertEquals(events, ["nested", "outer"]);
  assertEquals(owner.scope.size, 0);
});

Deno.test("fixture scope: reporting observes retired custody but resources remain until it completes", async () => {
  let scope!: FixtureScope;
  const report = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let closed = false;
  const running = fixtureScope((owner) => {
    scope = owner;
    owner.defer(() => {
      closed = true;
    });
  }, {
    report: async () => {
      assertEquals(scope.size, 1);
      await assertRejects(
        () => scope.acquire(() => "late", () => {}),
        OwnershipError,
        "retired",
      );
      entered.resolve();
      await report.promise;
    },
  });
  try {
    await workMilestone(running, entered.promise, "fixture report entered");
    assertEquals(closed, false);
  } finally {
    report.resolve();
    await running;
  }
  assert(closed);
  assertEquals(scope.size, 0);
});
