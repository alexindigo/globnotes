// SPDX-License-Identifier: LGPL-3.0-only

import { PluginManager } from "../../server/plugins/manager.ts";
import { testEnvironment } from "./environment.ts";
import type { FixtureEnvironment } from "./environment.ts";
import { pluginSettings } from "../../server/config/consumers.ts";
import { loadInstanceConfig } from "../../server/config/loader.ts";

type Options = NonNullable<ConstructorParameters<typeof PluginManager>[4]> & {
  env?: FixtureEnvironment;
  autoEnable?: boolean;
  environment?: boolean;
};

/** Test-owned manager construction, like the clean child launcher in process.ts.
 * No test falls back to the shared process environment when it omits options. */
export function createPluginManager(
  ...[vault, rpc, workers, state, options]: [
    string,
    ConstructorParameters<typeof PluginManager>[1]?,
    number?,
    string?,
    Options?,
  ]
): PluginManager {
  return new PluginManager(vault, rpc, workers, state, {
    ...options,
    settings: options?.settings ?? (() => {
      const env = options?.env ?? testEnvironment();
      const loaded = loadInstanceConfig({
        env: env.values,
        overlayPath: null,
        vaults: { globnotes: { path: vault, overlayPath: null } },
      });
      const settings = pluginSettings(
        loaded.config,
        loaded.vaults.globnotes,
      );
      return {
        ...settings,
        ...(options?.autoEnable === undefined
          ? {}
          : { autoEnable: options.autoEnable }),
        ...(options?.environment === undefined ? {} : {
          autoEnablePin: {
            value: options.environment,
            source: "environment" as const,
          },
        }),
      };
    })(),
  });
}

/** Failed construction has no returned owner to dispose these resources.
 * Attempt both teardown steps while preserving the caller's setup error. */
export async function cleanupFailedPluginSetup(
  manager?: PluginManager,
  runtime?: ReturnType<PluginManager["configureRuntime"]>,
): Promise<void> {
  try {
    await (runtime ?? manager?.runtime)?.close();
  } catch { /* preserve the setup failure */ }
  try {
    manager?.stop();
  } catch { /* preserve the setup failure */ }
}
