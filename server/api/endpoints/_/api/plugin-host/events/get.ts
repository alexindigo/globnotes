// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { createIdentityPluginEvents } from "@server/plugins/identity_events.ts";
import { state } from "@server/state.ts";
export const operation = "readVault";
export default (request: PathfinderRequest) =>
  createIdentityPluginEvents(state.identity!.composition.streamAccess)(request);
