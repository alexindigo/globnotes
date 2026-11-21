// SPDX-License-Identifier: LGPL-3.0-only
import { DriverSupervisor } from "../../server/hub/drivers/supervisor.ts";
import { DriverPeers } from "../../server/hub/drivers/peers.ts";
import {
  publishDriverStartup,
  reportDriverStartupFailure,
} from "./driver_startup_protocol.ts";
import { createOwnershipScope } from "../../shared/ownership.js";

/** Test-only observer. Product work/throws retain their identity even when every
 * filesystem publication fails. Status is captured at its synchronous producer,
 * never through the HTTP view's asynchronous catalog/live-slot projection. */
export function observeDriverStartup(directory: string, options: {
  publish?: typeof publishDriverStartup;
  report?: (error: unknown) => void;
} = {}) {
  const {
    publish: publishPort = publishDriverStartup,
    report: reportPort = reportDriverStartupFailure,
  } = options;
  const publish = publishPort.bind(options), report = reportPort.bind(options);
  const reconcile = DriverSupervisor.prototype.reconcile;
  const observeStatus = DriverPeers.prototype.observeStatus;
  const observed = new WeakSet<DriverSupervisor>();
  const statuses = new WeakMap<DriverPeers, Map<string, string>>();
  const subscriptions = createOwnershipScope();
  let generation = 0;
  const fault = (error: unknown) => {
    // The parent consumes this separate pipe even when the record filesystem is
    // full. A broken report transport cannot throw into the observed operation.
    try {
      report(error);
    } catch { /* parent owns the pipe/child lifetime */ }
  };
  DriverPeers.prototype.observeStatus = function (peer, status, enabled) {
    const result = observeStatus.call(this, peer, status, enabled);
    try {
      statuses.get(this)?.set(peer, status);
    } catch (error) {
      fault(error);
    }
    return result;
  };
  DriverSupervisor.prototype.reconcile = function () {
    if (observed.has(this)) return reconcile.call(this);
    observed.add(this);
    const sequence = ++generation;
    const owner = `${Deno.pid}:${sequence}`;
    const sources = () =>
      JSON.stringify([
        this.adapters.lifecycle.epoch,
        this.peers.instances().map((instance) => [
          instance.id,
          instance.revision,
          this.adapters.plugins.driverOwner(instance.plugin).epoch,
        ]),
      ]);
    let source: string | undefined;
    try {
      statuses.set(this.peers, new Map());
      source = sources();
    } catch (error) {
      fault(error);
    }

    // Invoke the original independently of all observer construction/publication.
    let work: Promise<void> | undefined;
    let thrown = false, originalError: unknown;
    try {
      work = reconcile.call(this);
    } catch (error) {
      thrown = true;
      originalError = error;
    }
    try {
      let pending = true, active = true, failure: string | null = null;
      let unsubscribe: (() => unknown) | undefined;
      const stop = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      };
      subscriptions.defer(() => {
        active = false;
        stop();
      });
      const collect = () =>
        Object.fromEntries(
          this.peers.instances().map((instance) => {
            const status = statuses.get(this.peers)?.get(instance.id);
            if (status === undefined) {
              throw Error(`Driver status not observed: ${instance.id}`);
            }
            return [instance.id, status];
          }),
        );
      const write = (states: Record<string, string>) => {
        if (!active || sequence !== generation) return;
        if (sources() !== source) failure = "cycle owner replaced";
        publish(directory, {
          pid: Deno.pid,
          owner,
          sequence,
          pending,
          states,
          failure,
        });
      };
      const safely = (effect: () => void) => {
        if (!active) return;
        try {
          effect();
        } catch (error) {
          fault(error);
        }
      };
      const complete = (failed: boolean, error?: unknown) =>
        safely(() => {
          // No await or live view read may sit between settlement and this copy.
          const terminal = collect();
          pending = false;
          if (failed) failure = String(error);
          try {
            stop();
          } catch (error) {
            failure ??= String(error);
          }
          write(terminal);
        });
      if (thrown) complete(true, originalError);
      else {
        unsubscribe = this.subscribe(() => {
          if (pending) safely(() => write(collect()));
        });
        const then = work!.then;
        then.call(
          work,
          () => complete(false),
          (error) => complete(true, error),
        );
        if (pending) safely(() => write(collect()));
      }
    } catch (error) {
      fault(error);
    }
    if (thrown) throw originalError;
    return work!;
  };
  let restored = false;
  return () => {
    if (!restored) {
      restored = true;
      DriverSupervisor.prototype.reconcile = reconcile;
      DriverPeers.prototype.observeStatus = observeStatus;
    }
    return subscriptions.releaseAll().then((report) => report.throwIfFailed());
  };
}
