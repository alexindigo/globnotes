// SPDX-License-Identifier: LGPL-3.0-only
import * as path from "@std/path";
import { type FixtureScope, fixtureScope } from "./fixture_scope.ts";
import { ownFixtureScope } from "./fixture_scope_engine.ts";
import {
  bindPluginFixture,
  type ScopedPluginFixture,
} from "./plugin_fixture_engine.ts";
import {
  captureRecordIO,
  nativeRecordIO,
  type ProcessOwner,
  publishRecord,
  type RecordIO,
  waitForRecord,
} from "./process_records.ts";
export { RecordPostCommitError } from "./process_records.ts";

declare const directoryBrand: unique symbol;
declare const schemaBrand: unique symbol;
export interface RecordDirectory {
  readonly [directoryBrand]: true;
  readonly path: string;
}
export interface RecordSchema<T> {
  readonly [schemaBrand]: T;
  readonly name: string;
}
export interface RecordSnapshot<T> {
  readonly bytes: string;
  readonly value: T;
}
interface DirectoryCustody {
  readonly scope: FixtureScope;
  readonly owner: FixtureScope;
  readonly writable: boolean;
  readonly root?: ScopedPluginFixture;
}
const directories = new WeakMap<RecordDirectory, DirectoryCustody>();
const schemas = new WeakMap<object, (value: unknown) => unknown>();

function leaf(name: string): string {
  if (
    !name || name === "." || name === ".." || name.includes("/") ||
    name.includes("\\")
  ) throw new TypeError("Record name must be a single path component");
  return name;
}
function issueDirectory(
  scope: FixtureScope,
  directory: string,
  writable: boolean,
  owner: FixtureScope = scope,
  root?: ScopedPluginFixture,
): RecordDirectory {
  scope.assertCurrent();
  owner.assertCurrent();
  ownFixtureScope(owner, scope);
  const result = Object.freeze({ path: directory }) as RecordDirectory;
  directories.set(result, { scope, owner, writable, root });
  return result;
}
function directoryState(directory: RecordDirectory) {
  const state = directories.get(directory);
  if (!state) {
    throw new TypeError("Record directory was not issued by its owner");
  }
  state.scope.assertCurrent();
  state.owner.assertCurrent();
  return state;
}

function admit<T>(
  state: DirectoryCustody,
  effect: (signal: AbortSignal) => T | PromiseLike<T>,
) {
  const enter = (rootSignal?: AbortSignal) =>
    state.owner.admit(
      (signal) =>
        effect(rootSignal ? AbortSignal.any([rootSignal, signal]) : signal),
      state.scope,
    );
  // Preserve the inner envelope, never resolve its owned value again.
  return state.root
    ? state.root.admit(enter).then((outer) => outer.value)
    : enter();
}

/** Admission reserves synchronously before invoking IO. Keep that synchronous
 * result for native publication/preload; async IO joins the admitted result.
 * The admission promise still owns/drains the whole async effect on both sides. */
function admittedEffect<T>(
  state: DirectoryCustody,
  effect: (signal: AbortSignal) => T | Promise<T>,
): { readonly value: T | Promise<T>; joined(): Promise<T> } {
  state.scope.assertCurrent();
  state.owner.assertCurrent();
  let outcome: { value: T | Promise<T> } | { error: unknown } | undefined;
  const pending = admit(state, (signal) => {
    try {
      outcome = { value: effect(signal) };
      return outcome.value;
    } catch (error) {
      outcome = { error };
      throw error;
    }
  });
  pending.catch(() => undefined);
  if (!outcome) throw new Error("Record admission did not enter its effect");
  if ("error" in outcome) throw outcome.error;
  return {
    value: outcome.value,
    joined: () => pending.then((handle) => handle.value),
  };
}

/** Borrow an issued capability, retaining its exact owner and root provenance. */
export function borrowRecordDirectory(
  scope: FixtureScope,
  directory: RecordDirectory,
): RecordDirectory {
  const state = directoryState(directory);
  const root = state.root ? bindPluginFixture(scope, state.root) : undefined;
  return issueDirectory(
    scope,
    directory.path,
    state.writable,
    state.owner,
    root,
  );
}

/** Dedicated control root. Existing directories are never adopted or removed. */
export async function ownedRecordDirectory(
  scope: FixtureScope,
  parent: string | ScopedPluginFixture,
  name: string,
  options: { beforeCreate?: (signal: AbortSignal) => void | Promise<void> } =
    {},
): Promise<RecordDirectory> {
  const root = typeof parent === "string"
    ? undefined
    : bindPluginFixture(scope, parent);
  const parentPath = typeof parent === "string" ? parent : root!.statePath;
  const beforeCreate = options.beforeCreate;
  const prepare = async (signal: AbortSignal) => {
    // Contract instrumentation runs inside the same admission, without replacing
    // process-global filesystem state while another owner is preparing.
    if (beforeCreate) await beforeCreate(signal);
    signal.throwIfAborted();
    const mkdir = scope.bind(Deno.mkdir);
    const directory = (await scope.acquire(async () => {
      const directory = path.resolve(parentPath, leaf(name));
      await mkdir(directory);
      return directory;
    }, (directory) => Deno.remove(directory, { recursive: true }))).value;
    return issueDirectory(scope, directory, true, scope, root);
  };
  return (await (root ? root.admit(prepare) : scope.admit(prepare))).value;
}

/** A child shim borrows only read custody; its scope never removes the root. */
export function openRecordDirectory(
  scope: FixtureScope,
  directory: string | RecordDirectory,
): RecordDirectory {
  if (typeof directory !== "string") {
    const borrowed = borrowRecordDirectory(scope, directory),
      state = directoryState(borrowed);
    return issueDirectory(scope, borrowed.path, false, state.owner, state.root);
  }
  const lstat = scope.bind(Deno.lstatSync),
    realPath = scope.bind(Deno.realPathSync);
  const info = lstat(directory);
  if (!info.isDirectory || info.isSymlink) {
    throw new TypeError("Record root is not a directory");
  }
  return issueDirectory(scope, realPath(directory), false);
}

function recordSchema<T>(
  name: string,
  decode: (value: unknown) => T,
): RecordSchema<T> {
  const schema = Object.freeze({ name }) as RecordSchema<T>;
  schemas.set(schema, decode);
  return schema;
}
export function objectRecordSchema<T>(
  name: string,
  decode: (value: Record<string, unknown>) => T,
): RecordSchema<T> {
  return recordSchema(name, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Invalid ${name}: expected object`);
    }
    return decode(value as Record<string, unknown>);
  });
}
export function arrayRecordSchema<T>(
  name: string,
  decode: (value: unknown[]) => T,
): RecordSchema<T> {
  return recordSchema(name, (value) => {
    if (!Array.isArray(value)) {
      throw new TypeError(`Invalid ${name}: expected array`);
    }
    return decode(value);
  });
}
function decoder<T>(schema: RecordSchema<T>) {
  const decode = schemas.get(schema);
  if (!decode) throw new TypeError("Record schema was not issued by its owner");
  return (bytes: string): RecordSnapshot<T> =>
    Object.freeze({ bytes, value: decode(JSON.parse(bytes)) as T });
}
function readNative(file: string): string | null {
  try {
    return Deno.readTextFileSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Synchronous child-shim read: no observer, timer or child lifetime is created. */
export function recordReader<T>(
  directory: RecordDirectory,
  name: string,
  schema: RecordSchema<T>,
) {
  const file = path.join(directory.path, leaf(name)), decode = decoder(schema);
  const state = directoryState(directory), scope = state.scope;
  return Object.freeze({
    read: scope.bind((): RecordSnapshot<T> | null => {
      return admittedEffect(state, () => {
        const bytes = readNative(file);
        return bytes === null ? null : decode(bytes);
      }).value as RecordSnapshot<T> | null;
    }),
  });
}

export interface RecordChannelIO {
  publication: RecordIO;
  read(
    file: string,
    signal: AbortSignal,
  ): string | null | Promise<string | null>;
}
export const nativeRecordChannelIO: RecordChannelIO = {
  publication: nativeRecordIO,
  read: readNative,
};

/** The actual process/operation owner is bound once, not supplied to each probe.
 * Directory custody supplies scope cancellation. The public observer accepts no
 * unrelated path, arbitrary predicate or empty owners array. IO injection is a
 * low-level contract port, not an ordinary scenario capability.
 */
export function recordChannel<T>(
  directory: RecordDirectory,
  name: string,
  schema: RecordSchema<T>,
  owner: ProcessOwner,
  options: { signal?: AbortSignal; io?: RecordChannelIO } = {},
) {
  const state = directoryState(directory),
    file = path.join(directory.path, leaf(name)),
    decode = decoder(schema);
  const scope = state.scope, label = owner?.label, ownerExit = owner?.exit;
  const then = ownerExit?.then;
  if (!label || typeof then !== "function") {
    throw new TypeError("Record channel requires its actual owner");
  }
  const io = options.io ?? nativeRecordChannelIO;
  const publication = captureRecordIO(io.publication), readIO = io.read;
  const readBytes = scope.bind((file: string, signal: AbortSignal) =>
    readIO.call(io, file, signal)
  );
  const parentSignal = options.signal;
  const signal = parentSignal ? AbortSignal.any([parentSignal]) : undefined;
  const controller = new AbortController();
  const operations = new Set<Promise<unknown>>();
  const retain = <V>(operation: Promise<V>): Promise<V> => {
    const retained = operation.finally(() => operations.delete(retained));
    operations.add(retained);
    retained.catch(() => undefined);
    return retained;
  };
  let exited = false, waiting: Promise<RecordSnapshot<T>> | undefined;
  // Subscribe with the captured method now. Recording retirement in that first
  // callback must precede a caller resuming from await owner.exit.
  const exit = Promise.resolve(
    then.bind(ownerExit)((status) => {
      exited = true;
      return status;
    }),
  );
  exit.catch(() => undefined);
  const cancel = (
    reason: unknown = new Error(`${label} record channel cancelled`),
  ) => controller.abort(reason);
  const onAbort = () => cancel(signal!.reason);
  scope.onCancel((signal) => cancel(signal.reason));
  // Reserve cleanup before an external signal can register, invoke or throw.
  // Private cancellation is teardown, not the retired public cancel capability.
  scope.defer(() =>
    fixtureScope((cleanup) => {
      cleanup.defer(async () => {
        await waiting?.catch(() => undefined);
        await Promise.allSettled([...operations]);
      });
      cleanup.defer(() => signal?.removeEventListener("abort", onAbort));
    })
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const assertCurrent = scope.bind(() => controller.signal.throwIfAborted());
  const assertPublication = scope.bind(() => {
    assertCurrent();
    if (!state.writable) {
      throw new TypeError("Borrowed record directory is read-only");
    }
    if (exited) {
      throw new Error(`${label} exited before record publication`);
    }
  });
  const read = (): Promise<RecordSnapshot<T> | null> => {
    return retain((async () => {
      assertCurrent();
      const bytes = (await admit(state, (signal) =>
        readBytes(file, AbortSignal.any([signal, controller.signal])))).value;
      assertCurrent();
      return bytes === null ? null : decode(bytes);
    })());
  };
  return Object.freeze({
    signal: controller.signal,
    cancel: scope.bind(cancel),
    read,
    publish: scope.bind((
      value: T,
      options: {
        exclusive?: boolean;
        onCommit?: (snapshot: RecordSnapshot<T>) => void;
      } = {},
    ): RecordSnapshot<T> | Promise<RecordSnapshot<T>> => {
      assertPublication();
      const bytes = JSON.stringify(value);
      const snapshot = decode(bytes);
      const { exclusive, onCommit } = options;
      const admitted = admittedEffect(state, (signal) => {
        const published = publishRecord(file, bytes, {
          createNew: exclusive,
          signal: AbortSignal.any([signal, controller.signal]),
          onCommit: () => onCommit?.(snapshot),
        }, {
          ...publication,
          rename(from, to, signal) {
            assertPublication();
            return publication.rename(from, to, signal);
          },
          ...(publication.link
            ? {
              link(from: string, to: string, signal?: AbortSignal) {
                assertPublication();
                return publication.link!(from, to, signal);
              },
            }
            : {}),
        });
        return published ? published.then(() => snapshot) : snapshot;
      });
      // Only the synchronous publication path returns this exact snapshot;
      // the joined path keeps the admitted result, not the raw effect promise.
      return admitted.value === snapshot ? snapshot : retain(admitted.joined());
    }),
    wait: (): Promise<RecordSnapshot<T>> => {
      try {
        assertCurrent();
        if (!waiting) {
          // Only watcher construction is synchronous IO. Its lifetime is owned
          // by channel cleanup; reads are individually co-admitted above, so root
          // retirement can cancel idle observation instead of waiting on itself.
          waiting = (admittedEffect(state, () => ({
            value: waitForRecord(
              directory.path,
              `${schema.name}/${name}`,
              read,
              [{ label, exit }],
              controller.signal,
            ),
          })).value as { value: Promise<RecordSnapshot<T>> }).value;
          waiting.catch(() => undefined);
        }
        return waiting;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
}
