// SPDX-License-Identifier: LGPL-3.0-only

import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

/** GET /_/plugins/<id>/client.js — serves a plugin's editor-half client
 * module fresh from disk (mirrors plugins.css/get.ts: an edit shows
 * without a restart). The browser resolves the module's bare imports via
 * the app's import map. Auth flows through the app-wide middleware. */
export default function (request) {
  const mod = state.plugins?.getClientModule(request.params.id) ?? null;
  if (mod === null) {
    throw new HttpError(404, "plugin client module not found");
  }
  return new Response(mod, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}
