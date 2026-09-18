// SPDX-License-Identifier: LGPL-3.0-only

/** Parse GLOBNOTES_PATH + GLOBNOTES_VAULTS into vault specs. */

export interface VaultSpec {
  slug: string;
  root: string;
}

export class VaultEnvError extends Error {}

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const RESERVED = new Set(["_"]);

export function parseVaultList(raw: string): VaultSpec[] {
  const specs: VaultSpec[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const colon = item.indexOf(":");
    if (colon <= 0 || colon === item.length - 1) {
      throw new VaultEnvError(
        `Invalid GLOBNOTES_VAULTS entry '${item}'. Expected slug:root.`,
      );
    }
    const slug = item.slice(0, colon);
    const root = item.slice(colon + 1);
    if (!SLUG_RE.test(slug)) {
      throw new VaultEnvError(
        `Invalid vault slug '${slug}'. Must match [a-z][a-z0-9_]*.`,
      );
    }
    if (RESERVED.has(slug) || slug === "globnotes") {
      throw new VaultEnvError(
        `Reserved vault slug '${slug}'.`,
      );
    }
    if (seen.has(slug)) {
      throw new VaultEnvError(`Duplicate vault slug '${slug}'.`);
    }
    seen.add(slug);
    specs.push({ slug, root });
  }
  if (specs.length === 0) {
    throw new VaultEnvError("GLOBNOTES_VAULTS is empty.");
  }
  return specs;
}

export function bootSpecs(opts: {
  path?: string;
  vaults?: string;
}): VaultSpec[] {
  const path = opts.path?.trim() ?? "";
  const vaults = opts.vaults?.trim() ?? "";
  if (!vaults) {
    if (!path) {
      throw new VaultEnvError(
        "GLOBNOTES_PATH is required when GLOBNOTES_VAULTS is unset.",
      );
    }
    return [{ slug: "", root: path }];
  }
  const named = parseVaultList(vaults);
  const specs: VaultSpec[] = [];
  if (path) specs.push({ slug: "globnotes", root: path });
  specs.push(...named);
  return specs;
}

/** Relative prefixes of VAULTS roots that sit inside PATH (the globnotes vault). */
export function childExcludePrefixes(
  pathRoot: string,
  specs: VaultSpec[],
): string[] {
  const prefixes: string[] = [];
  const parent = normalizeRoot(pathRoot);
  for (const spec of specs) {
    if (spec.slug === "globnotes" || spec.slug === "") continue;
    const child = normalizeRoot(spec.root);
    if (child === parent) continue;
    if (child.startsWith(parent + "/")) {
      prefixes.push(child.slice(parent.length + 1));
    }
  }
  return prefixes;
}

function normalizeRoot(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s.startsWith("/") ? s : s;
}
