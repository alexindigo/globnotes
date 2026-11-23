// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { finalizeNativeCase } from "../client/tests/e2e/native-case-finalization.mjs";
import { bounded } from "./helpers/worker_liveness.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

Deno.test("native review: thenable report and cleanup capture then once at the consumer", async () => {
  const reads = [0, 0], order: string[] = [];
  const failure = new Error("thenable close");
  const callback = (index: number, rejects: boolean) => () => ({
    get then() {
      reads[index]++;
      return reads[index] === 1
        ? (resolve: () => void, reject: (error: unknown) => void) => {
          order.push(String(index));
          if (rejects) reject(failure);
          else resolve();
        }
        : undefined;
    },
  });
  const error = await assertRejects(() =>
    finalizeNativeCase({
      report: callback(0, false),
      cleanup: [callback(1, true), () => order.push("last")],
    })
  );
  assertStrictEquals(error, failure);
  assertEquals(reads, [1, 1]);
  assertEquals(order, ["0", "1", "last"]);
});

Deno.test("native finalization: compatibility entry reports before supplied cleanup order", async () => {
  const order: string[] = [];
  await finalizeNativeCase({
    report: () => order.push("report"),
    cleanup: [
      () => order.push("browser"),
      () => order.push("child"),
      () => order.push("root"),
    ],
  });
  assertEquals(order, ["report", "browser", "child", "root"]);
});

for (let failing = 0; failing < 4; failing++) {
  Deno.test(`native finalization: callback ${failing} fails without skipping any later owner`, async () => {
    const order: number[] = [],
      primary = new Error("scenario"),
      failure = new Error(`callback ${failing}`);
    const callbacks = Array.from({ length: 4 }, (_, i) => async () => {
      order.push(i);
      await Promise.resolve();
      if (i === failing) throw failure;
    });
    const error = await assertRejects(
      () =>
        finalizeNativeCase({
          error: primary,
          report: callbacks[0],
          cleanup: callbacks.slice(1),
        }),
      AggregateError,
      "Native diagnostics or cleanup failed",
    );
    assertEquals(order, [0, 1, 2, 3]);
    assertInstanceOf(error, AggregateError);
    assertEquals(error.errors, [primary, failure]);
    assertStrictEquals(error.cause, primary);
  });
}

Deno.test("native finalization: every failure is preserved once in original order", async () => {
  const failures = [
    new Error("case"),
    new Error("report"),
    new Error("browser"),
    new Error("child"),
  ];
  const error = await assertRejects(
    () =>
      finalizeNativeCase({
        error: failures[0],
        report: () => {
          throw failures[1];
        },
        cleanup: failures.slice(2).map((error) => () => {
          throw error;
        }),
      }),
    AggregateError,
    "Native diagnostics or cleanup failed",
  );
  assertInstanceOf(error, AggregateError);
  assertEquals(error.errors, failures);
  assertStrictEquals(error.cause, failures[0]);
});

Deno.test("native finalization: prior error stays caller-owned only when finalization succeeds", async () => {
  const primary = new Error("original case");
  await finalizeNativeCase({ error: primary });
  let closed = 0;
  const error = await assertRejects(
    async () => {
      try {
        throw primary;
      } finally {
        await finalizeNativeCase({ error: primary, cleanup: [() => closed++] });
      }
    },
    Error,
    "original case",
  );
  assertStrictEquals(error, primary);
  assertEquals(closed, 1);
  const single = await assertRejects(() =>
    finalizeNativeCase({
      report: () => {
        throw primary;
      },
    })
  );
  assertStrictEquals(single, primary);
  const repeated = await assertRejects(() =>
    finalizeNativeCase({
      error: primary,
      report: () => {
        throw primary;
      },
    })
  );
  assertStrictEquals(repeated, primary);
});

Deno.test("native finalization: report rejection releases while a later finalizer remains held", async () => {
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const primary = new Error("report rejected"), order: string[] = [];
  const finishing = assertRejects(
    () =>
      finalizeNativeCase({
        report: () => {
          throw primary;
        },
        cleanup: [async () => {
          order.push("held close");
          entered.resolve();
          await held.promise;
        }, () => order.push("last close")],
      }),
    Error,
    "report rejected",
  );
  let failure: [] | [unknown] = [];
  try {
    await bounded(
      workMilestone(
        finishing,
        entered.promise,
        "native held finalizer entered",
      ),
      "native finalizer entry",
    );
    assertEquals(order, ["held close"]);
  } catch (error) {
    failure = [error];
  }
  held.resolve();
  try {
    assertStrictEquals(
      await bounded(finishing, "native finalizer rescue join"),
      primary,
    );
  } catch (error) {
    if (!failure.length) failure = [error];
  }
  if (failure.length) throw failure[0];
  assertEquals(order, ["held close", "last close"]);
});
