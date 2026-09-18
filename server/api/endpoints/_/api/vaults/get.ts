// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/vaults — public list of Public + Private vaults. */

import { json } from "@pathfinder/pathfinder";
import { brandBlock } from "@server/brand.ts";
import { isNamespaced, registry } from "@server/vault.ts";

export const auth = false;

export default function () {
  if (!isNamespaced()) {
    return json([]);
  }
  const listed = [];
  for (const vault of registry.values()) {
    const access = vault.config.storedConfig?.access ?? "public";
    if (access === "hidden" || access === "secret") continue;
    listed.push({
      slug: vault.slug,
      brand: brandBlock(vault.config),
      access,
    });
  }
  return json(listed);
}
