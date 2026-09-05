// SPDX-License-Identifier: LGPL-3.0-only

import { json } from "@pathfinder/pathfinder";

/** GET /_/api/auth-check — returns "OK" if the request is authenticated.
 * Authenticated route: the middleware does the work. */

export default function (): string {
  return json("OK");
}
