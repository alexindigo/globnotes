// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "editNotes";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

import { HttpError } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import type { VaultAuthorityLease } from "@server/auth/authority.ts";
import type { createInstanceAuth } from "@server/auth/middleware.ts";
import type { PluginRuntime } from "@server/plugins/runtime.ts";
import { createHttpPolicy } from "@server/auth/http_policy.ts";
import { PluginCommandNotFound } from "@server/plugins/errors.ts";

export function createIdentityPluginCommand(
  auth: ReturnType<typeof createInstanceAuth>,
  runtime: PluginRuntime,
) {
  const policy = createHttpPolicy(auth);
  return async (request: PathfinderRequest) => {
    return await policy.json(
      request._raw,
      "readVault",
      (lease) => runCommand(request, runtime, lease),
    );
  };
}

/** POST /_/api/plugin-host/<id>/commands/<command> — invoke a registered
 * server command; the result is the command's actual return value. */
export default async function (request: PathfinderRequest) {
  return Response.json(await runCommand(request, state.plugins?.runtime));
}

async function runCommand(
  request: PathfinderRequest,
  runtime?: PluginRuntime | null,
  lease?: VaultAuthorityLease,
) {
  const id = String(request.params.id);
  if (!runtime?.isEnabled(id)) throw new HttpError(404, "Not Found");
  const payload = await request.body.json().catch(() => ({}));
  try {
    const result = await runtime.invokeCommand(
      id,
      String(request.params.command),
      payload,
      lease?.viewer,
    );
    return { result };
  } catch (error) {
    lease?.assertCurrent();
    if (error instanceof PluginCommandNotFound) {
      throw new HttpError(404, "Not Found");
    }
    throw new HttpError(500, "plugin command failed");
  }
}
