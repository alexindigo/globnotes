// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "manageVault";

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
import { StoredConfigConflict } from "@server/config.ts";
import { assertVaultTarget } from "@server/config/projection.ts";
import { HttpError } from "@pathfinder/pathfinder";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import type { Context, PathfinderRequest } from "@pathfinder/pathfinder";
import { committedWithPrivateJson } from "@server/auth/http_policy.ts";

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

export default async function (request: PathfinderRequest, context?: Context) {
  assertVaultTarget(state.config, request);
  const guard = await settingsWriteGuard(request._raw);
  const config = state.config;
  const vaultSnapshot = config.resolved.vault.capture();
  const form = await request.body.form();
  const checkPins = () => {
    for (const key of ["name", "accent"]) {
      if (
        form.has(key) &&
        config.resolved.vault.provenance[`brand.${key}`]?.layer === "env"
      ) {
        throw new HttpError(409, `${key} is pinned by server configuration.`);
      }
    }
  };
  checkPins();

  const name = form.get("name");
  const accent = form.get("accent");
  if (accent !== null && accent !== "" && !ACCENT_RE.test(String(accent))) {
    throw new HttpError(400, "accent must be a #rrggbb hex color");
  }
  const brand = {
    ...(name !== null ? { name: String(name) } : {}),
    ...(accent !== null ? { accent: String(accent) } : {}),
  };

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
    }
    const remove = form.get(`remove${slot === "logo" ? "Logo" : "Icon"}`);
    if (remove !== null && String(remove) !== "") {
      removals.push(slot);
    }
  }

  const commit = () => {
    guard();
    if (state.config !== config) {
      throw new HttpError(
        409,
        "Configuration changed externally; branding choices retained.",
      );
    }
    checkPins();
    config.resolved.vault.assertUnchanged(vaultSnapshot);
    for (const upload of uploads) {
      Deno.mkdirSync(dir, { recursive: true });
      clearSlotFiles(dir, upload.slot);
      Deno.writeFileSync(
        path.join(dir, `${upload.slot}${upload.ext}`),
        upload.bytes,
      );
    }
    for (const slot of removals) clearSlotFiles(dir, slot);
    if (Object.keys(brand).length) {
      config.resolved.vault.save({ brand }, vaultSnapshot, guard);
    }
    if (Object.keys(brand).length || uploads.length || removals.length) {
      logger.info("Instance branding updated.");
    }
    return brandBlock(config);
  };
  try {
    const fresh = state.lifecycle
      ? await state.lifecycle.gate.run(commit)
      : commit();
    return committedWithPrivateJson(context?.state.identityLease, fresh, {
      committed: true,
    });
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
