// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "manageVault";

import { state } from "@server/state.ts";

/** GET /_/api/plugins — manifest listing for the settings UI (no worker
 * spawn; enable/disable state lives client-side in localStorage). */
export default function () {
  return state.plugins?.listPlugins() ?? [];
}
