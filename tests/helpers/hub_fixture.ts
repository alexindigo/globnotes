import { testMetadata, testServices } from "./environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { publicScenario } from "./fixture_scenarios.ts";
import { GlobalConfig } from "./config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import type { ChangeEntry } from "../../server/hub/types.ts";
import {
  FileSystemNotes,
  type StorageProbes,
} from "../../server/notes/file_system.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import type { PluginRuntime } from "../../server/plugins/runtime.ts";
import { state } from "../../server/state.ts";
import { installFixtureState } from "./state.ts";
import { testEnvironment } from "./environment.ts";
import { fixtureApiOrigin } from "./plugin_fixture.ts";
import { createFixtureScope } from "./fixture_scope_engine.ts";

export async function hubOperationsFixture(
  probes: StorageProbes = {},
  options: { alias?: "sibling" | "ancestor"; changeLimit?: number } = {},
) {
  const owner = createFixtureScope();
  return await owner.prepare(async (scope) => {
    const root = (await scope.acquire(() =>
      Deno.makeTempDirSync(), (root) =>
      Deno.removeSync(root, { recursive: true }))).value;
    const realVault = `${root}/vault`;
    Deno.mkdirSync(realVault);
    let vault = realVault;
    if (options.alias) {
      vault = options.alias === "sibling"
        ? `${root}/linked-vault`
        : `${realVault}/alias`;
      Deno.symlinkSync(realVault, vault);
    }
    const env = testEnvironment({
      GLOBNOTES_GLOBNOTES_PATH: vault,
      fixtureStatePath: `${root}/state`,
      fixtureScenario: publicScenario(),
    });
    const config = new GlobalConfig(env),
      notes = new FileSystemNotes(
        config.notesPath,
        probes,
        testServices(env).notes,
      );
    const files = new FileServing(config.notesPath);
    const hub = (await scope.acquire(() =>
      new VaultHub(
        config.notesPath,
        testMetadata(config.statePath),
        testServices(env).hub,
        {
          changeLimit: options.changeLimit,
        },
      ), (hub) =>
      hub.stop())).value;
    installFixtureState(
      scope.defer,
      config,
      null,
      notes,
      null,
      files,
      null,
      hub,
    );
    const lifecycle = new PluginLifecycle(config);
    state.lifecycle = lifecycle;
    const runtime = {
      limits: { preOperationMs: 5000 },
      guard: () => [],
      assertGuardAuthority: () => {},
    } as unknown as PluginRuntime;
    const operations = new NoteOperations({
      notes,
      files,
      hub,
      indexer: null,
      lifecycle,
      runtime: () =>
        runtime,
    });
    state.operations = operations;
    const batches: ChangeEntry[][] = [];
    scope.defer(hub.subscribe((entries) => batches.push(entries)));
    return {
      root,
      realVault,
      vault: config.notesPath,
      config,
      notes,
      files,
      lifecycle,
      operations,
      hub,
      batches,
      api: scope.bind(() => fixtureApiOrigin(lifecycle)),
      scope,
      close: () => owner.close(),
    };
  });
}
