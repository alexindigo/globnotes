// SPDX-License-Identifier: LGPL-3.0-only
import { createOwnershipScope } from "../../shared/ownership.js";
import type { IdentityStreamAccess } from "./composition.ts";

/** A connection retains only one marker for each declared signal. Producers
 * never enqueue bytes; a consumer pull selects and serializes at most one
 * frame, and the disclosure lease fences that frame again at delivery. */
export async function identitySse<K extends string>(
  request: Request,
  access: IdentityStreamAccess,
  keys: readonly K[],
  heartbeatMs: number,
  heartbeatFrame: () => Uint8Array,
  setup: (ports: {
    mark(key: K): void;
    own(register: () => () => unknown): void;
  }) => (key: K) => Uint8Array | undefined,
): Promise<Response> {
  const { lease, lifecycle } = access;
  const { signal } = request;
  lease.assertCurrent();
  signal.throwIfAborted();
  const owner = createOwnershipScope();
  const allowed = new Set(keys);
  const heartbeat = Symbol("heartbeat");
  const pending = new Set<K | typeof heartbeat>();
  let wake: (() => void) | undefined;
  const close = () => {
    pending.clear();
    void owner.releaseAll();
    wake?.();
  };
  const mark = (key: K | typeof heartbeat) => {
    if (owner.retired) return;
    pending.add(key);
    wake?.();
  };
  const own = (register: () => () => unknown) => {
    if (owner.retired) return;
    const release = register();
    try {
      owner.defer(release);
    } catch (error) {
      release();
      throw error;
    }
  };
  try {
    own(() => {
      signal.addEventListener("abort", close, { once: true });
      return () => signal.removeEventListener("abort", close);
    });
    const authorityChanged = () => {
      try {
        lease.assertCurrent();
      } catch {
        close();
      }
    };
    own(() => access.subscribe(authorityChanged));
    own(() =>
      lifecycle.subscribeInvalidation(() => {
        if (lifecycle.epoch !== lease.epoch) close();
      })
    );
    const render = setup({
      mark: (key) => {
        if (!allowed.has(key)) throw new TypeError("Unknown SSE signal.");
        mark(key);
      },
      own,
    });
    own(() => {
      const timer = setInterval(() => mark(heartbeat), heartbeatMs);
      return () => clearInterval(timer);
    });
    if (lease.principal.kind === "account") {
      const expiresAt = lease.principal.expiresAt;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const expire = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) close();
        else expiry = setTimeout(expire, Math.min(remaining, 2147483647));
      };
      own(() => () => clearTimeout(expiry));
      if (!owner.retired) expire();
    }
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (!owner.retired) {
            const { value: key, done } = pending.values().next();
            if (done) {
              const work = Promise.withResolvers<void>();
              wake = work.resolve;
              await work.promise;
              wake = undefined;
              continue;
            }
            pending.delete(key);
            lease.assertCurrent();
            const chunk = key === heartbeat ? heartbeatFrame() : render(key);
            if (chunk?.length) {
              controller.enqueue(chunk);
              return;
            }
          }
          if (!cancelled) controller.close();
        } catch (error) {
          close();
          throw error;
        }
      },
      cancel() {
        cancelled = true;
        close();
      },
    }, { highWaterMark: 0 });
    const body = lease.stream(source);
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    close();
    (await owner.releaseAll()).throwIfFailed(error);
    throw error;
  }
}
