// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";

/** A definite rejection of the login intent, not a stale vault baseline.
 * Never echo the login or distinguish the underlying lookup conditions. */
export class AccessLoginConflict extends HttpError {
  constructor() {
    super(409, "The login could not be added to this vault.");
  }

  response(): Response {
    return Response.json(
      { code: "access_login_conflict", detail: this.detail },
      {
        status: this.status,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
