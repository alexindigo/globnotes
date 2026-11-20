// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Contender, ownedContenders } from "./helpers/owned_contenders.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import {
  fixtureGate,
  waitForCancellation,
} from "./helpers/fixture_coordination.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

const contender = <T>(start: Contender<T>["start"]): Contender<T> => {
  const owner = {};
  return { owner: () => owner, progress: { kind: "product" }, start };
};
const value = <T>(outcome: PromiseSettledResult<T>): T => {
  if (outcome.status !== "fulfilled") throw outcome.reason;
  return outcome.value;
};

/** Contract-only atomic effect/receipt stand-in, not an identity implementation.
 * Memoization represents two callers of one logical operation. Each distinct
 * operation reaches its own injected admission before attempting the effect. */
function receiptExercise() {
  const pending = new Map<
    string,
    Promise<{ operation: string; receipt: object }>
  >();
  const effects: string[] = [];
  const receipts: object[] = [];
  const admissions: string[] = [];
  const completions: string[] = [];
  const request = (operation: string, hold: () => Promise<void>) => {
    const existing = pending.get(operation);
    if (existing) return existing;
    const work = (async () => {
      admissions.push(operation);
      await hold();
      try {
        if (effects.length) throw { operation, conflictWith: effects[0] };
        const receipt = Object.freeze({ operation });
        effects.push(operation);
        receipts.push(receipt);
        return { operation, receipt };
      } finally {
        completions.push(operation);
      }
    })();
    pending.set(operation, work);
    return work;
  };
  const repeated = contender(async (hold) => {
    const original = request("repeated", hold);
    const retry = request("repeated", hold);
    assertEquals(original, retry);
    const [first, duplicate] = await Promise.allSettled([original, retry]);
    return { first, duplicate };
  });
  const independent = contender((hold) => request("independent", hold));
  return { repeated, independent, effects, receipts, admissions, completions };
}

for (const first of ["repeated", "independent"] as const) {
  for (const reverseSubmission of [false, true]) {
    Deno.test(`owned contenders: ${first} completes first, ${reverseSubmission ? "reverse" : "forward"} submission preserves keyed receipt/conflict correlation`, async () => {
      const exercise = receiptExercise();
      const { repeated, independent } = exercise;
      const outcomes = await ownedContenders(
        reverseSubmission
          ? { independent, repeated }
          : { repeated, independent },
        first,
      );
      assert(!Array.isArray(outcomes));
      assert(Object.isFrozen(outcomes));
      assertEquals(Object.keys(outcomes).sort(), ["independent", "repeated"]);
      assertEquals(
        exercise.admissions,
        reverseSubmission
          ? ["independent", "repeated"]
          : ["repeated", "independent"],
      );
      assertEquals(exercise.completions, [
        first,
        first === "repeated" ? "independent" : "repeated",
      ]);
      assertEquals(exercise.effects, [first]);
      assertEquals(exercise.receipts, [{ operation: first }]);
      const callers = value(outcomes.repeated);
      const receipt = { operation: first, receipt: { operation: first } };
      const conflict = {
        operation: first === "repeated" ? "independent" : "repeated",
        conflictWith: first,
      };
      const fulfilled = { status: "fulfilled", value: receipt };
      const rejected = { status: "rejected", reason: conflict };
      assertEquals({ ...outcomes }, {
        repeated: {
          status: "fulfilled",
          value: first === "repeated"
            ? { first: fulfilled, duplicate: fulfilled }
            : { first: rejected, duplicate: rejected },
        },
        independent: first === "independent" ? fulfilled : rejected,
      });
      if (first === "repeated") {
        const original = value(callers.first),
          duplicate = value(callers.duplicate);
        assertEquals(original, duplicate);
        assert(original.receipt === duplicate.receipt);
        assert(original.receipt === exercise.receipts[0]);
      } else {
        assert(value(outcomes.independent).receipt === exercise.receipts[0]);
        assert(
          callers.first.status === "rejected" &&
            callers.duplicate.status === "rejected",
        );
        assert(callers.first.reason === callers.duplicate.reason);
        // The full outcomes above reject the historical two-success expectation:
        // duplicate callers share the original conflict when the other wins.
      }
    });
  }
}

for (const first of ["good", "bad"] as const) {
  for (const reverse of [false, true]) {
    Deno.test(`owned contenders: early rejection rejects own admission and drains peer (${first}, reverse=${reverse})`, async () => {
      const cause = new Error("own contender rejected before admission");
      let drained = false;
      const good = contender(async (hold) => {
        await hold();
        drained = true;
        return 1;
      });
      const bad = contender(() => {
        throw cause;
      });
      const error = await assertRejects(
        () => ownedContenders(reverse ? { bad, good } : { good, bad }, first),
        Error,
        cause.message,
      );
      assert(error === cause);
      assert(drained);
    });
    Deno.test(`owned contenders: missing entry cannot borrow peer admission (${first}, reverse=${reverse})`, async () => {
      let drained = false;
      const good = contender(async (hold) => {
        await hold();
        drained = true;
        return 1;
      });
      const bad = contender(() => 2);
      await assertRejects(
        () => ownedContenders(reverse ? { bad, good } : { good, bad }, first),
        Error,
        "contender bad: product work settled without the expected milestone",
      );
      assert(drained);
    });
  }
}

Deno.test("owned contenders: releases every peer before failed-entry cleanup drains dependent work", async () => {
  let peerFinished = false;
  // The dependent's completion needs the peer, but neither entry depends on it.
  // This is a real operation promise, not a caller-selected completion marker.
  let peerWork: Promise<number>;
  const peer = {
    ...contender((hold) =>
      peerWork = (async () => {
        await hold();
        peerFinished = true;
        return 7;
      })()
    ),
    progress: { kind: "controlled", clock: "external" } as const,
  };
  const dependent = {
    ...contender(async (hold) => {
      await hold();
      return await peerWork;
    }),
    progress: { kind: "controlled", clock: "external" } as const,
  };
  await assertRejects(
    () =>
      ownedContenders({ peer, dependent, missing: contender(() => 0) }, "peer"),
    Error,
    "contender missing: product work settled without the expected milestone",
  );
  assert(peerFinished);
});

Deno.test("owned contenders: later acquisition failure still releases earlier operations", async () => {
  let drained = false;
  const good = contender(async (hold) => {
    await hold();
    drained = true;
  });
  const absent = { ...contender(() => 0), owner: () => undefined };
  await assertRejects(
    () => ownedContenders({ good, absent }, "good"),
    Error,
    "contender absent: operation owner absent",
  );
  assert(drained);
});

Deno.test("owned contenders: completion waits for actual first operation, not just admission", async () => {
  let finished = false;
  const outcomes = await ownedContenders({
    observer: contender(async (hold) => {
      await hold();
      assert(finished);
      return "observed completion";
    }),
    selected: contender(async (hold) => {
      await hold();
      const completed = await fixtureScope((scope) => scope.admit(() => 42));
      finished = true;
      return completed.value;
    }),
  }, "selected");
  assertEquals(value(outcomes.observer), "observed completion");
  assertEquals(value(outcomes.selected), 42);
});

Deno.test("owned contenders: selected operation cannot pass a peer still approaching admission", async () => {
  let entered = false;
  const outcomes = await ownedContenders({
    selected: contender(async (hold) => {
      await hold();
      assert(entered, "selected released before every own admission");
      return true;
    }),
    delayed: contender(async (hold) => {
      await fixtureScope((scope) => scope.admit(() => "approaching admission"));
      entered = true;
      await hold();
      return true;
    }),
  }, "selected");
  assertEquals(value(outcomes.selected), true);
  assertEquals(value(outcomes.delayed), true);
});

Deno.test("owned contenders: async rejection before entry preserves its exact cause", async () => {
  const cause = new Error("async contender failed before entry");
  const error = await assertRejects(
    () =>
      ownedContenders({
        rejected: contender(() => Promise.reject(cause)),
        peer: contender(async (hold) => {
          await hold();
        }),
      }, "peer"),
    Error,
    cause.message,
  );
  assert(error === cause);
});

Deno.test("owned contenders: failed entry retains a distinct terminal peer error during cleanup", async () => {
  const cause = new Error("failed entry");
  const terminal = new Error("peer failed while draining");
  const error = await assertRejects(
    () =>
      ownedContenders({
        peer: contender(async (hold) => {
          await hold();
          throw terminal;
        }),
        rejected: contender(() => {
          throw cause;
        }),
      }, "peer"),
    AggregateError,
    "Owned resource release failed",
  );
  assert(error.cause === cause);
  assertEquals(error.errors, [cause, terminal]);
  assert(error.errors[0] === cause);
  assert(error.errors[1] === terminal);
});

Deno.test("owned contenders: heterogeneous results stay associated with named operations", async () => {
  const outcomes = await ownedContenders({
    text: contender(async (hold) => {
      await hold();
      return "text";
    }),
    count: contender(async (hold) => {
      await hold();
      return 42;
    }),
  }, "count");
  const text: string = value(outcomes.text);
  const count: number = value(outcomes.count);
  assertEquals({ text, count }, { text: "text", count: 42 });
  // @ts-expect-error No positional outcome is exposed.
  assertEquals(outcomes[0], undefined);
});

Deno.test("owned contenders: positional, foreign and malformed inputs reject before starting work", async () => {
  let starts = 0;
  const operation = contender(async (hold) => {
    starts++;
    await hold();
  });
  await assertRejects(
    () => {
      // @ts-expect-error A numeric position is not a contender name.
      return ownedContenders({ alpha: operation }, 0);
    },
    TypeError,
    "completeFirst must name an own contender",
  );
  await assertRejects(
    () => {
      // @ts-expect-error A foreign name cannot select a contender.
      return ownedContenders({ alpha: operation }, "foreign");
    },
    TypeError,
    "completeFirst must name an own contender",
  );
  await assertRejects(
    () => ownedContenders({ "0": operation }, "0"),
    TypeError,
    "Contender names cannot be numeric positions",
  );
  await assertRejects(
    () => {
      // @ts-expect-error Arrays cannot define contenders.
      return ownedContenders([operation], "0");
    },
    TypeError,
    "Contenders require a named operation map",
  );
  await assertRejects(
    () => ownedContenders({}, "absent"),
    TypeError,
    "completeFirst must name an own contender",
  );
  await assertRejects(
    () =>
      ownedContenders(
        { alpha: operation, [Symbol("hidden")]: operation },
        "alpha",
      ),
    TypeError,
    "Contenders require a named operation map",
  );
  await assertRejects(
    () => ownedContenders(Object.create({ inherited: operation }), "inherited"),
    TypeError,
    "completeFirst must name an own contender",
  );
  await assertRejects(
    () =>
      ownedContenders({ alpha: operation, malformed: {} } as never, "alpha"),
    TypeError,
    "malformed: contender requires its own start and owner",
  );
  assertEquals(starts, 0);
});

Deno.test("owned contenders: prototype-like names remain ordinary own operation keys", async () => {
  const outcomes = await ownedContenders({
    ["__proto__"]: contender(async (hold) => {
      await hold();
      return "own";
    }),
    constructor: contender(async (hold) => {
      await hold();
      return "also own";
    }),
  }, "__proto__");
  assertEquals(value(outcomes["__proto__"]), "own");
  assertEquals(value(outcomes.constructor), "also own");
  assertEquals(Object.getPrototypeOf(outcomes), null);
});

Deno.test("owned contenders: callback custody retires three peers before borrower and resource release", async () => {
  const events: string[] = [];
  await bounded(
    fixtureScope(async (owner) => {
      const resource = (await owner.acquire(
        () => ({ alive: true }),
        (resource) => {
          resource.alive = false;
          events.push("resource released");
        },
      )).value;
      await fixtureScope(async (borrower) => {
        borrower.defer(() => events.push("borrower released"));
        const operation = (name: string): Contender<string> => ({
          owner: () => resource,
          progress: { kind: "product" },
          async start(hold, signal) {
            assertEquals(resource.alive, true);
            events.push(`${name} admitted`);
            signal.addEventListener("abort", () => {
              assertEquals(resource.alive, true);
              events.push(`${name} cancelled`);
            }, { once: true });
            await hold();
            assertEquals(resource.alive, true);
            events.push(`${name} completed`);
            return name;
          },
        });
        const result = await owner.admit((signal) =>
          ownedContenders({
            selected: { ...operation("selected"), signal },
            peer: { ...operation("peer"), signal },
            tail: { ...operation("tail"), signal },
          }, "selected"), borrower);
        assertEquals({ ...result.value }, {
          selected: { status: "fulfilled", value: "selected" },
          peer: { status: "fulfilled", value: "peer" },
          tail: { status: "fulfilled", value: "tail" },
        });
        events.push("consumer observed");
      });
    }),
    "contender callback custody and borrowed resource release",
  );
  assertEquals(events, [
    "selected admitted",
    "peer admitted",
    "tail admitted",
    "selected completed",
    "peer completed",
    "tail completed",
    "tail cancelled",
    "peer cancelled",
    "selected cancelled",
    "consumer observed",
    "borrower released",
    "resource released",
  ]);
});

Deno.test("owned contenders review: captures definition getters and nested progress before starting siblings", async () => {
  const reads = {
    owner: 0,
    start: 0,
    progress: 0,
    kind: 0,
    clock: 0,
    signal: 0,
  };
  const identity = {};
  let clock: "external" | "manual" = "external";
  const definition: Contender<number> = {
    get owner() {
      reads.owner++;
      return function (this: Contender<number>) {
        assert(this === definition);
        return identity;
      };
    },
    get start() {
      reads.start++;
      return async function (
        this: Contender<number>,
        hold: () => Promise<void>,
      ) {
        assert(this === definition);
        await hold();
        return 42;
      };
    },
    get progress() {
      reads.progress++;
      return {
        get kind() {
          reads.kind++;
          return "controlled" as const;
        },
        get clock() {
          reads.clock++;
          assertEquals(clock, "external");
          return clock;
        },
      };
    },
    get signal() {
      reads.signal++;
      return undefined;
    },
  };
  const outcomes = await ownedContenders({
    first: contender(async (hold) => {
      clock = "manual";
      await hold();
      return "first";
    }),
    captured: definition,
  }, "captured");
  assertEquals({ ...outcomes }, {
    first: { status: "fulfilled", value: "first" },
    captured: { status: "fulfilled", value: 42 },
  });
  assertEquals(reads, {
    owner: 1,
    start: 1,
    progress: 1,
    kind: 1,
    clock: 1,
    signal: 1,
  });
});

Deno.test("owned contenders review: pre-aborted definitions reject before any sibling starts or owner capture", async () => {
  const controller = new AbortController();
  const cause = new Error("contender resource already cancelled");
  controller.abort(cause);
  const effects: string[] = [];
  const error = await assertRejects(
    () =>
      ownedContenders({
        first: contender(() => effects.push("first started")),
        cancelled: {
          signal: controller.signal,
          get owner() {
            effects.push("owner captured");
            return () => ({});
          },
          progress: { kind: "product" },
          start() {
            effects.push("cancelled started");
          },
        },
      }, "cancelled"),
    Error,
    cause.message,
  );
  assert(error === cause);
  assertEquals(effects, []);
});

Deno.test("owned contenders review: cancellation reaches admitted extra IO before resource release", async () => {
  const events: string[] = [];
  const rescue = new AbortController();
  let running!: Promise<unknown>;
  let checked!: Promise<Error>;
  const closing = fixtureScope(async (scope) => {
    const entered = fixtureGate(scope);
    const resource =
      (await scope.acquire(() => ({ alive: true }), (resource) => {
        resource.alive = false;
        events.push("resource released");
      })).value;
    running = scope.admit((signal) =>
      ownedContenders({
        selected: {
          owner: () => resource,
          progress: { kind: "product" },
          signal,
          async start(hold, signal) {
            events.push("admitted");
            try {
              await hold();
              events.push("extra IO entered");
              entered.resolve();
              await waitForCancellation(
                AbortSignal.any([signal, rescue.signal]),
              );
            } finally {
              assertEquals(resource.alive, true);
              events.push("work drained");
            }
          },
        },
      }, "selected")
    );
    checked = assertRejects(() => running, Error, "Fixture scope retired");
    checked.catch(() => {});
    await workMilestone(running, entered.promise, "contender extra IO");
    events.push("scope body complete");
  });
  closing.catch(() => {});
  try {
    await bounded(closing, "contender cancellation and resource drain");
    await checked;
    assertEquals(events, [
      "admitted",
      "extra IO entered",
      "scope body complete",
      "work drained",
      "resource released",
    ]);
  } finally {
    rescue.abort(new Error("test rescue"));
    await closing.catch(() => {});
    await checked.catch(() => {});
  }
});

Deno.test("owned contenders review: malformed later progress rejects before earlier construction", async () => {
  const effects: string[] = [];
  await assertRejects(
    () =>
      ownedContenders({
        first: contender(() => effects.push("first started")),
        invalid: {
          ...contender(() => 0),
          progress: { kind: "unknown" } as never,
        },
      }, "first"),
    TypeError,
    "Operation requires an explicit progress mode",
  );
  assertEquals(effects, []);
});

Deno.test("owned contenders review: failed admission cancels dependent peer IO before nested drains", async () => {
  const cause = new Error("later contender failed admission");
  const rescue = new AbortController();
  const events: string[] = [];
  let original!: Promise<never>;
  const running = ownedContenders({
    extra: {
      ...contender((hold, signal) => {
        original = (async () => {
          events.push("extra started");
          try {
            await hold();
            events.push("extra IO entered");
            return await waitForCancellation(
              AbortSignal.any([signal, rescue.signal]),
            );
          } finally {
            events.push("extra drained");
          }
        })();
        return original;
      }),
      signal: rescue.signal,
    },
    dependent: {
      ...contender(async (hold) => {
        events.push("dependent started");
        try {
          await hold();
          return await original;
        } finally {
          events.push("dependent drained");
        }
      }),
      signal: rescue.signal,
    },
    missing: contender(() => {
      events.push("failure started");
      throw cause;
    }),
  }, "extra");
  running.catch(() => {});
  try {
    const error = await assertRejects(
      () => bounded(running, "failed contender group cancellation"),
      Error,
      cause.message,
    );
    assert(error === cause);
    assertEquals(rescue.signal.aborted, false);
    assertEquals(events, [
      "extra started",
      "dependent started",
      "failure started",
      "extra IO entered",
      "extra drained",
      "dependent drained",
    ]);
  } finally {
    rescue.abort(cause);
    await running.catch(() => {});
  }
});

Deno.test("owned contenders review: a revoked result cancels dependent peers instead of becoming a keyed outcome", async () => {
  const rescue = new AbortController();
  const events: string[] = [];
  let current = {};
  let original!: Promise<number>;
  const running = ownedContenders({
    peer: {
      owner: () => current,
      progress: { kind: "product" },
      signal: rescue.signal,
      start(hold) {
        original = (async () => {
          events.push("peer started");
          await hold();
          events.push("peer drained");
          return 7;
        })();
        return original;
      },
    },
    dependent: {
      ...contender(async (hold) => {
        events.push("dependent started");
        await hold();
        const result = await original;
        events.push("dependent drained");
        return result;
      }),
      signal: rescue.signal,
    },
    selected: contender(async (hold) => {
      await hold();
      current = {};
      events.push("selected completed");
      return "selected";
    }),
  }, "selected");
  running.catch(() => {});
  try {
    const error = await assertRejects(
      () => bounded(running, "revoked contender result cancels peers"),
      AggregateError,
      "Contender result authority failed",
    );
    assertEquals(
      error.errors.map((error) => ({
        type: error.constructor,
        message: error.message,
      })),
      [
        { type: Error, message: "contender peer: operation owner replaced" },
        { type: Error, message: "contender peer: operation owner replaced" },
      ],
    );
    assert(error.cause === error.errors[0]);
    assertEquals(rescue.signal.aborted, false);
    assertEquals(events, [
      "peer started",
      "dependent started",
      "selected completed",
      "peer drained",
      "dependent drained",
    ]);
  } finally {
    rescue.abort(new Error("test rescue"));
    await running.catch(() => {});
  }
});

Deno.test("owned contenders review: non-enumerable operation ports retain their definition receiver", async () => {
  const identity = {};
  const definition: Contender<number> = Object.create(null, {
    owner: {
      value: function () {
        assert(this === definition);
        return identity;
      },
    },
    progress: { value: { kind: "product" } },
    start: {
      value: async function (hold: () => Promise<void>) {
        assert(this === definition);
        await hold();
        return 7;
      },
    },
  });
  assertEquals({ ...await ownedContenders({ named: definition }, "named") }, {
    named: { status: "fulfilled", value: 7 },
  });
});

Deno.test("owned contenders review: release-time revocation rejects after exact work is drained", async () => {
  const events: string[] = [];
  let current = {};
  await assertRejects(
    () =>
      ownedContenders({
        first: {
          ...contender(async (hold) => {
            await hold();
            events.push("first completed");
            return 1;
          }),
          owner: () => current,
        },
        second: contender(async (hold) => {
          await hold();
          current = {};
          events.push("second completed");
          return 2;
        }),
      }, "first"),
    Error,
    "contender first: operation owner replaced",
  );
  assertEquals(events, ["first completed", "second completed"]);
});
