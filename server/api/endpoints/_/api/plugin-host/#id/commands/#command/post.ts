// SPDX-License-Identifier: LGPL-3.0-only
// A command can perform effects without returning a mutation receipt. Only
// dedicated read surfaces, not arbitrary Worker callbacks, admit View.
export const operation = "editNotes";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { state } from "@server/state.ts";
import {
  activeAuth,
  type createInstanceAuth,
} from "@server/auth/middleware.ts";
import type { PluginRuntime } from "@server/plugins/runtime.ts";
import { deliverAdmissionRefusals } from "@server/auth/admission_refusal.ts";
import { outcomeWithPrivateJson } from "@server/auth/http_policy.ts";
import {
  OperationError,
  PluginCommandNotFound,
} from "@server/plugins/errors.ts";
import { readRequestJson } from "@server/auth/request_json.ts";

const unknownOutcome = Object.freeze({
  code: "plugin_outcome_unknown",
  detail: "The plugin callback was dispatched; its outcome is unknown.",
});

export function createIdentityPluginCommand(
  auth: ReturnType<typeof createInstanceAuth>,
  runtime: PluginRuntime,
) {
  return deliverAdmissionRefusals(async (request: PathfinderRequest) => {
    const lease = await auth.lease(request._raw, operation);
    lease.assertCurrent();
    const id = String(request.params.id);
    if (!runtime.isEnabled(id)) throw new HttpError(404, "Not Found");
    const payload = await readRequestJson(request.body, { allowEmpty: true });
    lease.assertCurrent();
    let dispatched = false;
    try {
      const result = await runtime.invokeCommand(
        id,
        String(request.params.command),
        payload,
        lease.viewer,
        {
          assertCurrent: lease.assertCurrent,
          posted: () => {
            dispatched = true;
          },
        },
      );
      const projection = { result };
      lease.prepare(projection);
      return outcomeWithPrivateJson(lease, projection, unknownOutcome);
    } catch (error) {
      if (dispatched) {
        // Authority can disappear before the middleware runs or during body
        // delivery. Neither case proves that the callback had no effects.
        return outcomeWithPrivateJson(
          lease,
          { detail: "plugin command failed" },
          unknownOutcome,
          { status: 500 },
        );
      }
      if (error instanceof HttpError || error instanceof OperationError) {
        throw error;
      }
      if (error instanceof PluginCommandNotFound) {
        throw new HttpError(404, "Not Found");
      }
      throw new HttpError(500, "plugin command failed");
    }
  });
}

/** POST /_/api/plugin-host/<id>/commands/<command> — invoke a registered
 * server command; the result is the command's actual return value. */
export default function (request: PathfinderRequest) {
  const runtime = state.plugins?.runtime;
  if (!runtime) throw new HttpError(404, "Not Found");
  return createIdentityPluginCommand(activeAuth(), runtime)(request);
}
