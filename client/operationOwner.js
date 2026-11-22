// SPDX-License-Identifier: LGPL-3.0-only
import { createOwnershipScope, OwnershipError } from "../shared/ownership.js";

// Capture adapter methods once, retaining their receiver. Delivery preparation
// returns an envelope: a thenable *value* is data, never an operation to await.
function method(adapters, name, fallback) {
  const fn = adapters[name] ?? fallback;
  if (typeof fn !== "function") throw new TypeError(`Operation ${name} must be callable`);
  return fn.bind(adapters);
}
function channel(adapter) {
  const prepare = method(adapter, "prepare", value => ({ value }));
  const deliver = method(adapter, "deliver");
  return value => {
    const envelope = prepare(value);
    if (!envelope || typeof envelope !== "object") throw new TypeError("Delivery requires a value envelope");
    const then = envelope.then;
    if (typeof then === "function") throw new TypeError("Delivery preparation must be synchronous");
    const captured = envelope.value;
    return { deliver, value: captured };
  };
}

/** Plain workflow adapter, not an authority evaluator or a scheduler. The domain
 * supplies one immutable workflow identity and transports/channels at construction.
 * revoke() ends live permission; dispose() ends the entire credential attempt.
 * Retained/outcome/recovery handles accept one original completion after revoke,
 * but cannot dispatch again or deliver live effects such as navigation. */
export function createOperationOwner(adapters) {
  const workflow = adapters.owner;
  if (!workflow || typeof workflow !== "object" || !Object.isFrozen(workflow)) {
    throw new TypeError("Operation owner requires a non-null immutable workflow identity");
  }
  const dispatch = method(adapters, "dispatch");
  const prepareIntent = method(adapters, "prepare", value => ({ value }));
  const release = method(adapters, "release", () => {});
  const cancel = method(adapters, "cancel", () => {});
  const channels = new Map(Object.entries(adapters.channels ?? {}).map(([name, adapter]) => [name, channel(adapter)]));
  const completionAdapter = adapters.completion;
  const completion = completionAdapter ? channel(completionAdapter) : null;
  const custody = createOwnershipScope();
  const permission = createOwnershipScope();
  const issued = new WeakMap();
  const pending = new Set();
  let closing = null, cancellation;
  // P02 awaits the single captured cancellation result and reports its failure
  // after all wire disposers. Cancellation itself starts before draining wires.
  custody.defer(() => cancellation);

  function record(operation) {
    const entry = issued.get(operation);
    if (!entry) throw new OwnershipError("Operation was not issued to this owner");
    return entry;
  }
  function current(entry, retained = false) {
    if (custody.retired || entry.released) return false;
    return retained && entry.mode !== "live" || !permission.retired;
  }
  function deliver(operation, name, value, terminal) {
    const entry = record(operation);
    const prepare = terminal ? completion : channels.get(name);
    if (!prepare) throw new TypeError("Unknown operation delivery channel");
    if (!entry.dispatched || entry.completed || !current(entry, terminal)) return false;
    // Getters and domain preparation may retire the owner or complete reentrantly.
    const prepared = prepare(value);
    if (entry.completed || !current(entry, terminal)) return false;
    if (terminal) entry.completed = true;
    prepared.deliver(prepared.value);
    return true;
  }
  const owner = Object.freeze({
    identity: custody.identity,
    workflow,
    operation(mode = "live") {
      custody.assertCurrent(); permission.assertCurrent();
      if (!["live", "retained", "outcome", "recovery"].includes(mode)) throw new TypeError("Unknown operation mode");
      const operation = Object.freeze({ mode });
      const scope = createOwnershipScope();
      const resource = custody.defer(async () => { (await scope.releaseAll()).throwIfFailed(); });
      issued.set(operation, { mode, scope, resource, started: false, dispatched: false, completed: false, released: false });
      return operation;
    },
    async dispatch(operation, intent) {
      const entry = record(operation);
      custody.assertCurrent(); permission.assertCurrent();
      if (entry.started || entry.released) throw new OwnershipError("Operation has already been dispatched or released");
      entry.started = true;
      // Publish the exact work join before transport/preparation can reenter
      // hasWork/settle. This is accounting, not another dispatch queue.
      const job = Promise.withResolvers();
      pending.add(job.promise);
      // Reserve custody before transport entry. Keep values in the P02 handle;
      // returning a bare thenable value across this await would assimilate it.
      const work = entry.scope.acquire(() => {
        const prepared = prepareIntent(intent);
        if (!prepared || typeof prepared !== "object") throw new TypeError("Dispatch requires a value envelope");
        const then = prepared.then;
        if (typeof then === "function") throw new TypeError("Dispatch preparation must be synchronous");
        const value = prepared.value;
        custody.assertCurrent(); permission.assertCurrent();
        if (entry.released) throw new OwnershipError("Operation has been released");
        entry.dispatched = true;
        return dispatch(value, Object.freeze({
          operation,
          deliver: (name, value) => deliver(operation, name, value, false),
          complete: value => deliver(operation, null, value, true),
        }));
      }, release);
      work.then(job.resolve, job.reject);
      try { return await job.promise; }
      finally { pending.delete(job.promise); }
    },
    deliver: (operation, name, value) => deliver(operation, name, value, false),
    complete: (operation, value) => deliver(operation, null, value, true),
    async release(operation) {
      const entry = record(operation);
      entry.released = true; // fence before joining or invoking external cleanup
      await custody.release(entry.resource);
    },
    revoke: () => permission.retire(),
    hasWork: () => pending.size > 0,
    async settle() { return Object.freeze(await Promise.allSettled([...pending])); },
    dispose() {
      if (closing) return closing;
      custody.retire(); permission.retire();
      let released;
      // Cache the join before cancel/dispose can reenter. The final report is
      // P02's own immutable all-attempt result, not another disposer engine.
      closing = Promise.resolve().then(() => released);
      try { cancellation = cancel(); }
      catch (error) { cancellation = Promise.reject(error); }
      // Observe rejection immediately even if an original wire is still pending.
      if (cancellation !== undefined) {
        const observed = Promise.resolve(cancellation);
        observed.catch(() => {});
        cancellation = observed;
      }
      released = custody.releaseAll();
      return closing;
    },
  });
  return owner;
}
