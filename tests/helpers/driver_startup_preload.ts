// SPDX-License-Identifier: LGPL-3.0-only
import { DriverSupervisor } from "../../server/hub/drivers/supervisor.ts";
import { publishDriverStartup } from "./driver_startup_protocol.ts";
import { createOwnershipScope } from "../../shared/ownership.js";

/** Observe only the first cycle per supervisor. The original promise is returned
 * unchanged; HTTP admission and production reconciliation remain asynchronous. */
export function observeDriverStartup(directory: string) {
  const reconcile = DriverSupervisor.prototype.reconcile;
  const observed = new WeakSet<DriverSupervisor>();
  const subscriptions = createOwnershipScope();
  let generation = 0;
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
    const source = sources();
    let pending = true, failure: string | null = null, publication = 0;
    let active = true;
    let unsubscribe: (() => unknown) | undefined;
    const stop = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
      }
    };
    // Reserve listener custody before subscription can invoke user code or fail.
    // Restoring the preload also fences already-pending view publications.
    subscriptions.defer(() => {
      active = false;
      publication++;
      stop();
    });
    const write = (states: Record<string, string>) => {
      if (!active || sequence !== generation) return;
      if (sources() !== source) failure = "cycle owner replaced";
      publishDriverStartup(directory, {
        pid: Deno.pid,
        owner,
        pending,
        states,
        failure,
      });
    };
    const publish = () => {
      if (!active) return;
      const version = ++publication;
      this.view().then((view) => {
        if (active && version === publication) {
          write(
            Object.fromEntries(
              view.instances.map((row) => [row.id, row.status]),
            ),
          );
        }
      }, (error) => {
        if (active && version === publication) {
          failure = String(error);
          write({});
        }
      });
    };
    write({});
    unsubscribe = this.subscribe(publish);
    const complete = (failed: boolean, error?: unknown) => {
      // Record terminal state in the actual work's first callback, including
      // rejection with undefined. Listener disposal cannot turn it into success.
      pending = false;
      if (failed) failure = String(error);
      try {
        stop();
      } catch (error) {
        failure ??= String(error);
      }
      publish();
    };
    try {
      const work = reconcile.call(this);
      const then = work.then;
      then.call(work, () => complete(false), (error) => complete(true, error));
      publish();
      return work;
    } catch (error) {
      complete(true, error);
      throw error;
    }
  };
  return () => {
    DriverSupervisor.prototype.reconcile = reconcile;
    return subscriptions.releaseAll().then((report) => report.throwIfFailed());
  };
}
