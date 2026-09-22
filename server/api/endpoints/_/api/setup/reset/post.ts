// SPDX-License-Identifier: LGPL-3.0-only

/**
 * POST /_/api/setup/reset — re-arm first-run setup so the wizard can be
 * re-run from the menu. Auth-required by default (only authorized callers
 * may wipe the auth config). Refuses when the mode is env-pinned, and is a
 * no-op when setup is already pending.
 */

import { HttpError } from "@pathfinder/pathfinder";
import { getEnv } from "@server/helpers.ts";
import { logger } from "@server/logger.ts";
import { state } from "@server/state.ts";

export default function (): { setupRequired: boolean } {
  if (getEnv("GLOBNOTES_AUTH_TYPE")) {
    throw new HttpError(
      409,
      "Access mode is pinned by GLOBNOTES_AUTH_TYPE; reset via env instead.",
    );
  }
  const config = state.config;
  if (config.setupRequired) {
    return { setupRequired: true };
  }
  try {
    Deno.removeSync(config.configPath);
  } catch {
    // Already gone — nothing to wipe.
  }
  config.storedConfig = null;
  config.authType = null;
  config.setupRequired = true;
  state.auth = null;
  logger.warning("Access mode reset — first-run setup is required again.");
  return { setupRequired: true };
}