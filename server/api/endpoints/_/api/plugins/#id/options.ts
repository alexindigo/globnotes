// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { optionsPluginEndpoint } from "@server/plugins/proxy.ts";

export default function (request: PathfinderRequest) {
  return optionsPluginEndpoint(request);
}
