// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import {
  ConfigError,
  type InstanceLoadResult,
  type Sources,
  vaultEnvironment,
} from "./loader.ts";
import { instanceMetadataPath, vaultMetadataPath } from "./paths.ts";
import type { InstanceConfig } from "./schema.ts";
import { VaultConfigStore } from "./vault.ts";

export const singleVaultBindings: Sources["vaults"] = (
  instance: InstanceConfig,
): Record<string, { path: string }> => {
  const declared = instance.vaults.entries.globnotes?.path;
  // The loader is still collecting errors, including missing shipped leaves.
  // Do not turn an incomplete baseline into a path-library exception.
  if (typeof declared === "string" && declared) {
    return { globnotes: { path: declared } };
  }
  if (
    typeof instance.vaults.basepath !== "string" || !instance.vaults.basepath
  ) return {};
  return {
    globnotes: { path: resolve(instance.vaults.basepath, "globnotes") },
  };
};
export function singleVaultSettings(
  loaded: InstanceLoadResult,
  env: Record<string, string>,
) {
  const instance = loaded.config, names = Object.keys(instance.vaults.entries);
  if (names.length > 1 || names.length === 1 && names[0] !== "globnotes") {
    throw new ConfigError([
      "config: runtime vault layout requires piece 3; only the sole globnotes vault is supported.",
    ]);
  }
  const notesPath = resolve(
    instance.vaults.entries.globnotes?.path ||
      resolve(instance.vaults.basepath, "globnotes"),
  );
  try {
    if (!Deno.statSync(notesPath).isDirectory) throw new Error();
  } catch {
    throw new ConfigError([
      "config: vaults.globnotes.path: notes directory must already exist.",
    ]);
  }
  const statePath = vaultMetadataPath(
    notesPath,
    instance.metadata.path,
    "globnotes",
  );
  const vault = new VaultConfigStore("globnotes", `${statePath}/config.toml`, {
    env: vaultEnvironment("globnotes", env),
  });
  return {
    instance,
    vault,
    notesPath,
    statePath,
    instancePath: instanceMetadataPath(
      instance.vaults.basepath,
      instance.metadata.path,
    ),
  };
}
