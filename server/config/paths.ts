// SPDX-License-Identifier: LGPL-3.0-only
import { join, resolve } from "@std/path";

/** No filesystem inspection, creation, discovery or relocation. */
export function instanceMetadataPath(base: string, metadata: string): string {
  return metadata ? resolve(metadata, "_") : resolve(base, ".globnotes");
}
export function vaultMetadataPath(
  notes: string,
  metadata: string,
  name: string,
): string {
  if (!isVaultName(name)) throw new Error("Invalid vault name");
  return metadata ? resolve(metadata, name) : resolve(notes, ".globnotes");
}
export function vaultConfigPath(
  notes: string,
  metadata: string,
  name: string,
): string {
  return join(vaultMetadataPath(notes, metadata, name), "config.toml");
}
export const isVaultName = (name: string): boolean =>
  /^[a-z][a-z0-9_]*$/.test(name) && name !== "_";
export function escapeVaultName(name: string): string {
  if (!isVaultName(name)) throw new Error("Invalid vault name");
  return name.toUpperCase().replaceAll("_", "__");
}
export function decodeVaultName(encoded: string): string | null {
  const name = encoded.replaceAll("__", "_").toLowerCase();
  return isVaultName(name) && escapeVaultName(name) === encoded ? name : null;
}
