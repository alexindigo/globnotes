// SPDX-License-Identifier: LGPL-3.0-only
import { readManifest } from "../../server/plugins/manifest.ts";
import { pluginFixture } from "./plugin_fixture.ts";
import { done, pending, waitUntil } from "./wait.ts";
import {
  pluginOperationsFixture,
  type RpcFault,
} from "./plugin_operations_fixture.ts";

export interface BackupStatus {
  completed: number;
  skipped: number;
  failed: number;
  pendingRecovery: boolean;
  ringCommitted: boolean;
  lastError: { code: string; effect?: string } | null;
  configuration: { retention: number; basePath: string } | null;
}
export type BackupFault = RpcFault;
/** The shipped backup plugin on the real operations stack. */
export async function backupFixture(options: {
  environment?: string;
  fixture?: Awaited<ReturnType<typeof pluginFixture>>;
  fault?: BackupFault;
  variant?: (name: string, text: string) => string;
} = {}) {
  const id = "globnotes-backup",
    source = new URL("../../plugins/globnotes-backup/", import.meta.url);
  const files: Record<string, string> = {};
  for (
    const name of [
      "service.js",
      "backup.js",
      "journal.js",
      "state.js",
      "endpoints/status/get.js",
    ]
  ) {
    const text = await Deno.readTextFile(new URL(name, source));
    files[name] = options.variant?.(name, text) ?? text;
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", source)),
  );
  const b = await pluginOperationsFixture({
    id,
    manifest,
    files,
    environment: options.environment,
    fixture: options.fixture,
    fault: options.fault,
  });
  const { data, dir, runtime } = b;
  return {
    ...b,
    settings: () => data.forPlugin(id).page(readManifest(dir).settings[0]),
    async configure(retention: number, basePath = "") {
      const current = await data.forPlugin(id).page(
        readManifest(dir).settings[0],
      );
      return await data.forPlugin(id).savePage(
        readManifest(dir).settings[0],
        { retention, basePath },
        current.revision,
        current.sourceKey,
      );
    },
    /** Wait for host delivery as well as the plugin's own processing queue. */
    status: () =>
      waitUntil(async () => {
        const status = await runtime.invokeCommand(id, "status", {}) as
          & BackupStatus
          & { pendingJobs: number };
        const delivery = runtime.status(id)?.versioningPending ?? 0;
        return status.pendingJobs === 0 && delivery === 0
          ? done(status)
          : pending({ status, delivery });
      }, { label: "backup queue idle", intervalMs: 5 }) as Promise<
        BackupStatus
      >,
  };
}
