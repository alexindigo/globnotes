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

export interface RecordPublicationOptions {
  createNew?: boolean;
  signal?: AbortSignal;
  /** Synchronous notification at the successful rename/link, before cleanup. */
  onCommit?: () => void;
}

/** The record is committed; callers must not roll back their committed state. */
export class RecordPostCommitError extends Error {
  readonly committed = true;
  constructor(readonly path: string, cause: unknown) {
    super("Record committed but post-commit work failed", { cause });
    this.name = "RecordPostCommitError";
  }
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
  options: RecordPublicationOptions,
  io: RecordIO,
): void | Promise<void> {
  // One publication retains its decision and IO ports across asynchronous stages.
  options = {
    createNew: options.createNew,
    signal: options.signal,
    onCommit: options.onCommit,
  };
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
  const committed = (): void | Promise<void> => {
    const failures: unknown[] = [];
    try {
      options.onCommit?.();
    } catch (error) {
      failures.push(error);
    }
    const finish = () => {
      if (failures.length) {
        throw new RecordPostCommitError(
          path,
          failures.length === 1 ? failures[0] : new AggregateError(
            failures,
            "Record commit notification and staging cleanup failed",
          ),
        );
      }
    };
    let removing: void | Promise<void>;
    try {
      removing = cleanup();
    } catch (error) {
      failures.push(error);
      return finish();
    }
    if (removing instanceof Promise) {
      return removing.then(finish, (error) => {
        failures.push(error);
        finish();
      });
    }
    return finish();
  };
  let renaming: void | Promise<void>;
  // No candidate belongs to this publication until the write is attempted.
  // Capability/identifier capture can itself retire an initially live signal.
  options.signal?.throwIfAborted();
  try {
    const writing = completion(io.write(temporary, content, options.signal));
    if (writing instanceof Promise) {
      return writing.then(commit).then(committed, failed);
    }
    renaming = commit();
  } catch (error) {
    return failed(error);
  }
  if (renaming instanceof Promise) return renaming.then(committed, failed);
  return committed();
}
