// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { settingsWriteGuard } from "../../auth/middleware.ts";
import { processClock } from "../../observed_time.ts";
import { PluginContractError } from "../../plugins/contracts.ts";
import { OperationError, toOperationResponse } from "../../plugins/errors.ts";
import { state } from "../../state.ts";
import { PeerRevisionConflict } from "./peers.ts";
import type { DriverSupervisor } from "./supervisor.ts";

/** All instance controls capture authority before acquiring a bounded body. */
export async function driverControl(
  request: PathfinderRequest,
  effect: (
    owner: DriverSupervisor,
    body: unknown,
    guard: () => void,
  ) => Promise<unknown>,
): Promise<Response> {
  try {
    const guard = await settingsWriteGuard(request._raw);
    const owner = state.drivers;
    if (!owner) throw new HttpError(503, "Sync is unavailable");
    const body = await readBody(request._raw);
    return Response.json(
      await effect(owner, body, () => {
        guard();
        if (state.drivers !== owner) throw new PeerRevisionConflict();
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof OperationError) {
      const response = toOperationResponse(error);
      response.headers.set("cache-control", "no-store");
      return response;
    }
    if (
      error instanceof PeerRevisionConflict ||
      error instanceof PluginContractError
    ) {
      return Response.json({ code: error.code, detail: error.message }, {
        status: error.status,
        headers: { "cache-control": "no-store" },
      });
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new HttpError(400, "Invalid sync controls", {
        "Cache-Control": "no-store",
      });
    }
    if (error instanceof HttpError) {
      error.headers = { ...error.headers, "Cache-Control": "no-store" };
    }
    throw error;
  }
}
async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Sync controls require JSON");
  const expired = Promise.withResolvers<never>();
  const cancel = processClock.deadline(30_000, () => {
    expired.reject(new HttpError(408, "Sync controls timed out"));
    reader.cancel().catch(() => undefined);
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        expired.promise,
      ]);
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        reader.cancel().catch(() => undefined);
        throw new HttpError(413, "Sync controls exceed 1 MiB");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    cancel();
    reader.releaseLock();
  }
}
