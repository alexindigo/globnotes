// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as native from "../client/tests/e2e/fixture-ownership.mjs";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { createFixtureScope } from "./helpers/fixture_scope_engine.ts";
import {
  fixtureGate,
  waitForCancellation,
} from "./helpers/fixture_coordination.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { OwnershipError } from "../shared/ownership.js";
import {
  closeNativeCase,
  createNativeCaseLifetime,
} from "../client/tests/e2e/native-case-finalization.mjs";
import { browserOwnershipControl } from "../client/tests/e2e/native-ownership-control.mjs";

// Cleanup containment must never replace the assertion that required rescue.
async function finish(
  join: Promise<unknown>[],
  failed: boolean,
  label: string,
) {
  try {
    for (const result of await bounded(Promise.allSettled(join), label)) {
      if (result.status === "rejected") throw result.reason;
    }
  } catch (error) {
    if (!failed) throw error;
  }
}

Deno.test("native test cleanup joins every result without replacing a primary failure", async () => {
  const primary = new Error("body failed"),
    cleanup = new Error("cleanup failed");
  const events: string[] = [];
  const observed = await assertRejects(
    async () => {
      try {
        throw primary;
      } finally {
        await finish(
          [
            Promise.reject(cleanup),
            Promise.resolve().then(() => {
              events.push("sibling joined");
            }),
          ],
          true,
          "native primary cleanup",
        );
      }
    },
    Error,
    "body failed",
  );
  assertStrictEquals(observed, primary);
  assertEquals(events, ["sibling joined"]);
  assertStrictEquals(
    await assertRejects(
      () =>
        finish([Promise.reject(cleanup)], false, "native cleanup-only failure"),
      Error,
      "cleanup failed",
    ),
    cleanup,
  );
});

Deno.test("native case interruption cancels and drains both scopes before the retained fixture", async () => {
  await fixtureScope(async (testScope) => {
    const events: string[] = [], scopes: FixtureScope[] = [];
    const entered = fixtureGate(testScope), rescue = new AbortController();
    const lifetime = createNativeCaseLifetime(() =>
      events.push("fixture:closed")
    );
    let count = 0;
    const fixture = {
      baseUrl: "http://globnotes.test:9000",
      ownScope(scope: FixtureScope) {
        lifetime.ownScope(scope);
        scopes.push(scope);
      },
      session: {
        targetId: "retained",
        browserContextId: "context:retained",
        goto: () => {},
        browser: {
          send: (method: string) =>
            method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "retained", type: "page" }] }
              : { browserContextIds: ["context:retained"] },
        },
      },
    };
    const running = browserOwnershipControl(fixture, {
      launch: () => ({ label: count++ ? "A" : "B" }),
      connectPage: ({ binding }: { binding: { label: string } }) => ({
        targetId: binding.label,
        browserContextId: `context:${binding.label}`,
        async goto() {
          events.push(`admit:${binding.label}`);
          entered.resolve();
          try {
            await waitForCancellation(
              AbortSignal.any([scopes.at(-1)!.signal, rescue.signal]),
            );
          } finally {
            events.push(`drain:${binding.label}`);
          }
        },
        close: () => {
          events.push(`close:${binding.label}`);
        },
      }),
      stop: (binding: { label: string }) => {
        events.push(`stop:${binding.label}`);
      },
    } as unknown as NonNullable<Parameters<typeof browserOwnershipControl>[1]>);
    const checked = assertRejects(
      () => running,
      OwnershipError,
      "Fixture scope retired",
    );
    let failed = false;
    try {
      await bounded(
        workMilestone(checked, entered.promise, "A admitted"),
        "native interrupt admission",
      );
      await bounded(lifetime.close(), "native interrupted case close");
      assertStrictEquals(
        await bounded(checked, "native interrupted pilot"),
        scopes[1].signal.reason,
      );
      assertEquals(events, [
        "admit:A",
        "drain:A",
        "close:A",
        "stop:A",
        "close:B",
        "stop:B",
        "fixture:closed",
      ]);
      await bounded(lifetime.close(), "native interrupted close is idempotent");
      assertEquals(scopes.map((scope) => [scope.signal.aborted, scope.size]), [[
        true,
        0,
      ], [true, 0]]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      rescue.abort(new OwnershipError("Fixture scope retired"));
      await finish(
        [checked, lifetime.close()],
        failed,
        "native interruption rescue join",
      );
    }
  });
});

for (const pending of [false, true]) {
  Deno.test(`native case retains a child's ${pending ? "pending" : "settled"} teardown failure before joining`, async () => {
    await fixtureScope(async (testScope) => {
      const entered = fixtureGate(testScope), release = fixtureGate(testScope);
      const failure = new Error("child teardown failed"), events: string[] = [];
      const child = createFixtureScope();
      const lifetime = createNativeCaseLifetime(() => {
        assertEquals(events, ["body", "dispose:start", "dispose:failed"]);
        events.push("fixture:closed");
      });
      lifetime.ownScope(child.scope);
      lifetime.ownScope(child.scope);
      child.scope.defer(async () => {
        events.push("dispose:start");
        entered.resolve();
        await release.promise;
        events.push("dispose:failed");
        throw failure;
      });
      const checked = assertRejects(
        () =>
          child.run(() => {
            events.push("body");
          }),
        Error,
        "child teardown failed",
      );
      let failed = false;
      try {
        await bounded(
          workMilestone(checked, entered.promise, "child teardown entered"),
          "child teardown entry",
        );
        if (!pending) {
          release.resolve();
          assertStrictEquals(
            await bounded(checked, "child finishes before case join"),
            failure,
          );
        }
        const closing = assertRejects(
          () => lifetime.close(),
          Error,
          "child teardown failed",
        );
        release.resolve();
        assertStrictEquals(
          await bounded(closing, "case retains child failure"),
          failure,
        );
        assertStrictEquals(
          await bounded(checked, "child teardown result"),
          failure,
        );
        assertEquals(events, [
          "body",
          "dispose:start",
          "dispose:failed",
          "fixture:closed",
        ]);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        release.resolve();
        await finish(
          [
            checked,
            child.close().catch((error) => {
              assertStrictEquals(error, failure);
            }),
            lifetime.close().catch((error: unknown) => {
              assertStrictEquals(error, failure);
            }),
          ],
          failed,
          "retained child teardown rescue join",
        );
      }
    });
  });
}

Deno.test("native scope: public facades expose the identical P03 issuer only", async () => {
  assertEquals(Object.keys(native), ["fixtureScope"]);
  assertStrictEquals(native.fixtureScope, fixtureScope);
  await bounded(
    native.fixtureScope(async (scope: FixtureScope) => {
      await fixtureScope(async (borrower) => {
        const value = {};
        const admitted = await scope.admit(() => value, borrower);
        assertStrictEquals(admitted.value, value);
        assertEquals([scope.size, borrower.size], [0, 0]);
      });
    }),
    "native public facade callback",
  );
});

Deno.test("native scope: wrapped values do not inspect a resource's then again", async () => {
  let reads = 0, disposed: unknown;
  const resource = Object.defineProperty({}, "then", {
    get() {
      if (++reads > 1) throw new Error("resource then was probed twice");
      return undefined;
    },
  });
  await bounded(
    native.fixtureScope(async (scope: FixtureScope) => {
      const handle = await scope.acquire(() => resource, (value) => {
        disposed = value;
      });
      assertStrictEquals(handle.value, resource);
    }),
    "native wrapped resource callback",
  );
  assertEquals(reads, 1);
  assertStrictEquals(disposed, resource);
});

for (const fails of [false, true]) {
  Deno.test(`native close awaits ${fails ? "teardown failure publication" : "existing reports"} before exit`, async () => {
    await fixtureScope(async (testScope) => {
      const entered = fixtureGate(testScope), release = fixtureGate(testScope);
      const failure = new Error("child teardown failed"), events: string[] = [];
      const report = async (error?: unknown) => {
        if (fails) assertStrictEquals(error, failure);
        events.push("report:start");
        entered.resolve();
        await release.promise;
        events.push("report:published");
      };
      const closing = closeNativeCase(
        () => {
          events.push("close");
          if (fails) throw failure;
        },
        report,
        report,
      ).then(
        () => {
          events.push("exit");
        },
        (error: unknown) => {
          events.push("exit");
          throw error;
        },
      );
      const checked: Promise<unknown> = fails
        ? assertRejects(() => closing, Error, "child teardown failed")
        : closing;
      let failed = false;
      try {
        await bounded(
          workMilestone(checked, entered.promise, "native report entered"),
          "close report entry",
        );
        assertEquals(events, ["close", "report:start"]);
        release.resolve();
        const result = await bounded(checked, "close publication before exit");
        if (fails) assertStrictEquals(result, failure);
        assertEquals(events, [
          "close",
          "report:start",
          "report:published",
          "exit",
        ]);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        release.resolve();
        await finish([checked], failed, "close publication rescue join");
      }
    });
  });
}

for (const first of ["root", "borrower"] as const) {
  Deno.test(`native scope: ${first} close cancels borrowed work before either release`, async () => {
    const root = createFixtureScope(), borrower = createFixtureScope();
    const firstOwner = first === "root" ? root : borrower;
    const secondOwner = first === "root" ? borrower : root;
    const rescue = new AbortController();
    const events: string[] = [];
    let running!: Promise<Readonly<{ value: never }>>;
    root.scope.defer(() => events.push("root:released"));
    borrower.scope.defer(() => events.push("borrower:released"));
    const used = native.fixtureScope(async (nativeScope: FixtureScope) => {
      running = root.scope.admit(
        (signal) => {
          events.push("admitted");
          return waitForCancellation(AbortSignal.any([signal, rescue.signal]))
            .finally(() => events.push("drained"));
        },
        borrower.scope,
        nativeScope,
      );
      const checked = assertRejects(
        () => running,
        OwnershipError,
        "Fixture scope retired",
      );
      await bounded(firstOwner.close(), "native co-admitted close");
      assertStrictEquals(
        await bounded(checked, "native co-admitted rejection"),
        firstOwner.scope.signal.reason,
      );
      await bounded(secondOwner.close(), "second native owner close");
    });
    let failed = false;
    try {
      await bounded(used, "native co-admitted callback");
      assertEquals(events, [
        "admitted",
        "drained",
        `${first}:released`,
        `${first === "root" ? "borrower" : "root"}:released`,
      ]);
      assertEquals([root.scope.size, borrower.scope.size], [0, 0]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      rescue.abort(new OwnershipError("Fixture scope retired"));
      await finish(
        [root.close(), borrower.close(), used],
        failed,
        "native co-admitted rescue join",
      );
    }
  });
}

Deno.test("native scope: already retired acquisition and foreign or retired borrowers never enter", async () => {
  const retired = createFixtureScope();
  await bounded(retired.close(), "retire native acquisition owner");
  const events: string[] = [];
  await bounded(
    native.fixtureScope(async (scope: FixtureScope) => {
      await assertRejects(
        () =>
          retired.scope.acquire(
            () => events.push("allocate"),
            () => events.push("dispose"),
          ),
        OwnershipError,
        "Owner is retired",
      );
      for (const foreign of [null, {}, { ...scope }]) {
        await assertRejects(
          () =>
            scope.admit(
              () => events.push("foreign effect"),
              foreign as FixtureScope,
            ),
          TypeError,
          "Work admission requires an issued fixture scope",
        );
      }
      await assertRejects(
        () => scope.admit(() => events.push("retired effect"), retired.scope),
        OwnershipError,
        "Owner is retired",
      );
      assertEquals([scope.size, events], [0, []]);
    }),
    "native rejected acquisition and admission callback",
  );
});

Deno.test("native scope: late allocation is disposed exactly once before close finishes", async () => {
  await fixtureScope(async (testScope) => {
    const owner = createFixtureScope(), gate = fixtureGate(testScope);
    const value = {}, events: string[] = [];
    owner.scope.onCancel(() => {
      events.push("cancel");
      gate.resolve();
    });
    const acquiring = owner.scope.acquire(async () => {
      events.push("allocate");
      await gate.promise;
      return value;
    }, (actual) => {
      assertStrictEquals(actual, value);
      events.push("dispose");
    });
    const checked = assertRejects(
      () => acquiring,
      OwnershipError,
      "Owner is retired",
    );
    let failed = false;
    try {
      await bounded(owner.close(), "late native allocation cleanup");
      await bounded(checked, "late native acquisition rejection");
      await bounded(owner.close(), "late native owner close");
      assertEquals([events, owner.scope.size], [
        ["allocate", "cancel", "dispose"],
        0,
      ]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      gate.resolve();
      await finish(
        [owner.close(), checked],
        failed,
        "late native acquisition rescue join",
      );
    }
  });
});

Deno.test("native scope: synchronous allocator retirement fences later admission", async () => {
  const owner = createFixtureScope(), events: string[] = [];
  let closing!: Promise<void>;
  const checked = assertRejects(
    () =>
      owner.scope.acquire(() => {
        events.push("allocate");
        closing = owner.close();
        assertThrows(
          () => owner.scope.defer(() => events.push("late cleanup")),
          OwnershipError,
          "Owner is retired",
        );
        return "resource";
      }, (value) => events.push(`dispose:${value}`)),
    OwnershipError,
    "Owner is retired",
  );
  let failed = false;
  try {
    await bounded(checked, "reentrant native acquisition rejection");
    await bounded(closing, "reentrant native acquisition close");
    await bounded(
      assertRejects(
        () => owner.scope.admit(() => events.push("effect")),
        OwnershipError,
        "Owner is retired",
      ),
      "retired native acquisition admission",
    );
    assertEquals([events, owner.scope.size], [
      ["allocate", "dispose:resource"],
      0,
    ]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await finish(
      [owner.close()],
      failed,
      "reentrant native acquisition rescue join",
    );
  }
});

Deno.test("native scope: synchronous effect retirement rejects its captured admission", async () => {
  const borrower = createFixtureScope(), events: string[] = [];
  let closing!: Promise<void>;
  borrower.scope.defer(() => events.push("released"));
  let failed = false;
  try {
    await bounded(
      native.fixtureScope(async (scope: FixtureScope) => {
        await bounded(
          assertRejects(
            () =>
              scope.admit(() => {
                assertEquals([scope.size, borrower.scope.size], [1, 2]);
                events.push("entered");
                closing = borrower.close();
                events.push("retired");
                return "stale result";
              }, borrower.scope),
            OwnershipError,
            "Owner is retired",
          ),
          "reentrant native admission rejection",
        );
        await bounded(closing, "reentrant native admission close");
        assertEquals([scope.size, borrower.scope.size], [0, 0]);
      }),
      "reentrant native admission callback",
    );
    assertEquals(events, ["entered", "retired", "released"]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await finish(
      [borrower.close()],
      failed,
      "reentrant native admission rescue join",
    );
  }
});

Deno.test("native scope: async reporting settles before either resource is released", async () => {
  await fixtureScope(async (testScope) => {
    const entered = fixtureGate(testScope), release = fixtureGate(testScope);
    const events: string[] = [];
    testScope.onCancel(() => release.resolve());
    const running = native.fixtureScope((scope: FixtureScope) => {
      scope.defer(() => events.push("binding:closed"));
      scope.defer(() => events.push("page:closed"));
      events.push("body");
    }, {
      report: async () => {
        events.push("report:start");
        entered.resolve();
        await release.promise;
        events.push("report:settled");
      },
    });
    let failed = false;
    try {
      await bounded(
        workMilestone(running, entered.promise, "native report entered"),
        "native report entry",
      );
      assertEquals(events, ["body", "report:start"]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Rescue the held reporter before joining, even when entry never arrived.
      release.resolve();
      await finish([running], failed, "native report rescue join");
    }
    assertEquals(events, [
      "body",
      "report:start",
      "report:settled",
      "page:closed",
      "binding:closed",
    ]);
  });
});

Deno.test("native scope: report precedes release and retains primary plus every cleanup failure", async () => {
  const primary = new Error("body failed"), report = new Error("report failed");
  const root = new Error("root close failed"),
    page = new Error("page close failed");
  const events: string[] = [];
  const error = await bounded(
    assertRejects(
      () =>
        native.fixtureScope((scope: FixtureScope) => {
          scope.defer(() => {
            events.push("root");
            throw root;
          });
          scope.defer(() => {
            events.push("page");
            throw page;
          });
          throw primary;
        }, {
          report: () => {
            events.push("report");
            throw report;
          },
        }),
      AggregateError,
      "Owned resource release failed",
    ),
    "native failure report and cleanup",
  );
  assertStrictEquals(error.cause, primary);
  assertStrictEquals(error.errors[0], primary);
  assertStrictEquals(error.errors[1], report);
  assertEquals(error.errors[2].errors, [page, root]);
  assertStrictEquals(error.errors[2].errors[0], page);
  assertStrictEquals(error.errors[2].errors[1], root);
  assertEquals(events, ["report", "page", "root"]);
});
