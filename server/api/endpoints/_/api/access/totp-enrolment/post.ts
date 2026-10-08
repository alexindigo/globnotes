// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { settingsWriteGuard } from "@server/auth/middleware.ts";
import { totpEnrolment } from "@server/auth/totp_enrolment.ts";
import { state } from "@server/state.ts";
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  const body = await request.body.json().catch(() => ({}));
  const data = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const bundle = await totpEnrolment(
    typeof data.username === "string"
      ? data.username
      : state.auth?.username ?? "globnotes",
  );
  guard();
  return bundle;
}
