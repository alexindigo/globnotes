// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Legacy POST /_/api/setup/reset — configured access is now updated in
 * place. Reject without deleting configuration or opening a setup gap.
 * The settings-write gate also prevents public-lock bypass through this URL.
 */

import { HttpError } from "@pathfinder/pathfinder";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

export default async function (
  request: PathfinderRequest,
): Promise<{ setupRequired: boolean }> {
  if (state.config.setupRequired) {
    return { setupRequired: true };
  }
  await settingsWriteGuard(request._raw);
  throw new HttpError(
    409,
    "Configured access is updated in place; reset is unavailable.",
  );
}
