// SPDX-License-Identifier: LGPL-3.0-only
import {
  createOwnershipScope,
  type OwnershipRelease,
} from "../shared/ownership.js";

/** Prepared transport wrapper. Install outside Host/prefix/MCP admission at the
 * one production switch. Its source reader is independent of handler clones;
 * refusal cancels that source without draining or prefetching an upload. As in
 * G3's stream owner, cancellation is best effort: an uncooperative source or
 * its cancellation rejection cannot replace or retain the routing outcome. */
export function withRequestBodyLifetime<Info>(
  handle: (request: Request, info: Info) => Response | PromiseLike<Response>,
) {
  return async (original: Request, info: Info): Promise<Response> => {
    const source = original.body;
    if (!source) return await handle(original, info);
    const custody = createOwnershipScope();
    let finished = false;
    let reason: unknown;
    let closing: Promise<OwnershipRelease> | undefined;
    const reader = (await custody.acquire(
      () => source.getReader(),
      (reader) => {
        if (finished) return;
        finished = true;
        try {
          reader.cancel(reason).catch(() => {});
        } finally {
          reader.releaseLock();
        }
      },
    )).value;
    const close = (value?: unknown) => {
      if (!closing) {
        reason = value;
        closing = custody.releaseAll();
      }
      return closing;
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (finished) controller.close();
          else if (next.done) {
            finished = true;
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        (await close(reason)).throwIfFailed();
      },
    }, { highWaterMark: 0 });
    try {
      const response = await handle(new Request(original, { body }), info);
      (await close()).throwIfFailed();
      return response;
    } catch (error) {
      (await close(error)).throwIfFailed(error);
      throw error;
    }
  };
}
