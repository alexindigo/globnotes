// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "session";

import { json, type PathfinderRequest } from "@pathfinder/pathfinder";

/** GET /_/api/auth-check — returns "OK" if the request is authenticated.
 * Authenticated route: the middleware does the work. */

export default function (request: PathfinderRequest): Response {
  // The legacy composition has no account principal or ACL receipt owner.
  if (request.query.has("accessUpdateId")) {
    return Response.json({ detail: "Access receipt unavailable." }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  return json("OK");
}
