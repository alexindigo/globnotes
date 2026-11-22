// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
  type OperationMode,
  type OperationWitness,
} from "../server/operation_lease.ts";
import {
  bindGuardedSink,
  synchronousTransform,
} from "../server/internal/guarded_sink.ts";
import { OwnershipError } from "../shared/ownership.js";

Deno.test("G3 disclosure: async transforms reject at binding without entering or delivering", () => {
  const owner = createOperationLease("live", [() => {}]);
  const events: string[] = [];
  assertThrows(
    () =>
      bindGuardedSink(
        owner.lease,
        "live",
        synchronousTransform(async () => {
          events.push("inspect");
          return await Promise.resolve("private");
        }),
        () => {
          events.push("deliver");
          return undefined;
        },
      ),
    TypeError,
    "Disclosure transform must be synchronous",
  );
  assertEquals(events, []);
});

for (const kind of ["promise", "thenable"] as const) {
  Deno.test(`G3 disclosure: ${kind} transform results reject before delivery`, () => {
    const owner = createOperationLease("live", [() => {}]);
    const events: string[] = [];
    const deliver = bindGuardedSink(
      owner.lease,
      "live",
      synchronousTransform(() => {
        events.push("inspect");
        return kind === "promise" ? Promise.resolve("private") : {
          get then() {
            events.push("then");
            return () => {
              events.push("assimilate");
            };
          },
        };
      }),
      () => {
        events.push("deliver");
        return undefined;
      },
    );
    assertThrows(
      () => deliver(undefined),
      TypeError,
      "Disclosure transform must be synchronous",
    );
    assertEquals(
      events,
      kind === "promise" ? ["inspect"] : ["inspect", "then"],
    );
  });
}

Deno.test("G3 disclosure: transform then getter retirement precedes the final delivery fence", () => {
  const owner = createOperationLease("live", [() => {}]);
  const events: string[] = [];
  const deliver = bindGuardedSink(
    owner.lease,
    "live",
    synchronousTransform(() => ({
      get then() {
        events.push("then");
        owner.retire();
        return undefined;
      },
    })),
    () => {
      events.push("deliver");
      return undefined;
    },
  );
  assertThrows(() => deliver(undefined), OwnershipError, "Owner is retired");
  assertEquals(events, ["then"]);
});

Deno.test("operation lease: witness inputs are captured once before validation", () => {
  let reads = 0;
  const events: string[] = [];
  const witnesses = [() => {}] as [OperationWitness];
  Object.defineProperty(witnesses, 0, {
    get() {
      reads++;
      return () => {
        events.push("captured");
      };
    },
  });
  const owner = createOperationLease("live", witnesses);
  assertEquals(reads, 1);
  owner.lease.assertCurrent();
  assertEquals(events, ["captured", "captured"]);
});

Deno.test("operation lease: immutable issued provenance rejects missing, cloned and forged handles", () => {
  const owner = createOperationLease("live", [() => {}]);
  assert(Object.isFrozen(owner));
  assert(Object.isFrozen(owner.lease));
  assert(Object.isFrozen(owner.lease.identity));
  for (
    const lease of [undefined, null, {}, { ...owner.lease }, {
      mode: "live",
      identity: owner.lease.identity,
      assertCurrent() {},
    }]
  ) {
    assertThrows(
      () =>
        bindGuardedSink(
          lease as OperationLease<"live">,
          "live",
          () => ({ value: "leak" }),
          () => undefined,
        ),
      TypeError,
    );
  }
  assertThrows(() => createOperationLease("live", [] as never), TypeError);
  assertThrows(
    () => createOperationLease("other" as OperationMode, [() => {}]),
    TypeError,
  );
});

for (const mode of ["live", "retained", "outcome", "recovery"] as const) {
  Deno.test(`operation lease: ${mode} has its own retirement, not a universal identity key`, () => {
    const own = createOperationLease(mode, [() => {}]);
    const other = createOperationLease(mode, [() => {}]);
    const observed: string[] = [];
    const consume = bindGuardedSink(
      own.lease,
      mode,
      (value: string) => ({ value }),
      ({ value }) => {
        observed.push(value);
        return undefined;
      },
    );
    consume("accepted");
    other.retire();
    consume("same owner");
    assertThrows(
      () => assertOperationLease(own.lease, "other" as typeof mode),
      TypeError,
    );
    assertEquals(own.retire(), true);
    assertEquals(own.retire(), false);
    assertThrows(() => consume("retired"), OwnershipError);
    assertEquals(observed, ["accepted", "same owner"]);
  });
}

Deno.test("operation lease: final effect checks immutable witnesses after preparation and a microtask", async () => {
  for (let changed = 0; changed < 3; changed++) {
    const current = [{}, {}, {}];
    const captured = [...current];
    const witnesses: [OperationWitness, ...OperationWitness[]] = [() => {}];
    for (let i = 0; i < 3; i++) {
      witnesses.push(() => {
        if (current[i] !== captured[i]) throw new Error(`owner-${i}`);
      });
    }
    const owner = createOperationLease("live", witnesses);
    // Mutating a borrowed array cannot remove the captured contract.
    witnesses.splice(0);
    let effects = 0;
    const sink = bindGuardedSink(
      owner.lease,
      "live",
      (value: string) => ({ value }),
      () => {
        effects++;
        return undefined;
      },
    );
    const prepared = "private prepared value";
    await Promise.resolve();
    current[changed] = {};
    assertThrows(() => sink(prepared), Error, `owner-${changed}`);
    assertEquals(effects, 0);
  }
});

Deno.test("operation lease: reentrant consumer retirement prevents the second delivery", () => {
  const owner = createOperationLease("live", [() => {}]);
  const observed: string[] = [];
  const deliver = bindGuardedSink(
    owner.lease,
    "live",
    (value: string) => ({ value }),
    ({ value }) => {
      observed.push(value);
      owner.retire();
      return undefined;
    },
  );
  deliver("first");
  assertThrows(() => deliver("second"), OwnershipError);
  assertEquals(observed, ["first"]);
});

Deno.test("operation lease: inspection envelopes preserve thenable payloads without inspecting them", () => {
  const owner = createOperationLease("live", [() => {}]);
  let thenReads = 0;
  const chunks = [Promise.resolve("bytes"), {
    get then() {
      thenReads++;
      return () => {};
    },
  }];
  const seen: unknown[] = [];
  const sink = bindGuardedSink(
    owner.lease,
    "live",
    (value: typeof chunks[number]) => ({ value }),
    ({ value }) => {
      seen.push(value);
      return undefined;
    },
  );
  for (const chunk of chunks) sink(chunk);
  assertEquals([seen.length, thenReads], [2, 0]);
  assertStrictEquals(seen[0], chunks[0]);
  assertStrictEquals(seen[1], chunks[1]);
});

Deno.test("operation lease: witness reentrancy cannot retire then permit its own effect", () => {
  let retire = () => false;
  const owner = createOperationLease("live", [() => {
    retire();
  }]);
  retire = owner.retire;
  let effects = 0;
  assertThrows(
    () =>
      bindGuardedSink(owner.lease, "live", () => ({ value: undefined }), () => {
        effects++;
        return undefined;
      }),
    OwnershipError,
  );
  assertEquals(effects, 0);
});

Deno.test("operation lease: async final callbacks reject before entry and disguised thenables reject", () => {
  const owner = createOperationLease("live", [() => {}]);
  let effects = 0;
  // A cast models untyped JS. The static negative below has no cast.
  assertThrows(
    () =>
      bindGuardedSink(
        owner.lease,
        "live",
        (async () => {
          effects++;
          await Promise.resolve();
          effects++;
        }) as never,
        () => undefined,
      ),
    TypeError,
    "synchronous",
  );
  assertEquals(effects, 0);
  const disguised = bindGuardedSink(
    owner.lease,
    "live",
    (() => Promise.resolve()) as never,
    () => undefined,
  );
  assertThrows(() => disguised(undefined), TypeError, "synchronous");
  const thenable = bindGuardedSink(
    owner.lease,
    "live",
    (() => ({ then() {} })) as never,
    () => undefined,
  );
  assertThrows(() => thenable(undefined), TypeError, "synchronous");
  assertThrows(
    () =>
      bindGuardedSink(
        owner.lease,
        "live",
        () => ({ value: "data" }),
        (async () => {
          effects++;
          await Promise.resolve();
        }) as never,
      ),
    TypeError,
    "synchronous",
  );
  assertEquals(effects, 0);
});

Deno.test("operation lease: asynchronous witnesses cannot silently validate an operation", () => {
  assertThrows(
    () =>
      createOperationLease("live", [
        (async () => {}) as never,
      ]),
    TypeError,
    "synchronous",
  );
  assertThrows(
    () =>
      createOperationLease("live", [
        (() => Promise.resolve()) as never,
      ]),
    TypeError,
    "synchronous",
  );
});

Deno.test("operation lease: exact outcome owner can survive live self-revocation without granting another effect", () => {
  const live = createOperationLease("live", [() => {}]);
  const outcome = createOperationLease("outcome", [() => {}]);
  const receipts: string[] = [];
  const acknowledge = bindGuardedSink(
    outcome.lease,
    "outcome",
    (value: string) => ({ value }),
    ({ value }) => {
      receipts.push(value);
      return undefined;
    },
  );
  live.retire();
  assertEquals(acknowledge("this operation committed"), undefined);
  assertEquals(receipts, ["this operation committed"]);
  const wrongMode = "live";
  assertThrows(() => {
    bindGuardedSink(
      outcome.lease,
      // @ts-expect-error A receipt lease does not authorize a live effect.
      wrongMode,
      () => ({ value: "new effect" }),
      () => undefined,
    );
  }, TypeError);
  outcome.retire();
  assertThrows(() => acknowledge("stale receipt"), OwnershipError);
});

// Checked by Deno in the normal contract command; never executed.
function staticContract(lease: OperationLease<"live">) {
  // @ts-expect-error A plain object cannot forge an owner-issued lease.
  const forged: OperationLease<"live"> = {
    mode: "live",
    identity: lease.identity,
    assertCurrent() {},
  };
  bindGuardedSink(
    lease,
    "live",
    // @ts-expect-error Generic inference may not silently admit Promise effects.
    async (_: string) => await Promise.resolve({ value: 1 }),
    () => undefined,
  );
  bindGuardedSink<string, void, "live">(
    lease,
    "live",
    // @ts-expect-error Explicit void must not create TypeScript's () => void async loophole.
    async () => {},
    () => undefined,
  );
  // @ts-expect-error Witnesses are synchronous assertions, not async callbacks.
  createOperationLease("live", [async () => {}]);
  bindGuardedSink(
    lease,
    "live",
    () => ({ value: "data" }), // @ts-expect-error Delivery has no async or void callback loophole.
    async () => {},
  );
  bindGuardedSink(
    lease,
    "live",
    // @ts-expect-error Inspectors return envelopes, never the delivered payload itself.
    (value: string) => value,
    () => undefined,
  );
  bindGuardedSink(
    lease,
    "live",
    // @ts-expect-error Inspection envelopes cannot themselves be thenable.
    () => ({ value: "data", then() {} }),
    () => undefined,
  );
  return forged;
}
void staticContract;

for (const retireOwner of ["parent", "child"] as const) {
  Deno.test(`operation lease: inspection getter cannot retire ${retireOwner} then deliver`, () => {
    const parent = createOperationLease("live", [() => {}]);
    const child = createOperationLease("live", [() => {}], [parent.lease]);
    let reads = 0;
    const prepared = {
      value: "private bytes",
      get then() {
        reads++;
        (retireOwner === "parent" ? parent : child).retire();
        return undefined;
      },
    };
    const seen: unknown[] = [];
    const sink = bindGuardedSink(
      child.lease,
      "live",
      () => prepared,
      ({ value }) => {
        seen.push(value);
        return undefined;
      },
    );
    assertThrows(() => sink(undefined), OwnershipError, "Owner is retired");
    assertEquals([reads, seen], [1, []]);
  });
}

Deno.test("operation lease: child witnesses cannot retire an ancestor after its validation", () => {
  const parent = createOperationLease("live", [() => {}]);
  let retire = false;
  const child = createOperationLease("live", [() => {
    if (retire) parent.retire();
  }], [parent.lease]);
  const seen: string[] = [];
  const sink = bindGuardedSink(
    child.lease,
    "live",
    (value: string) => ({ value }),
    ({ value }) => {
      seen.push(value);
      return undefined;
    },
  );
  sink("current");
  retire = true;
  assertThrows(() => sink("stale"), OwnershipError, "Owner is retired");
  assertEquals(seen, ["current"]);
});

Deno.test("operation lease: envelope value access is captured before the final fence", () => {
  const owner = createOperationLease("live", [() => {}]);
  const seen: string[] = [];
  let armed = false, reads = 0;
  const sink = bindGuardedSink(owner.lease, "live", () => ({
    get value() {
      reads++;
      if (armed) owner.retire();
      return "private";
    },
  }), ({ value }) => {
    seen.push(value);
    return undefined;
  });
  sink(undefined);
  armed = true;
  assertThrows(() => sink(undefined), OwnershipError, "Owner is retired");
  assertEquals([reads, seen], [2, ["private"]]);
});

Deno.test("operation lease: malformed inspection envelopes cannot reach delivery", () => {
  const owner = createOperationLease("live", [() => {}]);
  const seen: unknown[] = [];
  for (const envelope of [null, undefined, "data", {}, () => "data"]) {
    const sink = bindGuardedSink(
      owner.lease,
      "live",
      (() => envelope) as never,
      ({ value }) => {
        seen.push(value);
        return undefined;
      },
    );
    assertThrows(
      () => sink(undefined),
      TypeError,
      "Final operation sink must be synchronous",
    );
  }
  assertEquals(seen, []);
});
