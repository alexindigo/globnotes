// SPDX-License-Identifier: LGPL-3.0-only

/** In-process server state for unit-level tests (no subprocess boot). */

import { GlobalConfig } from "../../server/config.ts";
import { FileServing } from "../../server/files/file_serving.ts";
import { VaultHub } from "../../server/hub/hub.ts";
import { subscribeIndex } from "../../server/hub/subscribers.ts";
import { NoteOperations } from "../../server/notes/operations.ts";
import { PluginLifecycle } from "../../server/plugins/lifecycle.ts";
import type { PluginRuntime } from "../../server/plugins/runtime.ts";
import { fixtureApiOrigin } from "./plugin_fixture.ts";
import { FileSystemNotes } from "../../server/notes/file_system.ts";
import type { PluginManager } from "../../server/plugins/manager.ts";
import { Fts5Indexer } from "../../server/search/fts5.ts";
import { initState } from "../../server/state.ts";

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
  Deno.env.set("GLOBNOTES_PATH", vault);
  Deno.env.set("GLOBNOTES_AUTH_TYPE", "none");
  const config = new GlobalConfig();
  const notes = new FileSystemNotes(vault, probes);
  const indexer = new Fts5Indexer(vault);
  const files = new FileServing(vault);
  initState(config, null, notes, indexer, files, plugins);
  const hub = new VaultHub(vault, config.statePath);
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
export async function awaitIndexReady(
  indexer: Fts5Indexer,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = indexer.indexStatus;
    if (!s.syncing && !s.initial) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("index sync did not complete in time");
}
