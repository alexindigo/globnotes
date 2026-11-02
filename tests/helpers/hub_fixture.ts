// SPDX-License-Identifier: LGPL-3.0-only
import { GlobalConfig } from "../../server/config.ts";
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
import { initState, state } from "../../server/state.ts";
import { testEnvironment } from "./environment.ts";
import { fixtureApiOrigin } from "./plugin_fixture.ts";

export function hubOperationsFixture(
  probes: StorageProbes = {},
  options: { alias?: "sibling" | "ancestor" } = {},
) {
  const previous = { ...state };
  const root = Deno.makeTempDirSync();
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
    GLOBNOTES_PATH: vault,
    GLOBNOTES_INDEX_PATH: `${root}/state`,
    GLOBNOTES_AUTH_TYPE: "none",
  });
  const config = new GlobalConfig(env),
    notes = new FileSystemNotes(config.notesPath, probes, env);
  const files = new FileServing(config.notesPath),
    hub = new VaultHub(config.notesPath, config.statePath, env);
  initState(config, null, notes, null, files, null, hub);
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
    runtime: () => runtime,
  });
  state.operations = operations;
  const batches: ChangeEntry[][] = [];
  hub.subscribe((entries) => batches.push(entries));
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
    api: () => fixtureApiOrigin(lifecycle),
    close() {
      hub.stop();
      Object.assign(state, previous);
      Deno.removeSync(root, { recursive: true });
    },
  };
}
