// SPDX-License-Identifier: LGPL-3.0-only

/** POST /_/api/setup/totp-enrolment — mint a TOTP key for the first-run
 * setup wizard. Public by design (the setup endpoints are), but only
 * while setup is pending. Only an attempt's service-issued candidate can be
 * confirmed; generating it does not install an active authenticator. */

import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { readRequestJson } from "@server/auth/request_json.ts";
import { pendingTotpEnrollments } from "@server/auth/totp_enrolment.ts";
import { state } from "@server/state.ts";

export const auth = false;

export default async function (
  request: PathfinderRequest,
) {
  const config = state.config;
  if (!config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  const body = await readRequestJson(request.body, { allowEmpty: true });
  const username = body && typeof body === "object" && "username" in body &&
      typeof body.username === "string"
    ? body.username.trim() || "globnotes"
    : "globnotes";

  if (state.config !== config || !config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  const bundle = await pendingTotpEnrollments(config).issue("setup", username);
  if (state.config !== config || !config.setupRequired) {
    await pendingTotpEnrollments(config).discard("setup", bundle.key);
    throw new HttpError(409, "Setup has already been completed.");
  }
  return bundle;
}
