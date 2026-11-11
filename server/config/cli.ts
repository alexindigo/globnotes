// SPDX-License-Identifier: LGPL-3.0-only
/** Nonsecret, shell-quoted launch projection. Never exported as app env leaves. */
import { loadInstanceConfig } from "./loader.ts";
import { singleVaultBindings, singleVaultSettings } from "./single_vault.ts";
import { pluginSettings } from "./consumers.ts";
import { snapshotEnvironment } from "../environment.ts";
import { GlobalConfig } from "../config.ts";
import { PluginManager } from "../plugins/manager.ts";
import { readAppVersion } from "../version.ts";

export function launchProjection(env: Record<string, string>, prepare = false) {
  readAppVersion({ env: { get: (key) => env[key] } });
  const loaded = loadInstanceConfig({ env, vaults: singleVaultBindings });
  const resolved = singleVaultSettings(loaded, env);
  new GlobalConfig(resolved);
  new PluginManager(
    resolved.notesPath,
    undefined,
    undefined,
    resolved.statePath,
    {
      settings: pluginSettings(
        resolved.instance,
        resolved.vault.capture().resolved,
      ),
    },
  ).validateConfiguration();
  if (prepare) resolved.vault.prepareParents();
  return {
    LAUNCH_NOTES: resolved.notesPath,
    LAUNCH_VAULT_METADATA: resolved.statePath,
    LAUNCH_INSTANCE_METADATA: resolved.instancePath,
    LAUNCH_HOST: resolved.instance.server.host,
    LAUNCH_PORT: String(resolved.instance.server.port),
    LAUNCH_PREFIX: resolved.instance.server.pathprefix,
    LAUNCH_HEALTH_HOST: resolved.instance.server.allowedhosts[0] ?? "",
  };
}
if (import.meta.main) {
  try {
    if (
      Deno.args.length !== 1 ||
      !["--shell", "--prepare-shell"].includes(Deno.args[0])
    ) {
      throw new Error("Expected --shell.");
    }
    for (
      const [key, value] of Object.entries(
        launchProjection(
          snapshotEnvironment(),
          Deno.args[0] === "--prepare-shell",
        ),
      )
    ) console.log(`${key}='${value.replaceAll("'", "'\\''")}'`);
  } catch (error) {
    console.error((error as Error).message);
    Deno.exit(1);
  }
}
