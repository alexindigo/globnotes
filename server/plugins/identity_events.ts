// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import type { IdentityStreamAccess } from "../auth/composition.ts";
import { identitySse } from "../auth/identity_sse.ts";
import { PLUGIN_CONTRACT_VERSION, PLUGIN_LIMITS } from "./contracts.ts";

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Readers receive catalog invalidations; settings and drivers are Admin-only. */
export function createIdentityPluginEvents(
  admit: (request: Request) => Promise<IdentityStreamAccess>,
) {
  return async (request: PathfinderRequest): Promise<Response> => {
    const access = await admit(request._raw);
    return identitySse(
      request._raw,
      access,
      ["hello", "catalog", "settings", "drivers"] as const,
      PLUGIN_LIMITS.streamHeartbeatMs,
      () => frame("heartbeat", { at: Date.now() }),
      ({ mark, own }) => {
        mark("hello");
        own(() =>
          access.lifecycle.subscribeInvalidation((domain) => {
            if (domain === "catalog" || access.canManageVault) mark(domain);
          })
        );
        return (domain) =>
          domain === "hello"
            ? frame("hello", {
              contractVersion: PLUGIN_CONTRACT_VERSION,
              heartbeatMs: PLUGIN_LIMITS.streamHeartbeatMs,
            })
            : frame("invalidate", { at: Date.now(), domain });
      },
    );
  };
}
