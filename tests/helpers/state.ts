import { testMetadata } from "./environment.ts";
// SPDX-License-Identifier: LGPL-3.0-only
import { publicScenario } from "./fixture_scenarios.ts";

/** In-process server state for unit-level tests (no subprocess boot). */

import { gatedNotes } from "./storage.ts";
import { GlobalConfig } from "./config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import { subscribeIndex } from "../../server/hub/subscribers.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import type { PluginRuntime } from "../../server/plugins/runtime.ts";
import { testEnvironment, testServices } from "./environment.ts";
import { fixtureApiOrigin } from "./plugin_fixture.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import type { PluginManager } from "../../server/plugins/manager.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState, type ServerState, state } from "../../server/state.ts";
import { done, pending, waitUntil } from "./wait.ts";

/** Restore even a pre-init snapshot whose required fields are not set yet. */
export function restoreState(previous: ServerState): void {
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(previous, key)) Reflect.deleteProperty(state, key);
  }
  Object.assign(state, previous);
}

// Binding history, not another resource registry. The registering fixture owner
// owns one restoration callback; this adapter only preserves ambient bindings.
const bindings: { previous: ServerState }[] = [];

/** Capture, register rollback and install as one synchronous owned step.
 * Removing a covered binding rewires its successor's predecessor snapshot,
 * leaving the active binding untouched even when fixtures close out of order. */
export function installFixtureState(
  register: (restore: () => void) => void,
  ...args: Parameters<typeof initState>
): void {
  const binding = { previous: { ...state } };
  const restore = () => {
    const index = bindings.indexOf(binding);
    if (index < 0) return;
    const next = bindings[index + 1];
    bindings.splice(index, 1);
    if (next) next.previous = binding.previous;
    else restoreState(binding.previous);
  };
  register(restore);
  bindings.push(binding);
  try {
    initState(...args);
  } catch (error) {
    try {
      restore();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Fixture state installation failed",
        { cause: error },
      );
    }
    throw error;
  }
}

export interface UnitState {
  config: GlobalConfig;
  notes: FileSystemNotes;
  indexer: Fts5Indexer;
  files: FileServing;
  hub: VaultHub;
  operations: NoteOperations;
  lifecycle: PluginLifecycle;
  api: () => ReturnType<typeof fixtureApiOrigin>;
}

export function setupState(
  vault: string,
  plugins: PluginManager | null = null,
  probes: ConstructorParameters<typeof FileSystemNotes>[1] = {},
): UnitState {
  const env = testEnvironment({
    GLOBNOTES_GLOBNOTES_PATH: vault,
    fixtureScenario: publicScenario(),
  });
  const config = new GlobalConfig(env);
  const notes = gatedNotes(
    new FileSystemNotes(vault, probes, testServices(env).notes),
  );
  const indexer = new Fts5Indexer(testMetadata(vault), testServices(env).index);
  const files = new FileServing(vault);
  initState(config, null, notes, indexer, files, plugins);
  const hub = new VaultHub(
    vault,
    testMetadata(config.statePath),
    testServices(env).hub,
  );
  subscribeIndex(hub, indexer);
  const lifecycle = new PluginLifecycle(config);
  const runtime = {
    limits: { preOperationMs: 5000 },
    guard: () => [],
    assertGuardAuthority: () => {},
  } as unknown as PluginRuntime;
  const operations = new NoteOperations({
    notes,
    files,
    indexer,
    hub,
    lifecycle,
    runtime: () => runtime,
  });
  return {
    config,
    notes,
    indexer,
    files,
    hub,
    operations,
    lifecycle,
    api: () => fixtureApiOrigin(lifecycle),
  };
}

/** Poll until the indexer's background sync reports complete. */
export function awaitIndexReady(indexer: Fts5Indexer): Promise<void> {
  return waitUntil(() => {
    const s = indexer.indexStatus;
    return !s.syncing && !s.initial ? done() : pending({ ...s });
  }, { label: "index background sync complete", intervalMs: 50 });
}
