// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin manager — discovers vault plugins, reads manifests, spawns a
 * PluginHost per plugin, and owns their lifecycle.
 */

import { getEnv } from "../helpers.ts";
import { logger } from "../logger.ts";
import { PluginHost, type RpcHandler } from "./host.ts";
import { discoverPluginDirs, readManifest } from "./manifest.ts";
import { pluginRpc } from "./rpc.ts";

export class PluginManager {
  readonly hosts = new Map<string, PluginHost>();
  private readonly vaultPath: string;
  private readonly workerCount: number;
  private readonly rpc: RpcHandler;

  constructor(
    vaultPath: string,
    rpc: RpcHandler = pluginRpc,
    workerCount?: number,
  ) {
    this.vaultPath = vaultPath;
    this.rpc = rpc;
    this.workerCount = workerCount ??
      Number(getEnv("GLOBNOTES_RENDER_WORKERS", { castInt: true, default: 2 }));
  }

  /** Discover plugins and spawn their workers. A broken plugin logs and
   * is skipped — it must never take the server down. */
  async start(): Promise<void> {
    for (const dir of discoverPluginDirs(this.vaultPath)) {
      try {
        const manifest = readManifest(dir);
        if (this.hosts.has(manifest.id)) {
          logger.warning(
            `duplicate plugin id '${manifest.id}' at ${dir}; skipping`,
          );
          continue;
        }
        const host = new PluginHost(
          manifest,
          this.vaultPath,
          this.rpc,
          this.workerCount,
        );
        await host.start();
        this.hosts.set(manifest.id, host);
        logger.info(
          `plugin '${manifest.id}' loaded (${this.workerCount} workers)`,
        );
      } catch (e) {
        logger.error(
          `plugin at ${dir} failed to load: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }

  async stop(): Promise<void> {
    for (const host of this.hosts.values()) await host.stop();
    this.hosts.clear();
  }

  /** Reinstantiate every plugin (state resets) and fire onSync. */
  async syncAll(): Promise<void> {
    for (const host of this.hosts.values()) {
      await host.respawnAll();
      host.call("onSync", []).catch((e) => {
        logger.error(`plugin '${host.manifest.id}' onSync failed: ${e}`);
      });
    }
  }
}
