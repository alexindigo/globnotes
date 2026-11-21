// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DriverCycleStatus,
  DriverSupervisor,
} from "../../server/hub/drivers/supervisor.ts";
import type { DriverPeers } from "../../server/hub/drivers/peers.ts";
import {
  publishDriverStartup,
  reportDriverStartupFailure,
} from "./driver_startup_protocol.ts";
import { createOwnershipScope } from "../../shared/ownership.js";

interface ObserverIdentity {
  readonly supervisor: DriverSupervisor;
  readonly peer: DriverPeers;
  readonly sequence: number;
  readonly owner: string;
}
interface ObserverPorts {
  publish: typeof publishDriverStartup;
  report: (error: unknown) => void;
}

/** A generation owns its status cache, subscription, terminal copy and faults.
 * Nothing retained by a previous generation can collect or report for this one. */
function createStartupObserver(
  directory: string,
  identity: ObserverIdentity,
  ports: ObserverPorts,
  current: () => boolean,
) {
  let active = true, pending = true, failure: string | null = null;
  let unsubscribe: (() => void) | undefined, source: string | undefined;
  const cycles = new Map<string, DriverCycleStatus>();
  const sources = () =>
    JSON.stringify([
      identity.supervisor.adapters.lifecycle.epoch,
      identity.peer.instances().map((instance) => [
        instance.id,
        instance.revision,
        identity.supervisor.adapters.plugins.driverOwner(instance.plugin).epoch,
      ]),
    ]);
  const live = () => active && current();
  // One exit path, including failed collection. Failed listener disposal remains
  // available for the enclosing owner's cleanup retry, never for another report.
  const dispose = () => {
    pending = false;
    active = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  };
  const report = (error: unknown) => {
    if (!current()) return;
    try {
      ports.report(error);
    } catch { /* parent owns the pipe/child lifetime */ }
  };
  const fail = (error: unknown) => {
    const admitted = live();
    try {
      dispose();
    } catch (cleanup) {
      error = new AggregateError(
        [error, cleanup],
        "Driver observation and disposal failed",
        { cause: error },
      );
    }
    if (admitted) report(error);
  };
  const collect = () => {
    if (!live()) return {};
    for (const status of identity.supervisor.statusSnapshot()) {
      if (!live()) return {};
      const captured = cycles.get(status.peer);
      if (
        !captured ||
        captured.result === null &&
          Object.is(captured.generation, status.generation) &&
          captured.cycle === status.cycle
      ) {
        // Values are copies; a later producer cannot mutate a retained entry.
        cycles.set(status.peer, Object.freeze({ ...status }));
      }
    }
    return Object.fromEntries(
      identity.peer.instances().flatMap((instance) => {
        const status = cycles.get(instance.id);
        if (!status) {
          if (pending) return [];
          throw Error(`Driver status not observed: ${instance.id}`);
        }
        return [[instance.id, status.result ?? status.status]];
      }),
    );
  };
  const write = (states: Record<string, string>, terminal = false) => {
    const mayPublish = () => current() && (terminal || active && pending);
    if (!mayPublish()) return;
    if (
      !Object.is(identity.supervisor.peers, identity.peer) ||
      sources() !== source
    ) {
      failure = "cycle owner replaced";
    }
    if (!mayPublish()) return;
    ports.publish(directory, {
      pid: Deno.pid,
      owner: identity.owner,
      sequence: identity.sequence,
      pending,
      states,
      failure,
    });
  };
  const notify = () => {
    if (!live() || !pending) return;
    try {
      write(collect());
    } catch (error) {
      fail(error);
    }
  };
  const complete = (failed: boolean, reason?: unknown) => {
    if (!live()) {
      try {
        dispose();
      } catch { /* retained for owner cleanup */ }
      return;
    }
    // Clearing pending first fences reentrant notifications. The terminal copy
    // is taken before disposal, without an async read or cleanup in between.
    pending = false;
    let terminal: Record<string, string> | undefined;
    let error: { value: unknown } | undefined;
    try {
      terminal = collect();
      if (failed) failure = String(reason);
    } catch (value) {
      error = { value };
    } finally {
      try {
        dispose();
      } catch (value) {
        error = {
          value: error
            ? new AggregateError(
              [error.value, value],
              "Driver observation and disposal failed",
              { cause: error.value },
            )
            : value,
        };
      }
    }
    if (!current()) return;
    if (error) report(error.value);
    else {
      try {
        write(terminal!, true);
      } catch (error) {
        report(error);
      }
    }
  };
  return {
    dispose,
    complete,
    connect() {
      if (!live()) return;
      try {
        source = sources();
        unsubscribe = identity.supervisor.subscribe(notify);
        if (!live()) dispose();
      } catch (error) {
        fail(error);
      }
    },
    watch(work: Promise<void>) {
      if (!live()) return;
      try {
        const then = work.then;
        then.call(
          work,
          () => complete(false),
          (error) => complete(true, error),
        );
        notify();
      } catch (error) {
        fail(error);
      }
    },
  };
}

/** Test-only observer. Reconciliation always runs and retains its exact promise
 * or synchronous throw, independently of observation setup/publication errors. */
export function observeDriverStartup(
  directory: string,
  options: Partial<ObserverPorts> = {},
) {
  const {
    publish = publishDriverStartup,
    report = reportDriverStartupFailure,
  } = options;
  const ports = {
    publish: publish.bind(options),
    report: report.bind(options),
  };
  const reconcile = DriverSupervisor.prototype.reconcile;
  const observed = new WeakSet<DriverSupervisor>();
  const subscriptions = createOwnershipScope();
  let generation = 0;
  let restored = false;
  let latest: ReturnType<typeof createStartupObserver> | undefined;
  DriverSupervisor.prototype.reconcile = function () {
    if (restored || observed.has(this)) return reconcile.call(this);
    observed.add(this);
    const sequence = ++generation;
    try {
      latest?.dispose();
    } catch { /* cleanup retry belongs to its owner */ }
    let observer: ReturnType<typeof createStartupObserver> | undefined;
    try {
      observer = createStartupObserver(
        directory,
        Object.freeze({
          supervisor: this,
          peer: this.peers,
          sequence,
          owner: `${Deno.pid}:${sequence}`,
        }),
        ports,
        () => !restored && sequence === generation,
      );
      latest = observer;
      subscriptions.defer(observer.dispose);
      observer.connect();
    } catch (error) {
      if (!restored && sequence === generation) {
        try {
          ports.report(error);
        } catch { /* do not replace original work */ }
      }
    }
    let work: Promise<void>;
    try {
      work = reconcile.call(this);
    } catch (error) {
      observer?.complete(true, error);
      throw error;
    }
    observer?.watch(work);
    return work;
  };
  return () => {
    if (!restored) {
      restored = true;
      generation++;
      DriverSupervisor.prototype.reconcile = reconcile;
    }
    return subscriptions.releaseAll().then((report) => report.throwIfFailed());
  };
}
