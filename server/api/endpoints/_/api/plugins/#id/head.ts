// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { headPluginEndpoint } from "@server/plugins/proxy.ts";

export default async function (request: PathfinderRequest) {
  return await headPluginEndpoint(request);
}
