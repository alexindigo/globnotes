// SPDX-License-Identifier: LGPL-3.0-only

/** POST /_/api/setup/totp-enrolment — mint a TOTP key for the first-run
 * setup wizard. Public by design (the setup endpoints are), but only
 * while setup is pending. Stateless: nothing is stored server-side; the
 * wizard shows the bundle and the code entered at submit proves the user
 * recorded the key. */

import { HttpError } from "@pathfinder/pathfinder";
import { totpEnrolment } from "@server/auth/totp_enrolment.ts";
import { state } from "@server/state.ts";

export const auth = false;

export default async function (
  request,
): Promise<Record<string, string>> {
  if (!state.config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  const data = (await request.body.json().catch(() => ({}))) as {
    username?: string;
  };
  const username = (data.username ?? "").trim() || "globnotes";

  const bundle = await totpEnrolment(username);
  if (!state.config.setupRequired) {
    throw new HttpError(409, "Setup has already been completed.");
  }
  return bundle;
}
