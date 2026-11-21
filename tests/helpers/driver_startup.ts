// SPDX-License-Identifier: LGPL-3.0-only
import type { TestServer } from "./boot.ts";
import { type FixtureScope, fixtureScope } from "./fixture_scope.ts";
import {
  nativeRecordChannelIO,
  openRecordDirectory,
  ownedRecordDirectory,
  recordChannel,
  type RecordDirectory,
  recordReader,
  type RecordSnapshot,
} from "./owned_record_channel.ts";
import { done, pending, waitUntil } from "./wait.ts";
import {
  driverStartupSchema,
  type DriverStartupSnapshot,
  recordName,
} from "./driver_startup_schema.ts";

export type InitialDriverState = "active" | "paused";
export const createDriverStartupDirectory = (
  scope: FixtureScope,
  parent: Parameters<typeof ownedRecordDirectory>[1],
) => ownedRecordDirectory(scope, parent, "driver-startup");

/** Bind at boot/restart, not when a scenario happens to await. A retired server
 * cannot lend its successful snapshot to a replacement server or later cycle. */
export function bindDriverStartup(
  custody: FixtureScope,
  directory: RecordDirectory,
  server: TestServer,
  current: () => TestServer,
  options: {
    signal?: AbortSignal;
    /** Low-level read port for observation contracts; no alternate clock. */
    read?: () => RecordSnapshot<DriverStartupSnapshot> | null;
  } = {},
) {
  custody.assertCurrent();
  const { pid, exited, status, logs } = server;
  const child = {
    pid,
    status: status.bind(server),
    ...(logs ? { logs: logs.bind(server) } : {}),
  };
  const { signal: observationFailure, read: inputRead } = options;
  const readPort = inputRead?.bind(options);
  const atBoot = (readPort ??
    recordReader(directory, recordName, driverStartupSchema).read)()
    ?.value;
  const initial = atBoot?.pid === pid ? atBoot : undefined;
  return Object.freeze({
    server,
    initialDriver(
      id: string,
      expected: InitialDriverState,
      signal?: AbortSignal,
    ) {
      if (expected !== "active" && expected !== "paused") {
        throw new TypeError(
          "Initial driver requires explicit active or paused state",
        );
      }
      custody.assertCurrent();
      const cancellation = new AbortController();
      signal = AbortSignal.any([
        custody.signal,
        cancellation.signal,
        ...(signal ? [signal] : []),
        ...(observationFailure ? [observationFailure] : []),
      ]);
      // Register cancellation/join before creating the observation's local
      // record scope. Parent teardown cannot delete its root under a live read.
      custody.onCancel(() => {
        cancellation.abort(Error(`driver '${id}' initial cycle owner retired`));
      });
      custody.defer(async () => {
        await work.catch(() => undefined);
      });
      const work = fixtureScope(async (scope) => {
        const label = `driver '${id}' initial cycle`;
        const assertCurrent = () => {
          custody.assertCurrent();
          if (!Object.is(current(), server)) {
            throw Error(`${label}: server owner replaced`);
          }
          signal?.throwIfAborted();
        };
        assertCurrent();
        const root = openRecordDirectory(scope, directory);
        const reader = recordReader(root, recordName, driverStartupSchema);
        const read = readPort ?? (() => reader.read());
        const owner = {
          label: `driver server ${pid}`,
          exit: exited,
        };
        let captured = initial;
        const inspect = (snapshot: DriverStartupSnapshot) => {
          assertCurrent();
          if (
            snapshot.pid !== pid || snapshot.sequence !== 1 ||
            snapshot.owner !== captured!.owner
          ) {
            throw Error(`${label}: cycle owner replaced`);
          }
          if (snapshot.failure !== null) {
            throw Error(`${label}: ${snapshot.failure}`);
          }
          if (snapshot.pending) return false;
          const state = snapshot.states[id];
          if (state && state !== "starting" && state !== expected) {
            throw Error(`${label}: ${state}, expected ${expected}`);
          }
          if (state !== expected) {
            throw Error(
              `${label}: cycle completed with ${
                state ?? "absent"
              }, expected ${expected}`,
            );
          }
          return true;
        };
        let completing = false;
        // One channel captures the child's exit subscription once for both
        // admission and completion, without bridging retirement a promise hop late.
        const observation = recordChannel(
          root,
          recordName,
          driverStartupSchema,
          owner,
          {
            signal,
            io: {
              ...nativeRecordChannelIO,
              read() {
                assertCurrent();
                const snapshot = read();
                if (snapshot && (!completing || inspect(snapshot.value))) {
                  return snapshot.bytes;
                }
                return null;
              },
            },
          },
        );
        try {
          captured ??= await waitUntil(async () => {
            assertCurrent();
            const snapshot = (await observation.read())?.value;
            if (snapshot?.pid === pid && snapshot.sequence !== 1) {
              throw Error(`${label}: cycle owner replaced`);
            }
            return snapshot?.pid === pid
              ? done(snapshot)
              : pending("initial cycle admission");
          }, { label: `${label}: admission`, children: [child] });
        } catch (error) {
          signal.throwIfAborted();
          throw error;
        }
        // Capture fixes identity, never the outcome. Even a terminal boot record
        // requires a current read; P11 owns fresh post-exit reads and cancellation.
        completing = true;
        const terminal = (await observation.wait()).value;
        inspect(terminal);
        return Object.freeze({
          pid,
          owner: captured.owner,
          state: expected,
        });
      });
      work.catch(() => undefined);
      return work;
    },
  });
}
