// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { VaultHub } from "../server/hub/hub.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { PluginRuntime } from "../server/plugins/runtime.ts";
import { state } from "../server/state.ts";
import { auxiliaryFixture } from "./helpers/auxiliary_fixture.ts";
import { backupFixture } from "./helpers/backup_fixture.ts";
import { bundle } from "./helpers/plugin_lifecycle.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { restoreState } from "./helpers/state.ts";
import { bounded, WorkerDeliveryGate } from "./helpers/worker_liveness.ts";

const scenarios = [
  {
    name: "bundle reconcile removes opted-out fixture",
    id: "recorder",
    stage: "reconcile",
    retain: false,
    setup: () => bundle({ retain: false }),
  },
  {
    name: "bundle settled rejection retains evidence",
    id: "recorder",
    stage: "settled",
    retain: true,
    setup: () => bundle(),
  },
  {
    name: "bundle cleanup errors preserve setup error",
    id: "recorder",
    stage: "reconcile",
    retain: true,
    cleanupErrors: true,
    setup: () => bundle({ retain: false }),
  },
  {
    name: "auxiliary reconcile retains evidence",
    id: "auxiliary",
    stage: "reconcile",
    retain: true,
    setup: () => auxiliaryFixture(),
  },
  {
    name: "backup reconcile restores state",
    id: "globnotes-backup",
    stage: "reconcile",
    retain: true,
    setup: () => backupFixture(),
  },
  {
    name: "auxiliary partial configure closes manager-owned runtime",
    id: "auxiliary",
    stage: "configure",
    retain: true,
    setup: () => auxiliaryFixture(),
  },
];

for (const scenario of scenarios) {
  Deno.test(`fixture setup cleanup: ${scenario.name}`, async () => {
    const setupError = new Error("fixture setup sentinel");
    const cleanupError = new Error("fixture cleanup sentinel");
    const events: string[] = [];
    const roots: string[] = [];
    const managers: PluginManager[] = [];
    const runtimes: PluginRuntime[] = [];
    const hubs: VaultHub[] = [];
    const scanNow = VaultHub.prototype.scanNow;
    const previousState = { ...state };
    const makeTempDir = Deno.makeTempDir;
    const remove = Deno.remove;
    const configure = PluginManager.prototype.configureRuntime;
    const reconcile = PluginRuntime.prototype.reconcile;
    const close = PluginRuntime.prototype.close;
    const stop = PluginManager.prototype.stop;
    const gate = new WorkerDeliveryGate();
    gate.holdHeartbeat = false;
    VaultHub.prototype.scanNow = function (...args) {
      if (!hubs.includes(this)) hubs.push(this);
      return scanNow.apply(this, args);
    };
    Deno.makeTempDir = async (options) => {
      const root = await makeTempDir(options);
      if (options?.prefix === "globnotes-platform-") roots.push(root);
      return root;
    };
    Deno.remove = async (path, options) => {
      if (roots.includes(String(path))) {
        events.push("fixture");
        if (scenario.cleanupErrors) throw cleanupError;
      }
      await remove(path, options);
    };
    PluginManager.prototype.configureRuntime = function (...args) {
      managers.push(this);
      const runtime = configure.apply(this, args);
      runtimes.push(runtime);
      if (scenario.stage === "configure") throw setupError;
      return runtime;
    };
    PluginRuntime.prototype.reconcile = async function () {
      await reconcile.call(this);
      await pluginSettled(this, scenario.id, "ready");
      if (scenario.stage === "settled") {
        const status = this.status;
        this.status = () => {
          this.status = status;
          throw setupError;
        };
        return;
      }
      throw setupError;
    };
    PluginRuntime.prototype.close = async function () {
      events.push("runtime");
      await close.call(this);
      if (scenario.cleanupErrors) throw cleanupError;
    };
    PluginManager.prototype.stop = function () {
      events.push("manager");
      stop.call(this);
      if (scenario.cleanupErrors) throw cleanupError;
    };
    try {
      const error = await bounded(
        scenario.setup().then(() => undefined, (error: unknown) => error),
        scenario.name,
        10000,
      );
      if (scenario.stage === "settled") {
        assert(error instanceof Error);
        assertEquals(error.cause, setupError);
      } else assertEquals(error, setupError);
      assertEquals(events.slice(0, 2), ["runtime", "manager"]);
      assertEquals({ ...state }, previousState);
      assertEquals(managers.length, 1);
      assertEquals(runtimes.length, 1);
      assertEquals(runtimes[0].isEnabled(scenario.id), false);
      assertEquals(runtimes[0].commands(), []);
      if (scenario.name.startsWith("bundle")) {
        assertEquals(hubs.length, 1);
        assertThrows(() => hubs[0].store.files());
      }
      if (scenario.stage !== "configure") assert(gate.workers.length > 0);
      assert(gate.workers.every((worker) => worker.terminated > 0));
      assertEquals(roots.length, 1);
      if (scenario.retain) {
        assert((await Deno.stat(roots[0])).isDirectory);
      } else {
        await assertRejects(() => Deno.stat(roots[0]), Deno.errors.NotFound);
      }
      if (scenario.cleanupErrors) {
        assertEquals(events, ["runtime", "manager", "fixture"]);
      }
    } finally {
      Deno.makeTempDir = makeTempDir;
      Deno.remove = remove;
      PluginManager.prototype.configureRuntime = configure;
      PluginRuntime.prototype.reconcile = reconcile;
      PluginRuntime.prototype.close = close;
      PluginManager.prototype.stop = stop;
      VaultHub.prototype.scanNow = scanNow;
      for (const runtime of runtimes) await close.call(runtime);
      for (const manager of managers) stop.call(manager);
      for (const hub of hubs) {
        try {
          hub.stop();
        } catch { /* already closed by the failed setup owner */ }
      }
      restoreState(previousState);
      gate.restore();
      for (const root of roots) {
        await remove(root, { recursive: true }).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    }
  });
}
