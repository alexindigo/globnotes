// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureScope } from "./fixture_scope.ts";
export interface RecordIO {
  unique(): string;
  write(
    path: string,
    content: string | Uint8Array,
    signal?: AbortSignal,
  ): void | PromiseLike<void>;
  rename(
    from: string,
    to: string,
    signal?: AbortSignal,
  ): void | PromiseLike<void>;
  /** Atomic no-clobber commit. Optional only for legacy replacement-only IO. */
  link?(
    from: string,
    to: string,
    signal?: AbortSignal,
  ): void | PromiseLike<void>;
  remove(path: string): void | PromiseLike<void>;
}
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

/** Capture methods once, including prototype methods and their real receiver. */
export function captureRecordIO(io: RecordIO): RecordIO {
  const { unique, write, rename, link, remove } = io;
  return {
    unique: unique.bind(io),
    write: write.bind(io),
    rename: rename.bind(io),
    ...(link ? { link: link.bind(io) } : {}),
    remove: remove.bind(io),
  };
}

/** Preserve the synchronous native protocol, but capture a JS adapter's then
 * exactly once. No effect may overtake an arbitrary asynchronous completion. */
function completion(
  value: void | PromiseLike<void>,
): Promise<void> | undefined {
  if (value === undefined) return undefined;
  const then = value.then;
  if (typeof then !== "function") {
    throw new TypeError("Invalid record IO completion");
  }
  return Promise.resolve({ then: then.bind(value) });
}
/** Same-directory staging is never a readable record. Native calls stay
 * synchronous so publication precedes SIGSTOP or invocation fulfillment;
 * restricted plugin fixtures provide the same protocol through async IO. */
export function publishRecord(
  path: string,
  content: string | Uint8Array,
  options: { createNew?: boolean; signal?: AbortSignal } = {},
  io: RecordIO = nativeRecordIO,
): void | Promise<void> {
  // One publication retains its decision and IO ports across asynchronous stages.
  options = { createNew: options.createNew, signal: options.signal };
  io = captureRecordIO(io);
  if (options.createNew && !io.link) {
    throw new TypeError("Record IO has no atomic exclusive publication");
  }
  const temporary = `${path}.${io.unique()}.pending`;
  const cleanup = () => completion(io.remove(temporary));
  const commit = () => {
    options.signal?.throwIfAborted();
    return completion(
      options.createNew
        ? io.link!(temporary, path, options.signal)
        : io.rename(temporary, path, options.signal),
    );
  };
  const failed = (primary: unknown): never | Promise<never> => {
    const cleanupFailed = (error: unknown): never => {
      throw new AggregateError(
        [primary, error],
        "Record publication and staging cleanup failed",
        { cause: primary },
      );
    };
    let removing: void | Promise<void>;
    try {
      removing = cleanup();
    } catch (error) {
      return cleanupFailed(error);
    }
    if (removing instanceof Promise) {
      return removing.then(() => {
        throw primary;
      }, cleanupFailed);
    }
    throw primary;
  };
  let renaming: void | Promise<void>;
  try {
    options.signal?.throwIfAborted();
    const writing = completion(io.write(temporary, content, options.signal));
    if (writing instanceof Promise) {
      return writing.then(commit).then(cleanup, failed);
    }
    renaming = commit();
  } catch (error) {
    return failed(error);
  }
  if (renaming instanceof Promise) return renaming.then(cleanup, failed);
  return cleanup();
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
