// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "manageVault";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import { readRequestJson } from "@server/auth/request_json.ts";
import { pendingTotpEnrollments } from "@server/auth/totp_enrolment.ts";
import { state } from "@server/state.ts";
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  const config = state.config, username = state.auth?.username ?? "globnotes";
  const body = await readRequestJson(request.body, { allowEmpty: true });
  const data = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  guard();
  const bundle = await pendingTotpEnrollments(config).issue(
    "access",
    typeof data.username === "string" ? data.username : username,
  );
  try {
    guard();
    return bundle;
  } catch (error) {
    await pendingTotpEnrollments(config).discard("access", bundle.key);
    throw error;
  }
}
