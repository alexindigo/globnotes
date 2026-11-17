// SPDX-License-Identifier: LGPL-3.0-only
export interface RecordIO {
  unique(): string;
  write(path: string, content: string | Uint8Array): void | Promise<void>;
  rename(from: string, to: string): void | Promise<void>;
  remove(path: string): void | Promise<void>;
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
  options: { createNew?: boolean } = {},
  io: RecordIO = nativeRecordIO,
): void | Promise<void> {
  if (options.createNew && io === nativeRecordIO) {
    try {
      Deno.lstatSync(path);
      throw new Deno.errors.AlreadyExists(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const temporary = `${path}.${io.unique()}.pending`;
  const cleanup = () => io.remove(temporary);
  try {
    const writing = io.write(temporary, content);
    if (writing instanceof Promise) {
      return writing.then(() => io.rename(temporary, path)).finally(cleanup);
    }
    const renaming = io.rename(temporary, path);
    if (renaming instanceof Promise) return renaming.finally(cleanup);
    cleanup();
  } catch (error) {
    const removing = cleanup();
    if (removing instanceof Promise) {
      return removing.then(() => {
        throw error;
      });
    }
    throw error;
  }
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
) {
  const watcher = Deno.watchFs(directory);
  const observed = (async () => {
    let value = await probe();
    if (value !== null) return value;
    for await (const _event of watcher) {
      value = await probe();
      if (value !== null) return value;
    }
    throw Error(`Record watcher closed before ${label}`);
  })();
  try {
    return await Promise.race([
      observed,
      ...owners.map((owner) =>
        owner.exit.then(async (status) => {
          const value = await probe();
          if (value !== null) return value;
          throw Error(`${owner.label} exited before ${label}: ${status.code}`);
        })
      ),
    ]);
  } finally {
    watcher.close();
  }
}
