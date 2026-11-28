// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "readVault";

import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";

/** GET /_/api/plugin-host — authoritative catalog: revision, runtime
 * status, capabilities, commands, pages and framework blocking annotations.
 * Private plugin data is never included. */
export default (request: PathfinderRequest) =>
  state.identity!.composition.responses.catalog(request._raw);
