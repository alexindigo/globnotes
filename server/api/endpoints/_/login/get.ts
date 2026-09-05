// SPDX-License-Identifier: LGPL-3.0-only

/** GET /_/login — the app shell (Python's serve_index page routes).
 * Always public; the client handles its own auth flow. */

import { serveIndex } from "@server/catchall.ts";

export const auth = false;

export default () => serveIndex();
