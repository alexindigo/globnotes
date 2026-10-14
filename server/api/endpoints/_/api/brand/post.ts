// SPDX-License-Identifier: LGPL-3.0-only

/**
 * POST /_/api/brand — mutate the instance branding: name, accent, and
 * the logo.svg / icon.svg files. Multipart so the files ride along:
 *   name       — new brand name; empty string clears it
 *   accent     — new accent as #rrggbb; empty string clears it
 *   logo, icon — SVG file uploads, written as logo.svg / icon.svg
 *   removeLogo, removeIcon — truthy removes the file
 * Absent fields are left untouched. Returns the fresh brand block.
 */

import * as path from "@std/path";
import { brandBlock, brandDirPath } from "@server/brand.ts";
import {
  type GlobalConfig,
  type StoredConfig,
  StoredConfigConflict,
  type StoredConfigSnapshot,
} from "@server/config.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const IMAGE_EXTS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
]);

/** Remove every brand file for a slot (logo.* / icon.*), whatever its
 * extension. Missing files are fine — removal is idempotent. */
function clearSlotFiles(dir: string, slot: string): void {
  let entries: string[];
  try {
    entries = [...Deno.readDirSync(dir)].map((e) => e.name);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(`${slot}.`)) {
      try {
        Deno.removeSync(path.join(dir, name));
      } catch {
        // race or already gone
      }
    }
  }
}

/** Merge brand keys into the stored setup config and persist it. The
 * stored config is the single file the setup wizard writes — the merge
 * must preserve its auth keys (and synthesize auth_type when auth comes
 * from env only, so a later env removal doesn't drop the instance back
 * into setup). */
function saveBrandConfig(
  config: GlobalConfig,
  snapshot: StoredConfigSnapshot,
  base: StoredConfig | null,
  changes: Partial<StoredConfig>,
  deletions: string[],
): void {
  const stored: StoredConfig = {
    ...(base ??
      (config.authType ? { auth_type: config.authType } : {})),
    ...changes,
  };
  for (const key of deletions) delete stored[key as keyof StoredConfig];
  config.saveStoredConfig(stored, snapshot);
}

export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  const config = state.config;
  const snapshot = config.captureStoredConfig();
  const base = snapshot.raw === null ? null : JSON.parse(snapshot.raw);
  if (JSON.stringify(base) !== JSON.stringify(config.storedConfig)) {
    throw new HttpError(
      409,
      "Configuration changed externally; branding choices retained.",
    );
  }
  const form = await request.body.form();

  const changes: Partial<StoredConfig> = {};
  const deletions: string[] = [];
  let changed = false;

  const name = form.get("name");
  if (name !== null) {
    const value = String(name);
    if (value === "") deletions.push("brand_name");
    else changes.brand_name = value;
    changed = true;
  }

  const accent = form.get("accent");
  if (accent !== null) {
    const value = String(accent);
    if (value === "") deletions.push("brand_accent");
    else {
      if (!ACCENT_RE.test(value)) {
        throw new HttpError(400, "accent must be a #rrggbb hex color");
      }
      changes.brand_accent = value;
    }
    changed = true;
  }

  const dir = brandDirPath(config.statePath);
  const uploads: { slot: string; ext: string; bytes: Uint8Array }[] = [];
  const removals: string[] = [];
  for (const slot of ["logo", "icon"] as const) {
    const file = form.get(slot);
    if (file instanceof File) {
      const ext = path.extname(file.name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) {
        throw new HttpError(400, `${slot} must be an image file`);
      }
      uploads.push({
        slot,
        ext,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      changed = true;
    }
    const remove = form.get(`remove${slot === "logo" ? "Logo" : "Icon"}`);
    if (remove !== null && String(remove) !== "") {
      removals.push(slot);
      changed = true;
    }
  }

  const commit = () => {
    guard();
    if (
      state.config !== config ||
      JSON.stringify(base) !== JSON.stringify(config.storedConfig)
    ) {
      throw new HttpError(
        409,
        "Configuration changed externally; branding choices retained.",
      );
    }
    config.assertStoredConfigUnchanged(snapshot);
    for (const upload of uploads) {
      Deno.mkdirSync(dir, { recursive: true });
      clearSlotFiles(dir, upload.slot);
      Deno.writeFileSync(
        path.join(dir, `${upload.slot}${upload.ext}`),
        upload.bytes,
      );
    }
    for (const slot of removals) clearSlotFiles(dir, slot);
    if (changed) {
      saveBrandConfig(config, snapshot, base, changes, deletions);
      if (name !== null) config.brandName = String(name) || null;
      if (accent !== null) config.brandAccent = String(accent) || null;
      logger.info("Instance branding updated.");
    }
    return brandBlock(config);
  };
  try {
    return state.lifecycle ? await state.lifecycle.gate.run(commit) : commit();
  } catch (error) {
    if (error instanceof StoredConfigConflict) {
      throw new HttpError(
        409,
        "Configuration changed before branding commit; review current settings.",
      );
    }
    throw error;
  }
}
