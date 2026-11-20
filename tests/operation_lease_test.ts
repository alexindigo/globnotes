// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertOperationLease,
  createOperationLease,
  type OperationLease,
  type OperationMode,
  type OperationWitness,
} from "../server/operation_lease.ts";
import { bindGuardedSink } from "../server/internal/guarded_sink.ts";
import { OwnershipError } from "../shared/ownership.js";

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
        bindGuardedSink(lease as OperationLease<"live">, "live", () => "leak"),
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
    const consume = bindGuardedSink(own.lease, mode, (value: string) => {
      observed.push(value);
      return undefined;
    });
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
    const sink = bindGuardedSink(owner.lease, "live", (_: string) => {
      effects++;
      return undefined;
    });
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
  const deliver = bindGuardedSink(owner.lease, "live", (value: string) => {
    observed.push(value);
    owner.retire();
    return undefined;
  });
  deliver("first");
  assertThrows(() => deliver("second"), OwnershipError);
  assertEquals(observed, ["first"]);
});

Deno.test("operation lease: witness reentrancy cannot retire then permit its own effect", () => {
  let retire = () => false;
  const owner = createOperationLease("live", [() => {
    retire();
  }]);
  retire = owner.retire;
  let effects = 0;
  assertThrows(() =>
    bindGuardedSink(owner.lease, "live", () => {
      effects++;
      return undefined;
    }), OwnershipError);
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
      ),
    TypeError,
    "synchronous",
  );
  assertEquals(effects, 0);
  const disguised = bindGuardedSink(
    owner.lease,
    "live",
    (() => Promise.resolve()) as never,
  );
  assertThrows(() => disguised(undefined), TypeError, "synchronous");
  const thenable = bindGuardedSink(
    owner.lease,
    "live",
    (() => ({ then() {} })) as never,
  );
  assertThrows(() => thenable(undefined), TypeError, "synchronous");
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
  const acknowledge = bindGuardedSink(
    outcome.lease,
    "outcome",
    (value: string) => value,
  );
  live.retire();
  assertEquals(
    acknowledge("this operation committed"),
    "this operation committed",
  );
  const wrongMode = "live";
  assertThrows(() => {
    // @ts-expect-error A receipt lease does not authorize a live effect.
    bindGuardedSink(outcome.lease, wrongMode, () => "new effect");
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
  // @ts-expect-error Generic inference may not silently admit Promise effects.
  bindGuardedSink(lease, "live", async (_: string) => await Promise.resolve(1));
  // @ts-expect-error Explicit void must not create TypeScript's () => void async loophole.
  bindGuardedSink<string, void, "live">(lease, "live", async () => {});
  // @ts-expect-error Witnesses are synchronous assertions, not async callbacks.
  createOperationLease("live", [async () => {}]);
  return forged;
}
void staticContract;
