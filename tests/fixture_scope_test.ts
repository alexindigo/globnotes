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
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
  ownFixtureScope,
} from "./helpers/fixture_scope_engine.ts";
import { OwnershipError } from "../shared/ownership.js";
import { workMilestone } from "./helpers/product_settlement.ts";
import {
  fixtureGate,
  fixtureTest,
  isPromise,
  waitForCancellation,
} from "./helpers/fixture_coordination.ts";

async function caught(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}

fixtureTest(
  "fixture links: sequential borrowers retire every root edge",
  async (testScope) => {
    const root = createFixtureScope();
    testScope.defer(() => root.close());
    for (let i = 0; i < 100; i++) {
      const child = createFixtureScope();
      ownFixtureScope(root.scope, child.scope);
      ownFixtureScope(root.scope, child.scope);
      assertEquals(root.scope.size, 1);
      await child.close();
      assertEquals(child.scope.size, 0);
      assertEquals(root.scope.size, 0, `borrower ${i} left a root edge`);
    }
  },
);

fixtureTest(
  "fixture links: root close still joins a child drain already in progress",
  async (testScope) => {
    const root = createFixtureScope(), child = createFixtureScope();
    const entered = fixtureGate(testScope), release = fixtureGate(testScope);
    let released = false, drained = false;
    root.scope.defer(() => {
      assert(drained);
      released = true;
    });
    ownFixtureScope(root.scope, child.scope);
    const work = child.scope.admit(async () => {
      entered.resolve();
      await release.promise;
      drained = true;
    });
    const rejected = assertRejects(() => work, OwnershipError, "retired");
    await entered.promise;
    const childClose = child.close();
    childClose.catch(() => {});
    assert(child.scope.signal.aborted);
    assertEquals(root.scope.size, 2);
    const rootClose = root.close();
    rootClose.catch(() => {});
    assertEquals(released, false);
    release.resolve();
    await Promise.all([rootClose, childClose, rejected]);
    assert(released);
    assertEquals([root.scope.size, child.scope.size], [0, 0]);
  },
);

Deno.test("fixture coordination: scenario failure cancels every admitted gate", async () => {
  const primary = new Error("failed scenario");
  let scope!: FixtureScope, gate!: ReturnType<typeof fixtureGate>;
  const error = await caught(() =>
    fixtureScope((owner) => {
      scope = owner;
      gate = fixtureGate(owner);
      assertEquals(
        owner.size,
        1,
        "a gate must be admitted before its first wait",
      );
      throw primary;
    })
  );
  assertStrictEquals(error, primary);
  await assertRejects(() => gate.promise, OwnershipError, "retired");
  assertEquals(scope.size, 0);
});

Deno.test("fixture coordination: completed gates remove their signal links promptly", async () => {
  await fixtureScope(async (scope) => {
    const signal = scope.signal, listeners = new Set<unknown>();
    const add = signal.addEventListener.bind(signal),
      remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "abort") listeners.add(listener);
      add(type, listener, options);
    };
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "abort") listeners.delete(listener);
      remove(type, listener, options);
    };
    for (let i = 0; i < 100; i++) {
      const gate = fixtureGate(scope);
      gate.resolve();
      await gate.promise;
      assertEquals(listeners.size, 0, "completed gate retained a signal link");
      assertEquals(scope.size, 0, "completed gate retained its admission");
    }
  });
});

fixtureTest(
  "fixture phases: every cancellation hook starts before drain and reverse-order release",
  async (testScope) => {
    const owner = createFixtureScope(), hookGate = fixtureGate(testScope);
    const events: string[] = [];
    let active = 0;
    owner.scope.defer(() => {
      assertEquals(active, 0);
      events.push("release-first");
    });
    owner.scope.onCancel(async (signal) => {
      assertStrictEquals(signal, owner.scope.signal);
      assert(signal.aborted);
      events.push("cancel-early");
      await hookGate.promise;
    });
    const running = owner.scope.admit((signal) => {
      active++;
      return waitForCancellation(signal).finally(() => {
        active--;
        events.push("drained");
      });
    });
    const rejected = assertRejects(() => running, OwnershipError, "retired");
    owner.scope.defer(() => {
      assertEquals(active, 0);
      events.push("release-last");
    });
    owner.scope.onCancel(() => {
      events.push("cancel-late");
      hookGate.resolve();
    });
    const closing = owner.close();
    assert(owner.scope.signal.aborted);
    assertEquals(events, ["cancel-early", "cancel-late"]);
    await Promise.all([closing, rejected]);
    assertEquals(events, [
      "cancel-early",
      "cancel-late",
      "drained",
      "release-last",
      "release-first",
    ]);
    assertEquals(owner.scope.size, 0);
    await owner.close();
    assertEquals(events.length, 5);
  },
);

for (const first of ["owner", "borrower"] as const) {
  for (const registration of ["before", "after"] as const) {
    Deno.test(`fixture phases: ${first} closes first with ${registration}-admission hooks`, async () => {
      const owner = createFixtureScope(), borrower = createFixtureScope();
      const closingFirst = first === "owner" ? owner : borrower;
      const closingSecond = first === "owner" ? borrower : owner;
      const events: string[] = [];
      let active = 0, ioSignal!: AbortSignal;
      for (
        const [label, fixture] of [["owner", owner], [
          "borrower",
          borrower,
        ]] as const
      ) {
        fixture.scope.defer(() => {
          assertEquals(active, 0);
          events.push(`${label}-release`);
        });
      }
      const hooks = () => {
        owner.scope.onCancel((signal) => {
          assertStrictEquals(signal, owner.scope.signal);
          events.push("owner-cancel");
        });
        borrower.scope.onCancel((signal) => {
          assertStrictEquals(signal, borrower.scope.signal);
          events.push("borrower-cancel");
        });
      };
      if (registration === "before") hooks();
      const running = owner.scope.admit((signal) => {
        ioSignal = signal;
        active++;
        return waitForCancellation(signal).finally(() => {
          active--;
          events.push("drained");
        });
      }, borrower.scope);
      const rejected = assertRejects(() => running, OwnershipError, "retired");
      if (registration === "after") hooks();
      try {
        await closingFirst.close();
        await rejected;
        assertStrictEquals(ioSignal.reason, closingFirst.scope.signal.reason);
        assertEquals(closingSecond.scope.signal.aborted, false);
        assertEquals(events, [
          `${first}-cancel`,
          "drained",
          `${first}-release`,
        ]);
        // Only its resource and lifetime hook remain, never an admission record.
        assertEquals(closingSecond.scope.size, 2);
      } finally {
        try {
          await owner.close();
        } finally {
          await borrower.close();
        }
      }
      assertEquals([owner.scope.size, borrower.scope.size], [0, 0]);
      assertEquals(events.length, 5);
    });
  }
}

fixtureTest(
  "fixture phases: throwing and rejected hooks cannot skip later cancellation or release",
  async (testScope) => {
    const owner = createFixtureScope(), gate = fixtureGate(testScope);
    const failures = [
      new Error("sync cancellation"),
      new Error("async cancellation"),
    ];
    const events: string[] = [];
    owner.scope.onCancel(() => {
      events.push("throw");
      throw failures[0];
    });
    owner.scope.onCancel(() => {
      events.push("reject");
      return Promise.reject(failures[1]);
    });
    owner.scope.onCancel(async () => {
      events.push("wait");
      await gate.promise;
    });
    owner.scope.onCancel(() => {
      events.push("last");
      gate.resolve();
    });
    owner.scope.defer(() => {
      events.push("released");
    });
    const closing = owner.close();
    assertEquals(events, ["throw", "reject", "wait", "last"]);
    const error = await caught(() => closing);
    assertInstanceOf(error, AggregateError);
    assertEquals(error.errors, failures.toReversed());
    assertEquals(events.at(-1), "released");
    assertEquals(owner.scope.size, 0);
  },
);

for (const rejects of [false, true]) {
  Deno.test(`fixture phases: cancellation results resolve then exactly once (rejects=${rejects})`, async () => {
    const owner = createFixtureScope(),
      failure = new Error("thenable cancellation");
    let reads = 0, released = false;
    owner.scope.defer(() => {
      released = true;
    });
    owner.scope.onCancel(() => ({
      get then() {
        reads++;
        if (reads > 1) throw new Error("cancellation result resolved again");
        return (resolve: () => void, reject: (error: unknown) => void) =>
          rejects ? reject(failure) : resolve();
      },
    }));
    if (rejects) assertStrictEquals(await caught(() => owner.close()), failure);
    else await owner.close();
    assertEquals(reads, 1);
    assert(released);
    assertEquals(owner.scope.size, 0);
  });
}

Deno.test("fixture phases: reentrant close joins cancellation without repeating it", async () => {
  const owner = createFixtureScope();
  let cancellations = 0, releases = 0, reentrant: Promise<void> | undefined;
  owner.scope.onCancel(() => {
    cancellations++;
    reentrant = owner.close();
  });
  owner.scope.defer(() => {
    releases++;
  });
  await owner.close();
  await reentrant;
  assertEquals([cancellations, releases, owner.scope.size], [1, 1, 0]);
  assertThrows(() => owner.scope.onCancel(() => {}), OwnershipError, "retired");
});

Deno.test("fixture phases: original failure survives cancellation and release failures", async () => {
  const primary = new Error("original scenario"),
    cancellation = new Error("cancel hook"),
    release = new Error("resource release");
  let scope!: FixtureScope,
    drained = false,
    running: Promise<unknown> | undefined;
  const error = await caught(() =>
    fixtureScope((owner) => {
      scope = owner;
      owner.onCancel(() => {
        throw cancellation;
      });
      owner.defer(() => {
        assert(drained);
        throw release;
      });
      running = owner.admit((signal) =>
        waitForCancellation(signal).finally(() => {
          drained = true;
        })
      );
      running.catch(() => {});
      throw primary;
    })
  );
  await running?.catch(() => {});
  assertInstanceOf(error, AggregateError);
  assertStrictEquals(error.cause, primary);
  assertStrictEquals(error.errors[0], primary);
  const failures = (value: unknown): unknown[] =>
    value instanceof AggregateError ? value.errors.flatMap(failures) : [value];
  assertEquals(failures(error), [primary, cancellation, release]);
  assertEquals(scope.size, 0);
});

Deno.test("fixture phases: root retirement cancels a borrowed channel before joining co-owned IO", async () => {
  const owner = createFixtureScope(), borrower = createFixtureScope();
  const channel = new AbortController();
  ownFixtureScope(owner.scope, borrower.scope);
  borrower.scope.onCancel((signal) => channel.abort(signal.reason));
  let active = 0, released = false;
  owner.scope.defer(() => {
    assertEquals(active, 0);
    assert(borrower.scope.signal.aborted);
    released = true;
  });
  const running = owner.scope.admit(() => {
    active++;
    return waitForCancellation(channel.signal).finally(() => active--);
  }, borrower.scope);
  const rejected = assertRejects(() => running, OwnershipError, "retired");
  await owner.close();
  await rejected;
  await borrower.close();
  assert(released);
  assertEquals([owner.scope.size, borrower.scope.size], [0, 0]);
});

for (const closing of ["resource", "borrower"] as const) {
  fixtureTest(
    `fixture admission: ${closing} retirement drains co-owned work`,
    async (testScope) => {
      const resource = createFixtureScope(), borrower = createFixtureScope();
      const held = fixtureGate<string>(testScope);
      const events: string[] = [];
      resource.scope.defer(() => {
        events.push("resource");
      });
      borrower.scope.defer(() => {
        events.push("borrower");
      });
      const running = resource.scope.admit(() => held.promise, borrower.scope);
      const rejected = assertRejects(() => running, OwnershipError, "retired");
      const retiring = closing === "resource" ? resource : borrower;
      let draining: Promise<void> | undefined;
      try {
        assertEquals([resource.scope.size, borrower.scope.size], [2, 2]);
        draining = retiring.close();
        assertEquals(events, []);
        let effects = 0;
        await assertRejects(
          () =>
            resource.scope.admit(() => {
              effects++;
            }, borrower.scope),
          OwnershipError,
          "retired",
        );
        assertEquals(effects, 0);
      } finally {
        draining ??= retiring.close();
        held.resolve("finished");
        try {
          await Promise.all([draining, rejected]);
        } finally {
          try {
            await resource.close();
          } finally {
            await borrower.close();
          }
        }
      }
      assertEquals(
        events,
        closing === "resource"
          ? ["resource", "borrower"]
          : ["borrower", "resource"],
      );
      assertEquals([resource.scope.size, borrower.scope.size], [0, 0]);
    },
  );
}

Deno.test("fixture admission: completed work releases reservations without resolving result data again", async () => {
  const resource = createFixtureScope(), borrower = createFixtureScope();
  let reads = 0, entered = false;
  const value = {
    get then(): undefined {
      if (++reads > 1) throw new Error("admitted data resolved again");
      return undefined;
    },
  };
  try {
    const running = resource.scope.admit(
      () => {
        entered = true;
        return value;
      },
      borrower.scope,
      resource.scope,
    );
    running.catch(() => {});
    assert(entered, "admission must enter its effect synchronously");
    const result = await running;
    assertStrictEquals(result.value, value);
    assertEquals(reads, 1);
    assertEquals([resource.scope.size, borrower.scope.size], [0, 0]);
  } finally {
    await resource.close();
    await borrower.close();
  }
});

for (const mode of ["acquire", "adopt"] as const) {
  Deno.test(`fixture values: ${mode} crosses async boundaries only as a handle`, async () => {
    let reads = 0;
    const resource = {
      value: "resource payload",
      get then(): undefined {
        reads++;
        if (mode === "adopt" || reads > 1) {
          throw new Error("resource was resolved again");
        }
        return undefined;
      },
    };
    let disposed: unknown;
    await fixtureScope(async (scope) => {
      const handle = mode === "acquire"
        ? await scope.acquire(() => resource, (value) => {
          disposed = value;
        })
        : await scope.adopt(resource, (value) => {
          disposed = value;
        });
      assertStrictEquals(handle.value, resource);
    });
    assertStrictEquals(disposed, resource);
    assertEquals(reads, mode === "acquire" ? 1 : 0);
  });
}

Deno.test("fixture capabilities: binding checks the owner and never resolves the effect result", async () => {
  const owner = createFixtureScope();
  let effects = 0;
  const result = {
    get then(): never {
      throw new Error("bound result resolved");
    },
  };
  const invoke = owner.scope.bind(() => {
    effects++;
    return result;
  });
  try {
    assertStrictEquals(invoke(), result);
  } finally {
    await owner.close();
  }
  assertThrows(invoke, OwnershipError);
  assertEquals(effects, 1);
});

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
      assert(isPromise(promise));
      await assertRejects(() => promise, TypeError);
    }
    await owner.close();
    const acquiring = owner.scope.acquire(() => "late", () => {});
    assert(isPromise(acquiring));
    await assertRejects(() => acquiring, OwnershipError, "retired");
    let rolledBack = false;
    const adopting = owner.scope.adopt("late", () => {
      rolledBack = true;
    });
    assert(isPromise(adopting));
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
      assertEquals(events.filter((event) => event === "report").length, 1);
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

fixtureTest(
  "fixture scope: cleanup releases a held gate before joining owned work",
  async (testScope) => {
    const gate = fixtureGate(testScope), primary = new Error("scenario");
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
  },
);

fixtureTest(
  "fixture scope: retirement during allocation and late adoption roll back before rejecting",
  async (testScope) => {
    const owner = createFixtureScope(), gate = fixtureGate<string>(testScope);
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
  },
);

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

fixtureTest(
  "fixture scope: reporting observes retired custody but resources remain until it completes",
  async (testScope) => {
    let scope!: FixtureScope;
    const report = fixtureGate(testScope), entered = fixtureGate(testScope);
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
  },
);
