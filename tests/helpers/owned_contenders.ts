// SPDX-License-Identifier: LGPL-3.0-only
import {
  type HeldOperation,
  heldOperation,
  type HeldOperationOptions,
} from "./owned_operation.ts";

export type Contender<T> = Omit<HeldOperationOptions, "label"> & {
  start: (hold: () => Promise<void>, signal: AbortSignal) => T | Promise<T>;
};
export type ContenderOutcomes<T> = {
  readonly [Name in keyof T]: PromiseSettledResult<T[Name]>;
};

/** Names bind admission and completion to the same P04 operation. All contenders
 * must enter before completeFirst is released; its actual completion precedes
 * release of the rest. This chooses an order, not a claimed business winner.
 * Results preserve names and errors, never submission positions or success counts.
 * The selected operation must be able to finish while peers remain held.
 * No handles escape; P04 owns containment, release/drain and failure reporting. */
export async function ownedContenders<T extends Record<string, unknown>>(
  contenders: { [Name in keyof T]: Contender<T[Name]> },
  completeFirst: keyof T & string,
): Promise<ContenderOutcomes<T>> {
  if (
    !contenders || typeof contenders !== "object" ||
    Array.isArray(contenders) ||
    Object.getOwnPropertySymbols(contenders).length > 0
  ) {
    throw new TypeError("Contenders require a named operation map");
  }
  const named: Record<string, Contender<unknown>> = contenders;
  const entries = Object.getOwnPropertyNames(named).map(
    (name) => {
      const contender = named[name];
      if (!name || /^\d+$/.test(name)) {
        throw new TypeError("Contender names cannot be numeric positions");
      }
      const signal = contender?.signal;
      signal?.throwIfAborted();
      const { start, owner, progress: inputProgress } = contender ?? {};
      if (typeof start !== "function" || typeof owner !== "function") {
        throw new TypeError(
          `${name}: contender requires its own start and owner`,
        );
      }
      const kind = inputProgress?.kind;
      const clock = kind === "controlled" ? inputProgress.clock : undefined;
      if (
        kind !== "product" &&
        !(kind === "controlled" && (clock === "manual" || clock === "external"))
      ) throw new TypeError("Operation requires an explicit progress mode");
      const progress: HeldOperationOptions["progress"] = kind === "product"
        ? { kind }
        : { kind, clock: clock as "manual" | "external" };
      // Capture each public port once, including non-enumerable definitions.
      // Bind methods to their real definition, not a spread clone or P04 options.
      return [name, {
        start: start.bind(contender),
        owner: owner.bind(contender),
        progress,
        signal,
      }] as const;
    },
  );
  if (
    typeof completeFirst !== "string" ||
    !entries.some(([name]) => name === completeFirst)
  ) throw new TypeError("completeFirst must name an own contender");

  const cancellation = new AbortController();
  const operations = new Map<string, HeldOperation<unknown>>();
  const releaseGroup = () => {
    if (cancellation.signal.aborted) return;
    try {
      for (const held of operations.values()) held.release();
    } catch (error) {
      // A revoked peer cannot accept release(). P04's signal listener opens
      // every remaining gate synchronously before any nested scope drains.
      cancellation.abort(error);
      throw error;
    }
  };
  const settle = async (operation: HeldOperation<unknown>) => {
    try {
      return { status: "fulfilled", value: await operation.result() } as const;
    } catch (reason) {
      // A rejected product result is an outcome only while its P04 handle is
      // still current. Its idempotent release port checks that same authority;
      // revocation must cancel peers now, not wait for a dependent result first.
      try {
        operation.release();
      } catch (guardError) {
        const failure = guardError === reason ? reason : new AggregateError(
          [reason, guardError],
          "Contender result authority failed",
          { cause: reason },
        );
        cancellation.abort(failure);
        throw failure;
      }
      return { status: "rejected", reason } as const;
    }
  };
  const enter = async (index: number): Promise<ContenderOutcomes<T>> => {
    if (index === entries.length) {
      await Promise.all(
        [...operations.values()].map((operation) => operation.reached()),
      );
      const outcomes: Record<string, PromiseSettledResult<unknown>> = Object
        .create(null);
      outcomes[completeFirst] = await settle(operations.get(completeFirst)!);
      await Promise.all([...operations].map(async ([name, operation]) => {
        if (name !== completeFirst) outcomes[name] = await settle(operation);
      }));
      return Object.freeze(outcomes) as ContenderOutcomes<T>;
    }
    const [name, contender] = entries[index];
    return await heldOperation(
      {
        label: `contender ${name}`,
        owner: contender.owner,
        progress: contender.progress,
        signal: contender.signal
          ? AbortSignal.any([contender.signal, cancellation.signal])
          : cancellation.signal,
      },
      contender.start,
      async (operation) => {
        operations.set(name, operation);
        try {
          return await enter(index + 1);
        } catch (error) {
          // Failed admission must cancel every live peer before any nested P04
          // scope drains, including IO that cannot finish merely by releasing hold.
          cancellation.abort(error);
          throw error;
        } finally {
          // Release the entire group before any nested P04 disposer joins work.
          // A contender may need a peer's release even on failed admission.
          try {
            releaseGroup();
          } finally {
            // This callback is the handle's custody boundary. Outer callbacks
            // must never release it after P04 has retired its scope.
            operations.delete(name);
          }
        }
      },
    );
  };
  try {
    return await enter(0);
  } finally {
    cancellation.abort();
  }
}
