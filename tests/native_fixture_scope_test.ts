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
import { OwnershipError } from "../shared/ownership.js";

Deno.test("native scope: public facades expose the identical P03 issuer only", async () => {
  assertEquals(Object.keys(native), ["fixtureScope"]);
  assertStrictEquals(native.fixtureScope, fixtureScope);
  await native.fixtureScope(async (scope: FixtureScope) => {
    await fixtureScope(async (borrower) => {
      const value = {};
      const admitted = await scope.admit(() => value, borrower);
      assertStrictEquals(admitted.value, value);
      assertEquals([scope.size, borrower.size], [0, 0]);
    });
  });
});

Deno.test("native scope: wrapped values do not inspect a resource's then again", async () => {
  let reads = 0, disposed: unknown;
  const resource = Object.defineProperty({}, "then", {
    get() {
      if (++reads > 1) throw new Error("resource then was probed twice");
      return undefined;
    },
  });
  await native.fixtureScope(async (scope: FixtureScope) => {
    const handle = await scope.acquire(() => resource, (value) => {
      disposed = value;
    });
    assertStrictEquals(handle.value, resource);
  });
  assertEquals(reads, 1);
  assertStrictEquals(disposed, resource);
});

for (const first of ["root", "borrower"] as const) {
  Deno.test(`native scope: ${first} close cancels borrowed work before either release`, async () => {
    const root = createFixtureScope(), borrower = createFixtureScope();
    const firstOwner = first === "root" ? root : borrower;
    const secondOwner = first === "root" ? borrower : root;
    const events: string[] = [];
    let running!: Promise<Readonly<{ value: never }>>;
    root.scope.defer(() => events.push("root:released"));
    borrower.scope.defer(() => events.push("borrower:released"));
    const used = native.fixtureScope(async (nativeScope: FixtureScope) => {
      running = root.scope.admit(
        (signal) => {
          events.push("admitted");
          return waitForCancellation(signal).finally(() =>
            events.push("drained")
          );
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
      assertStrictEquals(await checked, firstOwner.scope.signal.reason);
      await secondOwner.close();
    });
    try {
      await used;
      assertEquals(events, [
        "admitted",
        "drained",
        `${first}:released`,
        `${first === "root" ? "borrower" : "root"}:released`,
      ]);
      assertEquals([root.scope.size, borrower.scope.size], [0, 0]);
    } finally {
      await Promise.all([root.close(), borrower.close()]);
    }
  });
}

Deno.test("native scope: already retired acquisition and foreign or retired borrowers never enter", async () => {
  const retired = createFixtureScope();
  await retired.close();
  const events: string[] = [];
  await native.fixtureScope(async (scope: FixtureScope) => {
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
  });
});

Deno.test("native scope: late allocation is disposed exactly once before close finishes", async () => {
  await fixtureScope(async (testScope) => {
    const owner = createFixtureScope(), gate = fixtureGate(testScope);
    const value = {}, events: string[] = [];
    testScope.defer(() => owner.close());
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
    await bounded(owner.close(), "late native allocation cleanup");
    await checked;
    await owner.close();
    assertEquals([events, owner.scope.size], [
      ["allocate", "cancel", "dispose"],
      0,
    ]);
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
  await checked;
  await bounded(closing, "reentrant native acquisition close");
  await assertRejects(
    () => owner.scope.admit(() => events.push("effect")),
    OwnershipError,
    "Owner is retired",
  );
  assertEquals([events, owner.scope.size], [
    ["allocate", "dispose:resource"],
    0,
  ]);
});

Deno.test("native scope: synchronous effect retirement rejects its captured admission", async () => {
  const borrower = createFixtureScope(), events: string[] = [];
  let closing!: Promise<void>;
  borrower.scope.defer(() => events.push("released"));
  await native.fixtureScope(async (scope: FixtureScope) => {
    await assertRejects(
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
    );
    await bounded(closing, "reentrant native admission close");
    assertEquals([scope.size, borrower.scope.size], [0, 0]);
  });
  assertEquals(events, ["entered", "retired", "released"]);
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
    // Always open the reporter's hold before joining the original callback run.
    testScope.defer(() => running);
    await entered.promise;
    try {
      assertEquals(events, ["body", "report:start"]);
    } finally {
      release.resolve();
    }
    await bounded(running, "native report before release");
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
  const error = await assertRejects(
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
  );
  assertStrictEquals(error.cause, primary);
  assertStrictEquals(error.errors[0], primary);
  assertStrictEquals(error.errors[1], report);
  assertEquals(error.errors[2].errors, [page, root]);
  assertStrictEquals(error.errors[2].errors[0], page);
  assertStrictEquals(error.errors[2].errors[1], root);
  assertEquals(events, ["report", "page", "root"]);
});
