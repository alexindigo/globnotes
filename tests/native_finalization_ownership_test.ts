// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { finalizeNativeCase } from "../client/tests/e2e/native-case-finalization.mjs";

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
    const error = await finalizeNativeCase({
      error: primary,
      report: callbacks[0],
      cleanup: callbacks.slice(1),
    }).catch((error) => error);
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
  const error = await finalizeNativeCase({
    error: failures[0],
    report: () => {
      throw failures[1];
    },
    cleanup: failures.slice(2).map((error) => () => {
      throw error;
    }),
  }).catch((error) => error);
  assertInstanceOf(error, AggregateError);
  assertEquals(error.errors, failures);
  assertStrictEquals(error.cause, failures[0]);
});

Deno.test("native finalization: prior error stays caller-owned only when finalization succeeds", async () => {
  const primary = new Error("original case");
  await finalizeNativeCase({ error: primary });
  let closed = 0;
  const error = await (async () => {
    try {
      throw primary;
    } finally {
      await finalizeNativeCase({ error: primary, cleanup: [() => closed++] });
    }
  })().catch((error) => error);
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
  const finishing = finalizeNativeCase({
    report: () => {
      throw primary;
    },
    cleanup: [async () => {
      order.push("held close");
      entered.resolve();
      await held.promise;
    }, () => order.push("last close")],
  }).catch((error) => error);
  await entered.promise;
  assertEquals(order, ["held close"]);
  held.resolve();
  assertStrictEquals(await finishing, primary);
  assertEquals(order, ["held close", "last close"]);
});
