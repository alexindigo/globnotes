// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertOperationLease,
  type OperationLease,
} from "../operation_lease.ts";
import {
  bindGuardedSink,
  type Disclosure,
  synchronousTransform,
} from "./guarded_sink.ts";

declare const preparedReadBrand: unique symbol;
/** No payload or authority is exposed on a queued handle. */
export interface PreparedAuthorityRead<T> {
  readonly [preparedReadBrand]: T;
}
export interface AuthorityDisclosure {
  prepare<T>(value: Disclosure<T>): PreparedAuthorityRead<T>;
  read<T>(prepare: () => Promise<T>): Promise<PreparedAuthorityRead<T>>;
  disclose<T>(prepared: PreparedAuthorityRead<T>): ReadableStream<T>;
  /** JSON serialization is inside the lazy body's checked delivery turn. */
  body<T>(prepared: PreparedAuthorityRead<T>): ReadableStream<Uint8Array>;
  stream<T>(source: ReadableStream<T>): ReadableStream<T>;
}
type DisclosureMode = "live" | "outcome";
const reads = new WeakMap<object, {
  lease: OperationLease;
  inspect(): unknown;
}>();
function inspectData<T>(value: T): T {
  if (
    typeof value === "function" ||
    (value != null && typeof (value as { then?: unknown }).then === "function")
  ) {
    throw new TypeError(
      "Disclosure requires prepared data, not a callback or Promise",
    );
  }
  return value;
}
/** Provenance validation never invokes a selector or exposes the sealed value. */
export function assertPreparedDisclosure(
  lease: OperationLease,
  handle: PreparedAuthorityRead<unknown>,
): void {
  if (reads.get(handle)?.lease !== lease) {
    throw new TypeError("Disclosure requires this operation's prepared read");
  }
}
function preparedValue<T>(
  lease: OperationLease,
  handle: PreparedAuthorityRead<T>,
): T {
  const issued = reads.get(handle);
  if (!issued || issued.lease !== lease) {
    throw new TypeError("Disclosure requires this operation's prepared read");
  }
  return issued.inspect() as T;
}
/** Private synchronous read selector, used only by the trusted RPC integration.
 * It rebuilds permission-qualified metadata at the actual post, not earlier. */
export function prepareDisclosure<T>(
  lease: OperationLease<"live">,
  inspect: () => T,
): PreparedAuthorityRead<T> {
  assertOperationLease(lease, "live");
  if (
    typeof inspect !== "function" ||
    Object.prototype.toString.call(inspect) === "[object AsyncFunction]"
  ) {
    throw new TypeError("Disclosure preparation must be synchronous");
  }
  const handle = Object.freeze({}) as PreparedAuthorityRead<T>;
  reads.set(handle, { lease, inspect: () => inspectData(inspect()) });
  assertOperationLease(lease, "live");
  return handle;
}
/** Private binding: the public operation accepts only its issued handle. */
export function bindPreparedDisclosure<I, M extends DisclosureMode>(
  lease: OperationLease<M>,
  mode: NoInfer<M>,
  inspect: (value: I) => unknown,
  deliver: (prepared: { readonly value: unknown }) => undefined,
): (handle: PreparedAuthorityRead<I>) => void {
  const transform = synchronousTransform(inspect);
  return bindGuardedSink(
    lease,
    mode,
    (handle: PreparedAuthorityRead<I>) =>
      transform(preparedValue(lease, handle)),
    deliver,
  );
}
/** Shared instance/vault implementation. No public final-effect callback. */
export function createAuthorityDisclosure<M extends DisclosureMode>(
  lease: OperationLease<M>,
  mode: NoInfer<M>,
): AuthorityDisclosure {
  const assertCurrent = () => assertOperationLease(lease, mode);
  assertCurrent();
  const prepare = <T>(value: T): PreparedAuthorityRead<T> => {
    assertCurrent();
    inspectData(value);
    assertCurrent();
    const handle = Object.freeze({}) as PreparedAuthorityRead<T>;
    reads.set(handle, { lease, inspect: () => inspectData(value) });
    return handle;
  };
  const single = <T, V>(
    handle: PreparedAuthorityRead<T>,
    inspect: (value: T) => V,
  ): ReadableStream<V> => {
    // Provenance only: do not run the read selector or serialize until pull.
    assertPreparedDisclosure(lease, handle);
    assertCurrent();
    return new ReadableStream<V>({
      pull(controller) {
        const enqueue = controller.enqueue.bind(controller);
        const close = controller.close.bind(controller);
        bindPreparedDisclosure(lease, mode, inspect, ({ value }) => {
          enqueue(value as V);
          close();
          return undefined;
        })(handle);
      },
    }, { highWaterMark: 0 });
  };
  return Object.freeze({
    prepare: <T>(value: Disclosure<T>) =>
      prepare(value) as PreparedAuthorityRead<T>,
    async read<T>(
      prepareRead: () => Promise<T>,
    ): Promise<PreparedAuthorityRead<T>> {
      assertCurrent();
      return prepare(await prepareRead());
    },
    disclose: <T>(handle: PreparedAuthorityRead<T>) =>
      single(handle, (value) => value),
    body: <T>(handle: PreparedAuthorityRead<T>) =>
      single(handle, (value) => {
        const json = JSON.stringify(value);
        if (json === undefined) {
          throw new TypeError("Response requires JSON data");
        }
        return new TextEncoder().encode(json);
      }),
    stream<T>(source: ReadableStream<T>): ReadableStream<T> {
      assertCurrent();
      const reader = source.getReader();
      let finished = false;
      const release = () => {
        if (!finished) {
          finished = true;
          reader.releaseLock();
        }
      };
      const cancel = (reason: unknown) => {
        try {
          reader.cancel(reason).catch(() => {});
        } catch {
          // Cleanup must not replace the original stream error.
        } finally {
          release();
        }
      };
      return new ReadableStream<T>({
        async pull(controller) {
          try {
            assertCurrent();
            const result = await reader.read();
            if (result.done) {
              release();
              const close = controller.close.bind(controller);
              bindGuardedSink(lease, mode, () => ({ value: undefined }), () => {
                close();
                return undefined;
              })(undefined);
            } else {
              const enqueue = controller.enqueue.bind(controller);
              bindGuardedSink(
                lease,
                mode,
                (value: T) => ({ value }),
                ({ value }) => {
                  enqueue(value);
                  return undefined;
                },
              )(result.value);
            }
          } catch (error) {
            controller.error(error);
            cancel(error);
          }
        },
        cancel,
      }, { highWaterMark: 0 });
    },
  });
}
