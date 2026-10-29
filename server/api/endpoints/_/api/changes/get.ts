// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import { enforceAuthMetadata } from "@server/auth/middleware.ts";
import { browserChange } from "@server/hub/browser_changes.ts";
import type { ChangeEntry } from "@server/hub/types.ts";
import { state } from "@server/state.ts";

const encoder = new TextEncoder();
const frame = (event: string, data: unknown, id?: number) =>
  encoder.encode(
    `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${
      JSON.stringify(data)
    }\n\n`,
  );

export default async function (request: PathfinderRequest) {
  const auth = state.auth,
    lifecycle = state.lifecycle!,
    epoch = lifecycle.epoch;
  const admitted = await enforceAuthMetadata(request._raw);
  const hub = state.hub;
  if (!hub) throw new HttpError(503, "Vault changes unavailable");
  const rawCursor = request.query.get("since") ??
    request._raw.headers.get("last-event-id") ?? "0";
  const cursor = Number(rawCursor);
  if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, "Invalid change cursor");
  }
  const root = state.notes.storagePath,
    stateRoot = Deno.realPathSync(state.config.statePath);
  const project = (entries: ChangeEntry[]) =>
    entries.map((e) => browserChange(e, root, stateRoot)).filter((e) =>
      e !== null
    );
  const snapshot = hub.changesSince(cursor), next = hub.sequence();
  // Persisted deletions have no plaintext path. Replay must invalidate the
  // consumer snapshot rather than pretending these anonymous entries are absent.
  const gap = snapshot.gap || cursor > next ||
    snapshot.entries.some((e) =>
      e.path === null || (e.kind === "renamed" && e.oldPath === null)
    );
  if (
    request.query.get("poll") === "1" ||
    !request._raw.headers.get("accept")?.includes("text/event-stream")
  ) {
    return new Response(
      JSON.stringify(
        gap
          ? { gap: true, next }
          : { entries: project(snapshot.entries), next },
      ),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    );
  }
  let closed = false, cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch { /* disconnected */ }
      };
      let emission = Promise.resolve();
      const emit = (entries?: ChangeEntry[], reset?: number) => {
        emission = emission.then(async () => {
          if (closed) return;
          try {
            await enforceAuthMetadata(request._raw);
            if (closed) return;
            if (state.auth !== auth || lifecycle.epoch !== epoch) {
              close();
              return;
            }
            if (reset !== undefined) {
              controller.enqueue(frame("reset", { next: reset }, reset));
            } else if (entries) {
              for (const entry of project(entries)) {
                controller.enqueue(frame("change", entry, entry.seq));
              }
            } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            close();
          }
        });
      };
      const unsubscribe = hub.subscribe((entries) => emit(entries));
      const unpolicy = lifecycle.subscribeInvalidation(() => {
        if (lifecycle.epoch !== epoch) close();
      });
      const heartbeat = setInterval(() => emit(), 25_000);
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const expire = () => {
        if (closed || admitted.expiresAt === null) return;
        const remaining = admitted.expiresAt - Date.now();
        if (remaining <= 0) close();
        else expiry = setTimeout(expire, Math.min(remaining, 2147483647));
      };
      const aborted = () => close();
      cleanup = () => {
        unsubscribe();
        unpolicy();
        clearInterval(heartbeat);
        clearTimeout(expiry);
        request._raw.signal.removeEventListener("abort", aborted);
      };
      request._raw.signal.addEventListener("abort", aborted, { once: true });
      if (
        request._raw.signal.aborted || lifecycle.epoch !== epoch ||
        state.auth !== auth
      ) close();
      else {
        expire();
        if (gap) emit(undefined, next);
        else emit(snapshot.entries);
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
