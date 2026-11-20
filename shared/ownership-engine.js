// SPDX-License-Identifier: LGPL-3.0-only
// @ts-self-types="./ownership.d.ts"

// Private resource custody engine, imported only by the public facade.
// Resource custody only: this is neither authorization nor operation settlement.
// In particular, retirement does not roll back effects or terminate a disposer.
const scopes = new WeakMap();
const handles = new WeakMap();

export class OwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = "OwnershipError";
  }
}

function releaseResult(errors, message = "Owned resource release failed") {
  const failures = Object.freeze([...errors]);
  return Object.freeze({
    errors: failures,
    // Presence, not truthiness, distinguishes a primary thrown undefined.
    throwIfFailed(...primary) {
      const all = [
        ...primary,
        ...failures.filter((error) => !primary.includes(error)),
      ];
      if (all.length === 1) throw all[0];
      if (all.length) throw new AggregateError(all, message, { cause: all[0] });
    },
  });
}

function releaseRecord(record) {
  // Cache before invoking user code: reentrant releases cannot run it twice.
  if (!record.release) {
    let complete;
    record.release = new Promise((resolve) => {
      complete = resolve;
    });
    const finish = (errors) => {
      record.owner.records.delete(record);
      complete(releaseResult(errors));
    };
    const run = (outcome) => {
      try {
        const result = outcome.acquired
          ? record.dispose(outcome.value)
          : undefined;
        if (result != null && typeof result.then === "function") {
          Promise.resolve(result).then(
            () => finish([]),
            (error) => finish([error]),
          );
        } else finish([]);
      } catch (error) {
        finish([error]);
      }
    };
    if (record.outcome) run(record.outcome);
    else record.ready.then(run);
  }
  return record.release;
}

function ownedRecord(state, handle) {
  const issued = handles.get(handle);
  if (!issued || issued.owner !== state || issued.record.handle !== handle) {
    throw new OwnershipError("Resource handle was not issued to this owner");
  }
  return issued.record;
}

function issue(state, record, value) {
  const handle = Object.freeze({ value });
  record.handle = handle;
  handles.set(handle, { owner: state, record });
  return handle;
}

export function createOwnershipScope(
  { failureMessage = "Owned resource release failed" } = {},
) {
  const state = {
    identity: Object.freeze({}),
    retired: false,
    records: new Set(),
    release: null,
  };
  const assertCurrent = (identity = state.identity) => {
    if (identity !== state.identity) {
      throw new OwnershipError("Foreign owner identity");
    }
    if (state.retired) throw new OwnershipError("Owner is retired");
  };
  const retire = () => {
    const changed = !state.retired;
    state.retired = true;
    return changed;
  };
  const reserve = (dispose) => {
    if (typeof dispose !== "function") {
      throw new TypeError("Resource disposer must be callable");
    }
    let resolveReady;
    const record = {
      owner: state,
      dispose,
      ready: new Promise((resolve) => {
        resolveReady = resolve;
      }),
      outcome: null,
      release: null,
      handle: null,
    };
    state.records.add(record);
    const ready = (outcome) => {
      record.outcome = outcome;
      resolveReady(outcome);
    };
    return { record, ready };
  };
  const finish = async (record) => {
    const outcome = await record.ready;
    if (!outcome.acquired) {
      state.records.delete(record);
      throw outcome.error;
    }
    try {
      assertCurrent();
    } catch (primary) {
      releaseResult((await releaseRecord(record)).errors, failureMessage)
        .throwIfFailed(primary);
    }
    return issue(state, record, outcome.value);
  };
  const scope = Object.freeze({
    identity: state.identity,
    get retired() {
      return state.retired;
    },
    get size() {
      return state.records.size;
    },
    assertCurrent,
    retire,
    defer(dispose) {
      // No allocation: reserve a callback synchronously before its future work.
      // Unlike adopt, rejected defer has no already-created resource to roll back.
      assertCurrent();
      const { record, ready } = reserve(dispose);
      ready({ acquired: true, value: undefined });
      return issue(state, record, undefined);
    },
    adopt(value, dispose) {
      // Already acquired: even a retired owner must roll it back before rejecting.
      const { record, ready } = reserve(dispose);
      ready({ acquired: true, value });
      return finish(record);
    },
    acquire(allocate, dispose) {
      assertCurrent();
      if (typeof allocate !== "function") {
        throw new TypeError("Resource allocator must be callable");
      }
      // Reserve before allocation can reenter or fail, not after its first await.
      const { record, ready } = reserve(dispose);
      try {
        Promise.resolve(allocate()).then(
          (value) => ready({ acquired: true, value }),
          (error) => ready({ acquired: false, error }),
        );
      } catch (error) {
        ready({ acquired: false, error });
      }
      return finish(record);
    },
    release(handle) {
      return releaseRecord(ownedRecord(state, handle)).then((result) =>
        result.throwIfFailed()
      );
    },
    transfer(handle, target) {
      const record = ownedRecord(state, handle);
      const destination = scopes.get(target);
      if (!destination) {
        throw new OwnershipError("Transfer target is not an issued owner");
      }
      assertCurrent();
      target.assertCurrent();
      if (record.release) {
        throw new OwnershipError("Resource release has already started");
      }
      state.records.delete(record);
      record.owner = destination;
      destination.records.add(record);
      return issue(destination, record, handle.value);
    },
    releaseAll() {
      // The fence takes effect in this turn, before any disposer runs or awaits.
      retire();
      if (!state.release) {
        let complete;
        state.release = new Promise((resolve) => {
          complete = resolve;
        });
        const drain = async () => {
          const errors = [];
          while (state.records.size) {
            for (const record of [...state.records].reverse()) {
              errors.push(...(await releaseRecord(record)).errors);
            }
          }
          complete(releaseResult(errors, failureMessage));
        };
        void drain();
      }
      return state.release;
    },
  });
  scopes.set(scope, state);
  return scope;
}
