// SPDX-License-Identifier: LGPL-3.0-only
import { createFixtureScope } from "./fixture_scope_engine.ts";
import type { ScopedPluginFixture } from "./plugin_fixture_engine.ts";
import { objectRecordSchema } from "./record_schema.ts";
import {
  openRecordDirectory,
  ownedRecordDirectory,
  recordChannel,
  type RecordChannelIO,
  recordReader,
} from "./owned_record_channel.ts";

const schema = objectRecordSchema("fixture clock", (value) => {
  if (
    Object.keys(value).length !== 1 || !Number.isSafeInteger(value.now) ||
    Number(value.now) < 0
  ) {
    throw new TypeError("Invalid fixture clock time");
  }
  return { now: value.now as number };
});
const record = "time.json";

/** Fixture-owned publisher, not the child process owner. P11 supplies directory,
 * schema, publication and cancellation custody. Each queued advance derives from
 * the last committed value. Pre-commit failure preserves it; post-commit failure
 * reports cleanup separately without rolling the committed snapshot back. */
export async function createFixtureClock(
  parent: string | ScopedPluginFixture,
  name: string,
  initial: number,
  options: { io?: RecordChannelIO } = {},
) {
  const io = options.io;
  const lifetime = createFixtureScope();
  const exit = Promise.withResolvers<{ code: number }>();
  return await lifetime.prepare(async (scope) => {
    scope.onCancel(() => exit.resolve({ code: 0 }));
    const directory = await ownedRecordDirectory(scope, parent, name);
    const channel = recordChannel(directory, record, schema, {
      label: name,
      exit: exit.promise,
    }, { io });
    let now = initial;
    const committed = (snapshot: { value: { now: number } }) => {
      now = snapshot.value.now;
    };
    await channel.publish({ now: initial }, {
      exclusive: true,
      onCommit: committed,
    });
    let tail = Promise.resolve();
    const advance = (milliseconds: number) => {
      const previous = tail;
      const operation = scope.admit(() =>
        previous.then(async () => {
          await channel.publish({ now: now + milliseconds }, {
            onCommit: committed,
          });
        })
      ).then(() => undefined);
      tail = operation.catch(() => undefined);
      return operation;
    };
    return Object.freeze({
      directory: directory.path,
      now: () => now,
      advance,
      close: () => lifetime.close(),
    });
  });
}

/** Borrowed read-only scope lives exactly as long as the child-held closure.
 * No file watcher, timer, wall-clock fallback or parent/global override. */
export function fixtureClockReader(directory: string): () => number {
  const { scope } = createFixtureScope();
  const reader = recordReader(
    openRecordDirectory(scope, directory),
    record,
    schema,
  );
  return () => {
    const snapshot = reader.read();
    if (!snapshot) throw new Error("Fixture clock record is missing");
    return snapshot.value.now;
  };
}
