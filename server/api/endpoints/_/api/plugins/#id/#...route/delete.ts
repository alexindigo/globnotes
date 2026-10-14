// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { proxyPluginEndpoint } from "@server/plugins/proxy.ts";
import { PLUGIN_LIMITS } from "@server/plugins/contracts.ts";

export const bodyLimit = PLUGIN_LIMITS.httpBytes;

export default async function (request: PathfinderRequest) {
  return await proxyPluginEndpoint(request);
}
