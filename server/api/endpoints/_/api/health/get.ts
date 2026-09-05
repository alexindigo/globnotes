// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/api/health — healthcheck. Deliberately unauthenticated,
 * same as the Python server. */

export const auth = false;

import { json } from "@pathfinder/pathfinder";

export default function (): string {
  return json("OK");
}
