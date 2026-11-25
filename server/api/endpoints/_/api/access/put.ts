// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "manageVault";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { updateAccess } from "@server/auth/access.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import { readRequestJson } from "@server/auth/request_json.ts";
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  return await updateAccess(
    request._raw,
    await readRequestJson(request.body),
    guard,
  );
}
