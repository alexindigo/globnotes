// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Brand file side: the per-vault brand directory
 * (<vault>/.globnotes/brand/), its listing, and the generated web
 * manifest. Name/accent resolution itself lives in GlobalConfig —
 * this module only deals with what's on disk.
 */

import * as path from "@std/path";
import type { GlobalConfig } from "./config.ts";

const DEFAULT_NAME = "globnotes";
const DEFAULT_ACCENT = "#38BDF8";

// Mirrors the icons in client/assets/site.webmanifest (the bundled
// fallback when no custom icon.svg exists).
const BUNDLED_MANIFEST_ICONS = [
  { src: "/_/assets/favicon-16x16.png", sizes: "16x16", type: "image/png" },
  { src: "/_/assets/favicon-32x32.png", sizes: "32x32", type: "image/png" },
  {
    src: "/_/assets/apple-touch-icon.png",
    sizes: "180x180",
    type: "image/png",
  },
];

export function brandDirPath(notesPath: string): string {
  return path.join(notesPath, ".globnotes", "brand");
}

/** Sorted file names in the brand directory, [] when it doesn't exist. */
export function listBrandFiles(notesPath: string): string[] {
  try {
    return [...Deno.readDirSync(brandDirPath(notesPath))]
      .filter((e) => e.isFile)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface BrandBlock {
  name: string | null;
  accent: string | null;
  files: string[];
}

/** The brand state the client needs — same shape from config GET and
 * the brand POST response. */
export function brandBlock(config: GlobalConfig): BrandBlock {
  return {
    name: config.brandName,
    accent: config.brandAccent,
    files: listBrandFiles(config.notesPath),
  };
}

/** The web manifest served at /_/brand/site.webmanifest when the vault
 * has no custom one. Custom icon.svg wins; otherwise the bundled icons
 * (prefixed with the configured path prefix) are advertised. */
export function generateWebManifest(config: GlobalConfig): string {
  const prefix = config.pathPrefix;
  const name = config.brandName ?? DEFAULT_NAME;
  const customIcon = listBrandFiles(config.notesPath).includes("icon.svg");
  const icons = customIcon
    ? [{
      src: `${prefix}/_/brand/icon.svg`,
      sizes: "any",
      type: "image/svg+xml",
    }]
    : BUNDLED_MANIFEST_ICONS.map((icon) => ({
      ...icon,
      src: `${prefix}${icon.src}`,
    }));
  return JSON.stringify({
    name,
    short_name: name,
    start_url: prefix || "/_/",
    display: "standalone",
    background_color: "#0a0e13",
    theme_color: config.brandAccent ?? DEFAULT_ACCENT,
    icons,
  });
}
