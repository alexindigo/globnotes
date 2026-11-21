// SPDX-License-Identifier: LGPL-3.0-only
/** Portable protocol shared with restricted plugin fixtures. All effects are
 * injected; copying this module preserves its complete dependency boundary. */
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

/** Same-directory staging is never a readable record. The caller supplies every
 * IO capability, including inside a restricted Worker with no native defaults. */
export function publishRecord(
  path: string,
  content: string | Uint8Array,
  options: { createNew?: boolean; signal?: AbortSignal },
  io: RecordIO,
): void | Promise<void> {
  // One publication retains its decision and IO ports across asynchronous stages.
  options = { createNew: options.createNew, signal: options.signal };
  options.signal?.throwIfAborted();
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
  // No candidate belongs to this publication until the write is attempted.
  // Capability/identifier capture can itself retire an initially live signal.
  options.signal?.throwIfAborted();
  try {
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
