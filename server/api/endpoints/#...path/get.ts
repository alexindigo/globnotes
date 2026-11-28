// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { activeAuth } from "@server/auth/middleware.ts";
import { createIdentityCatchAll } from "@server/catchall.ts";
import { state } from "@server/state.ts";
export { createIdentityCatchAll } from "@server/catchall.ts";
export const operation = "shellOrFile";
export default (request: PathfinderRequest) =>
  createIdentityCatchAll(activeAuth(), state.files)(request);
