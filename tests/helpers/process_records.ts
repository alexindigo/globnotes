// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureScope } from "./fixture_scope.ts";
import {
  publishRecord as publishWithIO,
  type RecordIO,
} from "./record_publication.ts";
export { captureRecordIO, type RecordIO } from "./record_publication.ts";
export const nativeRecordIO: RecordIO = {
  unique: () => crypto.randomUUID(),
  write: (path, content) =>
    Deno.writeFileSync(
      path,
      typeof content === "string" ? new TextEncoder().encode(content) : content,
      { createNew: true },
    ),
  rename: (from, to) => Deno.renameSync(from, to),
  link: (from, to) => Deno.linkSync(from, to),
  remove: (path) => {
    try {
      Deno.removeSync(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
};

/** Same-directory staging is never a readable record. Native calls stay
 * synchronous so publication precedes SIGSTOP or invocation fulfillment;
 * restricted plugin fixtures provide the same protocol through async IO. */
export function publishRecord(
  path: string,
  content: string | Uint8Array,
  options: { createNew?: boolean; signal?: AbortSignal } = {},
  io: RecordIO = nativeRecordIO,
): void | Promise<void> {
  return publishWithIO(path, content, options, io);
}
export function readRecord(path: string): Record<string, unknown> | null {
  try {
    const record = JSON.parse(Deno.readTextFileSync(path));
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw Error(`Invalid process record: ${path}`);
    }
    return record;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export interface ProcessOwner {
  label: string;
  exit: Promise<{ code: number }>;
}

/** A parent-held pipe is an event-driven lifetime, not a PID poll or deadline. */
export function watchOwnerPipe(
  stream: ReadableStream<Uint8Array>,
  label: string,
) {
  const reader = stream.getReader();
  let disposed = false;
  const exit = (async () => {
    try {
      while (
        !(await reader.read()).done
      ) { /* lifetime pipe carries no records */ }
    } finally {
      reader.releaseLock();
    }
    return { code: disposed ? 0 : 1 };
  })();
  exit.catch(() => undefined);
  return {
    label,
    exit,
    async dispose() {
      disposed = true;
      try {
        await reader.cancel();
      } catch { /* already ended */ }
      await exit;
    },
  };
}

export async function waitForRecord<T>(
  directory: string,
  label: string,
  probe: () => T | null | Promise<T | null>,
  owners: readonly ProcessOwner[],
  signal?: AbortSignal,
  watch: (directory: string) => Deno.FsWatcher = Deno.watchFs,
) {
  signal?.throwIfAborted();
  return await fixtureScope(async (scope) => {
    let active = true;
    let exited = false;
    let terminal: T | null = null;
    let inFlight: Promise<T | null> | undefined;
    // LIFO closes the watcher before joining the last read, and attempts every
    // phase even when listener removal or native watcher close rejects.
    scope.defer(() => inFlight?.catch(() => undefined));
    const watcher = (await scope.acquire(() =>
      watch(directory), (watcher) =>
      watcher.close())).value;
    const cancelled = Promise.withResolvers<never>();
    cancelled.promise.catch(() =>
      undefined
    );
    const cancel = () => {
      active = false;
      cancelled.reject(signal?.reason);
    };
    const probeActive = (final = false): Promise<T | null> => {
      signal?.throwIfAborted();
      if (!active) return Promise.reject(Error(`${label} observation closed`));
      if (terminal !== null) return Promise.resolve(terminal);
      if (exited && !final) return Promise.resolve(null);
      if (!inFlight) {
        inFlight = Promise.resolve().then(() => {
          signal?.throwIfAborted();
          if (!active) throw Error(`${label} observation closed`);
          if (exited && !final) return null;
          return probe();
        }).then((value) => {
          if (value !== null) terminal = value;
          return value;
        }).finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    };
    scope.defer(() => signal?.removeEventListener("abort", cancel));
    scope.defer(() => {
      active = false;
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const observed = (async () => {
      let value = await probeActive();
      if (value !== null) return value;
      for await (const _event of watcher) {
        value = await probeActive();
        if (value !== null) return value;
      }
      throw Error(`Record watcher closed before ${label}`);
    })();
    observed.catch(() => undefined);
    return await Promise.race([
      observed,
      cancelled.promise,
      ...owners.map((owner) =>
        owner.exit.then(async (status) => {
          // An in-flight read may have observed absence BEFORE this exit.
          // Join it, retain a positive terminal result, otherwise read anew.
          exited = true;
          if (!active) throw Error(`${label} observation closed`);
          await inFlight;
          const value = await probeActive(true);
          if (value !== null) return value;
          throw Error(`${owner.label} exited before ${label}: ${status.code}`);
        })
      ),
    ]);
  });
}
