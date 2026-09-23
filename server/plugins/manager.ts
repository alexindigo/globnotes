// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Plugin manager — discovers plugins (internal root first, vault
 * overrides by ID), reads manifests, spawns a PluginHost per plugin,
 * and owns their lifecycle. Startup is LAZY: the first render call
 * triggers ensureStarted() so boot cost stays zero for vaults that
 * never render.
 */

import * as path from "@std/path";
import { getEnv } from "../helpers.ts";
import { logger } from "../logger.ts";
import { PluginHost, type RpcHandler } from "./host.ts";
import { discoverPluginDirs, readManifest } from "./manifest.ts";
import { pluginRpc } from "./rpc.ts";

/** Internal (image) plugins root — server/plugins/manager.ts → <repo>/plugins. */
const INTERNAL_PLUGINS_DIR = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "../../plugins",
);

interface PluginsJson {
  order?: string[];
  disabled?: string[];
}

export class PluginManager {
  readonly hosts = new Map<string, PluginHost>();
  private readonly vaultPath: string;
  /** Plugin discovery root + plugins.json live in the state dir;
   * PluginHost permissions keep the vault path (plugins read notes,
   * not state). */
  private readonly statePath: string;
  private readonly workerCount: number;
  private readonly rpc: RpcHandler;
  private startPromise: Promise<void> | null = null;

  constructor(
    vaultPath: string,
    rpc: RpcHandler = pluginRpc,
    workerCount?: number,
    statePath?: string,
  ) {
    this.vaultPath = vaultPath;
    this.statePath = statePath ?? path.join(vaultPath, ".globnotes");
    this.rpc = rpc;
    this.workerCount = workerCount ??
      Number(getEnv("GLOBNOTES_RENDER_WORKERS", { castInt: true, default: 2 }));
  }

  /** Manifest-only listing (no worker spawn) for the settings UI. The
   * `client` flag marks dual-mode plugins (editor-half entry exists on
   * disk — stat-check, like getStyleContents). */
  listPlugins(): {
    id: string;
    name: string;
    version: string;
    client: boolean;
  }[] {
    return this.#orderedManifests().map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      client: this.#hasClientModule(m),
    }));
  }

  /** The plugin's editor-half client module, read fresh from disk each
   * call so an edit shows without a restart. Null when the plugin has no
   * client entry (single-mode) or is unknown. */
  getClientModule(id: string): string | null {
    const manifest = this.#orderedManifests().find((m) => m.id === id);
    if (!manifest) return null;
    const file = path.join(manifest.dir, manifest.clientEntry);
    try {
      if (!Deno.statSync(file).isFile) return null;
      return Deno.readTextFileSync(file);
    } catch {
      return null;
    }
  }

  #hasClientModule(manifest: ReturnType<typeof readManifest>): boolean {
    try {
      return Deno.statSync(
        path.join(manifest.dir, manifest.clientEntry),
      ).isFile;
    } catch {
      return false;
    }
  }

  /** Stylesheets shipped by enabled plugins (Obsidian-style `styles.css`):
   * read fresh from disk each call so an edit shows without a restart. */
  getStyleContents(): { id: string; css: string }[] {
    const out: { id: string; css: string }[] = [];
    for (const manifest of this.#orderedManifests()) {
      const file = path.join(manifest.dir, "styles.css");
      try {
        if (Deno.statSync(file).isFile) {
          out.push({ id: manifest.id, css: Deno.readTextFileSync(file) });
        }
      } catch {
        // No styles.css for this plugin — Obsidian's "delete it if unneeded".
      }
    }
    return out;
  }

  /** Enabled plugin manifests in order: internal root first, vault plugins
   * override by ID, then <vault>/.globnotes/plugins.json order/disabled. */
  #orderedManifests(): ReturnType<typeof readManifest>[] {
    const manifests = new Map<string, ReturnType<typeof readManifest>>();
    for (
      const root of [
        INTERNAL_PLUGINS_DIR,
        path.join(this.statePath, "plugins"),
      ]
    ) {
      for (const dir of discoverPluginDirs(root)) {
        try {
          const manifest = readManifest(dir);
          manifests.set(manifest.id, manifest);
        } catch (e) {
          logger.error(
            `plugin at ${dir} failed to load: ${
              e instanceof Error ? e.message : e
            }`,
          );
        }
      }
    }
    return this.#applyPluginsJson([...manifests.values()]);
  }

  /** Idempotent lazy start — the render pipeline calls this before the
   * first dispatch. */
  ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start();
    return this.startPromise;
  }

  /** Discover plugins and spawn their workers. A broken plugin logs and
   * is skipped — it must never take the server down. */
  async start(): Promise<void> {
    // Internal root first; vault plugins override by ID.
    for (const manifest of this.#orderedManifests()) {
      if (this.hosts.has(manifest.id)) continue;
      try {
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
          `plugin '${manifest.id}' failed to start: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }

  stop(): void {
    for (const host of this.hosts.values()) host.stop();
    this.hosts.clear();
    this.startPromise = null;
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

  /** <state dir>/plugins.json: { order, disabled } — listed ids
   * first (in listed order), the rest keep discovery order; disabled
   * ids are dropped. */
  #applyPluginsJson(
    manifests: ReturnType<typeof readManifest>[],
  ): ReturnType<typeof readManifest>[] {
    let cfg: PluginsJson = {};
    try {
      cfg = JSON.parse(
        Deno.readTextFileSync(
          path.join(this.statePath, "plugins.json"),
        ),
      ) as PluginsJson;
    } catch {
      // No config — discovery order stands.
    }
    const disabled = new Set(cfg.disabled ?? []);
    const enabled = manifests.filter((m) => !disabled.has(m.id));
    if (!cfg.order?.length) return enabled;
    const byId = new Map(enabled.map((m) => [m.id, m]));
    const head = cfg.order
      .map((id) => byId.get(id))
      .filter((m): m is NonNullable<typeof m> => m !== undefined);
    const headIds = new Set(head.map((m) => m.id));
    return [...head, ...enabled.filter((m) => !headIds.has(m.id))];
  }
}
