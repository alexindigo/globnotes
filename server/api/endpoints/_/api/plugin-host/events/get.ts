// SPDX-License-Identifier: LGPL-3.0-only
import type { PathfinderRequest } from "@pathfinder/pathfinder";

/** GET /_/api/plugin-host/events — authenticated catalog/settings-revision/
 * status invalidation stream. Authorization is a lifetime property: the
 * current validator is re-run before events and at a heartbeat, expiring
 * tokens close the stream, and policy-epoch changes (setup reset, access
 * mode) close it immediately. A formerly authenticated stream is not a
 * permanent credential — reconnect requires fresh authorization. */

import { enforceAuthMetadata } from "@server/auth/middleware.ts";
import { PLUGIN_LIMITS } from "@server/plugins/contracts.ts";
import { state } from "@server/state.ts";

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default async function (request: PathfinderRequest) {
  const lifecycle = state.lifecycle!;
  const epochAtConnect = lifecycle.epoch;
  const admitted = await enforceAuthMetadata(request._raw);
  // Only IDs/revisions/status — never private data or credentials.
  let closed = false;
  let cleanup: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (reason: string) => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(frame("close", { reason }));
          controller.close();
        } catch { /* already gone */ }
        cleanup();
      };
      let emission = Promise.resolve();
      const pending = new Set<string>();
      const emit = (event: "hello" | "heartbeat" | "invalidate") => {
        if (closed || pending.has(event)) return;
        pending.add(event);
        emission = emission.then(async () => {
          if (closed) return;
          try {
            const auth = state.auth;
            const current = await enforceAuthMetadata(request._raw);
            if (closed) return;
            if (lifecycle.epoch !== epochAtConnect || state.auth !== auth) {
              close("policy-change");
              return;
            }
            if (current.expiresAt !== null && Date.now() >= current.expiresAt) {
              close("unauthorized");
              return;
            }
            controller.enqueue(
              frame(
                event,
                event === "hello"
                  ? {
                    contractVersion: 1,
                    heartbeatMs: PLUGIN_LIMITS.streamHeartbeatMs,
                  }
                  : { at: Date.now() },
              ),
            );
          } catch {
            close("unauthorized");
          } finally {
            pending.delete(event);
          }
        });
      };
      const heartbeat = setInterval(
        () => emit("heartbeat"),
        PLUGIN_LIMITS.streamHeartbeatMs,
      );
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleExpiry = () => {
        if (
          closed || admitted.expiresAt === null ||
          !Number.isFinite(admitted.expiresAt)
        ) return;
        const remaining = admitted.expiresAt - Date.now();
        if (remaining <= 0) {
          close("unauthorized");
          return;
        }
        expiryTimer = setTimeout(
          scheduleExpiry,
          Math.min(remaining, 2147483647),
        );
      };
      const unsubscribe = lifecycle.subscribeInvalidation(() => {
        if (closed) return;
        if (lifecycle.epoch !== epochAtConnect) {
          close("policy-change");
          return;
        }
        emit("invalidate");
      });
      cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(expiryTimer);
        unsubscribe();
      };
      if (lifecycle.epoch !== epochAtConnect) close("policy-change");
      else {
        scheduleExpiry();
        emit("hello");
      }
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
