// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "public";

/** GET / — the app shell (Python's serve_index for the root page).
 * Always public; the client handles its own auth flow. */

import { serveIndex } from "@server/catchall.ts";

export default () => serveIndex();
