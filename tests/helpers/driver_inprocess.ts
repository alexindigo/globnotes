// SPDX-License-Identifier: LGPL-3.0-only
import { DriverSupervisor } from "../../server/hub/drivers/supervisor.ts";
import { ObservedClock } from "../../server/observed_time.ts";
import { state } from "../../server/state.ts";
import { hubOperationsFixture } from "./hub_fixture.ts";
import { createPluginManager } from "./plugin_manager.ts";
import type { memoryRemote } from "./memory_remote.ts";
import { LivenessClock } from "./worker_liveness.ts";
import { done, pending, waitUntil } from "./wait.ts";

/** Real runtime composition with deterministic supervisor scheduling. Native
 * HTTP/Worker boundaries are unchanged; no fake driver or direct SDK invocation. */
export async function hubDriverFixture(
  remote: ReturnType<typeof memoryRemote>,
  options: {
    native?: boolean;
    changeLimit?: number;
    maxBatch?: number;
  } = {},
) {
  const f = hubOperationsFixture({}, { changeLimit: options.changeLimit });
  const root = new URL(
    "../fixtures/plugins/globnotes-test-driver/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    Deno.readTextFileSync(new URL("manifest.json", root)),
  );
  manifest.capabilities.network = [remote.authority];
  if (options.native) {
    manifest.driver.entry = "native.js";
    manifest.driver.capabilities.discovery.delta = true;
    manifest.driver.capabilities.groups = "atomic";
  }
  if (options.maxBatch) {
    manifest.driver.capabilities.limits.maxBatch = options.maxBatch;
  }
  const dir = `${f.config.statePath}/plugins/globnotes-test-driver`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}/manifest.json`, JSON.stringify(manifest));
  for (const file of ["driver.js", "native.js"]) {
    Deno.copyFileSync(new URL(file, root), `${dir}/${file}`);
  }
  const manager = createPluginManager(
    f.vault,
    undefined,
    1,
    f.config.statePath,
    {
      internalRoot: `${f.root}/no-internal`,
      autoEnable: true,
      environment: true,
      persistence: { commit: (effect) => f.lifecycle.gate.run(effect) },
    },
  );
  const scheduler = new LivenessClock();
  const supervisor = new DriverSupervisor({
    hub: f.hub,
    operations: f.operations,
    plugins: manager,
    lifecycle: f.lifecycle,
    clock: new ObservedClock(scheduler),
  });
  manager.configureDrivers(supervisor);
  state.plugins = manager;
  state.drivers = supervisor;
  const permissions = await manager.network.view(manifest.id);
  await manager.network.controls(manifest.id, {
    revision: permissions.revision,
    signature: permissions.signature,
    requestSourceKey: permissions.requestSourceKey,
    requestSourceRevision: permissions.requestSourceRevision,
    allowNetwork: true,
    approvedNetwork: permissions.requestedNetwork,
    approvedImports: [],
  });
  await waitUntil(async () => {
    const view = await manager.network.view(manifest.id);
    return ["ready", "failed"].includes(view.reload.state)
      ? done()
      : pending(view.reload);
  }, { label: "native driver fixture permission admission" });
  const guard = () => {};
  const one = async (id: string) =>
    (await supervisor.view()).instances.find((row) => row.id === id)!;
  const configure = async (id: string, enabled: boolean) => {
    const row = supervisor.peers.instance(id)!;
    return await supervisor.update(id, {
      revision: row.revision,
      label: row.label,
      settings: row.settings,
      enabled,
    }, guard);
  };
  return {
    ...f,
    manager,
    supervisor,
    scheduler,
    one,
    configure,
    async add(label = "Remote") {
      const row = await supervisor.create({
        plugin: manifest.id,
        label,
        settings: {
          baseUrl: remote.baseUrl,
          atomicGroups: options.native ?? false,
        },
      }, guard);
      await supervisor.secret(
        row.id,
        "token",
        { revision: row.revision, value: remote.token },
        false,
        guard,
      );
      await configure(row.id, true);
      return row.id;
    },
    async run(id: string) {
      await supervisor.sync(id, {
        revision: supervisor.peers.instance(id)!.revision,
      }, guard);
      return await one(id);
    },
    async close() {
      await supervisor.close();
      manager.stop();
      f.close();
    },
  };
}
