// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import {
  PLUGIN_LIMITS,
  PluginContractError,
} from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";
import { settingsWriteGuard } from "@server/auth/middleware.ts";

/** Bounded JSON admission shared by the two permission control mutations. */
export async function readPermissionBody(
  request: PathfinderRequest,
): Promise<unknown> {
  const reader = request._raw.body?.getReader();
  if (!reader) {
    throw new PluginContractError(
      422,
      "invalid_permission_controls",
      "permission controls require JSON",
    );
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > PLUGIN_LIMITS.controlBytes) {
        await reader.cancel();
        throw new PluginContractError(
          413,
          "permission_payload_too_large",
          "permission controls exceed 1 MiB",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PluginContractError(
      422,
      "invalid_permission_controls",
      "permission controls must be valid JSON",
    );
  }
}
export default async function (request: PathfinderRequest) {
  const guard = await settingsWriteGuard(request._raw);
  try {
    return await state.pluginNetwork!.controls(
      String(request.params.id),
      await readPermissionBody(request),
      undefined,
      guard,
    );
  } catch (error) {
    if (error instanceof PluginContractError) {
      return Response.json({ detail: error.message, code: error.code }, {
        status: error.status,
      });
    }
    throw error;
  }
}
