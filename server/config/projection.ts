// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import type { GlobalConfig } from "../config.ts";

/** A target is not an identity; no first-entry or unsupported-vault fallback. */
export function assertVaultTarget(
  config: GlobalConfig,
  request?: Pick<PathfinderRequest, "query">,
): void {
  const target = request?.query?.get("vault");
  if (
    target !== null && target !== undefined &&
    target !== (config.resolved?.vault.name ?? "globnotes")
  ) {
    throw new HttpError(400, "Unsupported vault target.");
  }
}

/** Public provenance contains origin classes only, never paths, bytes or plugin values. */
export function brandFields(config: GlobalConfig) {
  if (!config.resolved) return undefined;
  return Object.fromEntries(["name", "accent"].map((key) => {
    const origin = config.resolved!.vault.provenance[`brand.${key}`];
    return [key, {
      source: origin.layer === "env"
        ? "environment"
        : origin.layer === "defaults"
        ? "default"
        : "toml",
      readonly: origin.layer === "env",
    }];
  }));
}
export function publicProvenance(config: GlobalConfig) {
  if (!config.resolved) return undefined;
  return Object.fromEntries(
    Object.entries(config.resolved.vault.provenance)
      .filter(([key]) => !key.startsWith("plugins."))
      .map((
        [key, origin],
      ) => [key, { layer: origin.layer, pinned: origin.layer === "env" }]),
  );
}
