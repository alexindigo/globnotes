// SPDX-License-Identifier: LGPL-3.0-only

import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

/** GET /_/plugins/<id>/app.js — a plugin's browser application-runtime
 * module (manifest runtime.client), served fresh from disk like client.js.
 * Enablement is vault policy: getModule only resolves enabled plugins.
 * `?v=<generation>` query variants are cache-busters only. */
export default function (request: PathfinderRequest) {
  const mod =
    state.plugins?.getModule(String(request.params.id), "application") ??
      null;
  if (mod === null) {
    throw new HttpError(404, "plugin application module not found");
  }
  return new Response(mod, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}
