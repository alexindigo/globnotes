// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import {
  arrayRecordSchema,
  borrowRecordDirectory,
  nativeRecordChannelIO,
  objectRecordSchema,
  openRecordDirectory,
  ownedRecordDirectory,
  recordChannel,
  type RecordDirectory,
  recordReader,
  type RecordSchema,
} from "./helpers/owned_record_channel.ts";
import {
  nativeRecordIO,
  type ProcessOwner,
  publishRecord,
  type RecordIO,
  waitForRecord,
} from "./helpers/process_records.ts";
import {
  createSyncStatusDirectory,
  syncStatusChannel,
  syncStatusReader,
} from "./helpers/sync_status_control.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { fixtureGate, fixtureTest } from "./helpers/fixture_coordination.ts";
import { command, DENO } from "./helpers/process.ts";
import { OwnershipError } from "../shared/ownership.js";
import { createFixtureScope } from "./helpers/fixture_scope_engine.ts";
import {
  bindPluginFixture,
  scopedPluginFixture,
} from "./helpers/plugin_fixture_engine.ts";

const schema = objectRecordSchema("revision", (value) => {
  if (Object.keys(value).length !== 1 || typeof value.revision !== "number") {
    throw new TypeError("Invalid revision");
  }
  return { revision: value.revision };
});
type RecordValue = { revision: number };
type Fixture = {
  scope: FixtureScope;
  directory: RecordDirectory;
  owner: ProcessOwner;
  exit: PromiseWithResolvers<{ code: number }>;
  file: string;
};
function withRecords<T>(body: (fixture: Fixture) => T | Promise<T>) {
  return fixtureScope(async (scope) => {
    const parent = (await scope.acquire(
      () => Deno.makeTempDir({ prefix: "owned-record-" }),
      (parent) => Deno.remove(parent, { recursive: true }),
    )).value;
    const directory = await ownedRecordDirectory(scope, parent, "control");
    const exit = Promise.withResolvers<{ code: number }>();
    scope.defer(() => exit.resolve({ code: 0 }));
    return await body({
      scope,
      directory,
      owner: { label: "actual record owner", exit: exit.promise },
      exit,
      file: `${directory.path}/value.json`,
    });
  });
}
async function caught(body: () => unknown | Promise<unknown>) {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}
const entries = (directory: RecordDirectory) =>
  [...Deno.readDirSync(directory.path)].map((entry) => entry.name).sort();

Deno.test("record custody r3: settled directory borrowers retire their root links", async () => {
  await withRecords(async (f) => {
    const baseline = f.scope.size;
    for (let index = 0; index < 12; index++) {
      await fixtureScope(async (borrower) => {
        const directory = borrowRecordDirectory(borrower, f.directory);
        const channel = recordChannel(directory, "value.json", schema, f.owner);
        await channel.publish({ revision: index });
        assertEquals((await channel.read())?.value, { revision: index });
      });
      assertEquals(
        f.scope.size,
        baseline,
        "settled borrower retained its root edge",
      );
      assert(Deno.statSync(f.directory.path).isDirectory);
    }
    assertEquals(Deno.readTextFileSync(f.file), '{"revision":11}');
  });
});

Deno.test("record custody r3: rejected directory preparation has no escaped resource", async () => {
  await withRecords(async (f) => {
    const before = f.scope.size;
    const failure = new Error("directory preparation failed");
    const pending = ownedRecordDirectory(f.scope, f.directory.path, "failed", {
      beforeCreate: () => {
        throw failure;
      },
    });
    assertInstanceOf(pending, Promise);
    assertStrictEquals(await caught(() => pending), failure);
    assertEquals(f.scope.size, before);
    assertEquals(entries(f.directory), []);
  });
});

Deno.test("record custody r3: captured prototype IO methods retain their actual receiver", async () => {
  await withRecords(async (f) => {
    let receiver: unknown;
    const publication = Object.create({
      ...nativeRecordIO,
      write(file: string, bytes: string | Uint8Array) {
        receiver = this;
        return nativeRecordIO.write(file, bytes);
      },
    }) as RecordIO;
    const channel = recordChannel(f.directory, "value.json", schema, f.owner, {
      io: { ...nativeRecordChannelIO, publication },
    });
    const result = channel.publish({ revision: 9 });
    assert(
      !(result instanceof Promise),
      "native publication became asynchronous",
    );
    assertStrictEquals(receiver, publication);
    assertEquals((await channel.read())?.value, { revision: 9 });
  });
});

for (const exclusive of [false, true]) {
  Deno.test(`record review: awaiting owner exit fences immediate ${exclusive ? "exclusive" : "replacement"} publication`, async () => {
    await withRecords(async (f) => {
      const effects: string[] = [];
      const channel = recordChannel(
        f.directory,
        "value.json",
        schema,
        f.owner,
        {
          io: {
            ...nativeRecordChannelIO,
            publication: {
              ...nativeRecordIO,
              write(file, content) {
                effects.push("write");
                return nativeRecordIO.write(file, content);
              },
            },
          },
        },
      );
      assertEquals(channel.publish({ revision: 1 }), {
        bytes: '{"revision":1}',
        value: { revision: 1 },
      });
      effects.length = 0;
      f.exit.resolve({ code: 17 });
      await f.owner.exit;
      assertThrows(
        () => channel.publish({ revision: 2 }, { exclusive }),
        Error,
        "actual record owner exited before record publication",
      );
      assertEquals(effects, []);
      assertEquals(Deno.readTextFileSync(f.file), '{"revision":1}');
      assertEquals(entries(f.directory), ["value.json"]);
    });
  });
}

for (const fixtureRoot of [false, true]) {
  for (const first of ["owner", "borrower"] as const) {
    for (const effect of ["read", "write", "rename", "link"] as const) {
      fixtureTest(
        `record phased close: ${
          fixtureRoot ? "fixture" : "directory"
        } ${effect} cancels and drains with ${first} first`,
        async (testScope) => {
          await fixtureScope(async (cleanup) => {
            const owner = createFixtureScope(), borrower = createFixtureScope();
            cleanup.defer(() => owner.close());
            cleanup.defer(() => borrower.close());
            const fixture = fixtureRoot
              ? await scopedPluginFixture(owner.scope)
              : undefined;
            const parent = fixture ?? (await owner.scope.acquire(
              () => Deno.makeTempDir({ prefix: "record-phased-" }),
              (root) => Deno.remove(root, { recursive: true }),
            )).value;
            const directory = await ownedRecordDirectory(
              owner.scope,
              parent,
              "control",
            );
            const borrowed = borrowRecordDirectory(borrower.scope, directory);
            const exit = Promise.withResolvers<{ code: number }>();
            cleanup.defer(() => exit.resolve({ code: 0 }));
            const entered = fixtureGate(testScope);
            let active = 0,
              aborted = 0,
              calls = 0,
              disposed = 0,
              existedAtAbort = false;
            let observedSignal: AbortSignal | undefined;
            const held = (signal: AbortSignal) => {
              signal.throwIfAborted();
              observedSignal = signal;
              active++;
              calls++;
              entered.resolve();
              return new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                  aborted++;
                  existedAtAbort = Deno.statSync(directory.path).isDirectory;
                  reject(signal.reason);
                }, { once: true });
              }).finally(() => active--);
            };
            // This marker is registered before the channel and its later work.
            // It must never run before cancellation-dependent IO has drained.
            owner.scope.defer(() => {
              assertEquals(active, 0);
              disposed++;
            });
            borrower.scope.defer(() => assertEquals(active, 0));
            const channel = recordChannel(borrowed, "value.json", schema, {
              label: "cancellation-dependent",
              exit: exit.promise,
            }, {
              io: {
                publication: {
                  ...nativeRecordIO,
                  write(file, content, signal) {
                    assert(
                      signal,
                      "publication did not receive owned cancellation",
                    );
                    nativeRecordIO.write(file, content);
                    if (effect === "write") return held(signal);
                  },
                  rename(from, to, signal) {
                    assert(signal, "rename did not receive owned cancellation");
                    return effect === "rename"
                      ? held(signal)
                      : nativeRecordIO.rename(from, to);
                  },
                  link(from, to, signal) {
                    assert(signal, "link did not receive owned cancellation");
                    return effect === "link"
                      ? held(signal)
                      : nativeRecordIO.link!(from, to);
                  },
                },
                read(_file, signal) {
                  return held(signal);
                },
              },
            });
            const operation = effect === "read"
              ? channel.read()
              : Promise.resolve(
                channel.publish({ revision: 1 }, {
                  exclusive: effect === "link",
                }),
              );
            const outcome = caught(() => operation);
            await workMilestone(
              operation,
              entered.promise,
              "cancellation-dependent IO entered",
            );
            const retiring = first === "owner" ? owner : borrower;
            const close = retiring.close();
            assert(
              channel.signal.aborted,
              "channel cancellation was deferred until resource release",
            );
            assert(
              observedSignal!.aborted,
              "admitted IO was not synchronously cancelled",
            );
            await close;
            assertInstanceOf(await outcome, OwnershipError);
            assertEquals(active, 0);
            assertEquals(aborted, 1);
            assertEquals(calls, 1);
            assert(
              existedAtAbort,
              "root deleted before pending IO received cancellation",
            );
            if (first === "borrower") {
              assertEquals(
                owner.scope.signal.aborted,
                false,
                "borrower retirement cancelled the resource owner",
              );
              assertEquals(
                entries(directory),
                [],
                "cancelled publication left staging or final bytes",
              );
            }
            await (first === "owner" ? borrower : owner).close();
            await owner.close();
            await borrower.close();
            assertEquals(disposed, 1);
            assertEquals(owner.scope.size, 0);
            assertEquals(borrower.scope.size, 0);
            assertEquals(calls, 1, "closing again started late IO");
            await assertRejects(
              () =>
                Deno.stat(typeof parent === "string" ? parent : parent.root),
              Deno.errors.NotFound,
            );
          });
        },
      );
    }
  }
}

for (const closing of ["owner", "borrower"] as const) {
  for (const effect of ["read", "publish"] as const) {
    fixtureTest(
      `record admission: ${closing} drains held borrowed ${effect} before root removal`,
      async (testScope) => {
        await fixtureScope(async (cleanup) => {
          const owner = createFixtureScope(), borrower = createFixtureScope();
          cleanup.defer(() => owner.close());
          cleanup.defer(() => borrower.close());
          const parent = (await owner.scope.acquire(() =>
            Deno.makeTempDir({ prefix: "record-admission-" }), (root) =>
            Deno.remove(root, { recursive: true }))).value;
          const directory = await ownedRecordDirectory(
            owner.scope,
            parent,
            "control",
          );
          const borrowed = borrowRecordDirectory(borrower.scope, directory);
          const entered = fixtureGate(testScope),
            release = fixtureGate(testScope),
            closeEntered = fixtureGate(testScope);
          cleanup.onCancel(() =>
            release.resolve()
          );
          let active = 0;
          const io = {
            publication: {
              ...nativeRecordIO,
              async write(file: string, bytes: string | Uint8Array) {
                active++;
                entered.resolve();
                try {
                  await release.promise;
                  nativeRecordIO.write(file, bytes);
                } finally {
                  active--;
                }
              },
            },
            async read() {
              active++;
              entered.resolve();
              try {
                await release.promise;
                return '{"revision":1}';
              } finally {
                active--;
              }
            },
          };
          const exit = Promise.withResolvers<{ code: number }>();
          const channel = recordChannel(borrowed, "value.json", schema, {
            label: "borrowed IO",
            exit: exit.promise,
          }, { io });
          const ownerSize = owner.scope.size,
            borrowerSize = borrower.scope.size;
          const operation = effect === "read"
            ? channel.read()
            : Promise.resolve(channel.publish({ revision: 1 }));
          const outcome = caught(() => operation);
          await workMilestone(
            operation,
            entered.promise,
            "borrowed IO entered",
          );
          assert(
            owner.scope.size > ownerSize,
            "resource owner did not admit borrowed work",
          );
          assert(
            borrower.scope.size > borrowerSize,
            "borrower did not admit borrowed work",
          );
          const retiring = closing === "owner" ? owner : borrower;
          retiring.scope.onCancel(() => closeEntered.resolve());
          const close = retiring.close();
          await workMilestone(
            close,
            closeEntered.promise,
            "borrowed owner close started",
          );
          await fixtureScope((checking) => {
            checking.onCancel(() => release.resolve());
            checking.defer(() => outcome);
            checking.defer(() => close);
            assertEquals(active, 1);
            assert(
              Deno.statSync(directory.path).isDirectory,
              "root deleted while borrowed effect was held",
            );
          });
          assertEquals(active, 0);
          assertInstanceOf(await outcome, OwnershipError);
          if (closing === "owner") {
            await assertRejects(() => Deno.stat(parent), Deno.errors.NotFound);
          } else {assert(
              Deno.statSync(directory.path).isDirectory,
              "borrower removed the owner's directory",
            );}
          exit.resolve({ code: 0 });
        });
      },
    );
  }
}

Deno.test("record admission: completed borrowed effects release both reservations and keep snapshots wrapped", async () => {
  await fixtureScope(async (cleanup) => {
    const owner = createFixtureScope(), borrower = createFixtureScope();
    cleanup.defer(() => owner.close());
    cleanup.defer(() => borrower.close());
    const parent = (await owner.scope.acquire(() =>
      Deno.makeTempDir({ prefix: "record-admission-done-" }), (root) =>
      Deno.remove(root, { recursive: true }))).value;
    const directory = await ownedRecordDirectory(
      owner.scope,
      parent,
      "control",
    );
    const borrowed = borrowRecordDirectory(borrower.scope, directory);
    const exit = Promise.withResolvers<{ code: number }>();
    let thenReads = 0;
    const value = { revision: 1 };
    Object.defineProperty(value, "then", {
      get() {
        thenReads++;
        throw new Error("admitted decoded resource resolved");
      },
    });
    const channel = recordChannel(
      borrowed,
      "value.json",
      objectRecordSchema("admitted", () =>
        value),
      { label: "completed", exit: exit.promise },
    );
    const ownerSize = owner.scope.size, borrowerSize = borrower.scope.size;
    const publication = channel.publish(value);
    assert(
      !(publication instanceof Promise),
      "native publication became asynchronous",
    );
    assertStrictEquals(publication.value, value);
    for (let index = 0; index < 8; index++) {
      assertStrictEquals((await channel.read())!.value, value);
    }
    assertEquals(
      owner.scope.size,
      ownerSize,
      "completed owner reservations retained",
    );
    assertEquals(
      borrower.scope.size,
      borrowerSize,
      "completed borrower reservations retained",
    );
    const reader = recordReader(
      openRecordDirectory(borrower.scope, directory),
      "value.json",
      schema,
    );
    assertEquals(reader.read()?.value, { revision: 1 });
    assertEquals(thenReads, 0);
    exit.resolve({ code: 0 });
  });
});

for (const effect of ["read", "publish"] as const) {
  fixtureTest(
    `record admission: distinct fixture root, directory owner and borrower all drain held ${effect}`,
    async (testScope) => {
      await fixtureScope(async (cleanup) => {
        const root = createFixtureScope(),
          provider = createFixtureScope(),
          borrower = createFixtureScope();
        cleanup.defer(() => root.close());
        cleanup.defer(() => provider.close());
        cleanup.defer(() => borrower.close());
        const fixture = await scopedPluginFixture(root.scope);
        const directory = await ownedRecordDirectory(provider.scope, {
          ...fixture,
        }, "control");
        const borrowed = borrowRecordDirectory(borrower.scope, directory);
        const entered = fixtureGate(testScope),
          release = fixtureGate(testScope),
          cancelled = fixtureGate(testScope);
        cleanup.onCancel(() => release.resolve());
        let active = 0;
        const held = async (signal: AbortSignal) => {
          active++;
          entered.resolve();
          try {
            await release.promise;
            signal.throwIfAborted();
            return null;
          } finally {
            active--;
          }
        };
        const exit = Promise.withResolvers<{ code: number }>();
        cleanup.defer(() => exit.resolve({ code: 0 }));
        const channel = recordChannel(borrowed, "value.json", schema, {
          label: "three custodians",
          exit: exit.promise,
        }, {
          io: {
            read(_file, signal) {
              return held(signal);
            },
            publication: {
              ...nativeRecordIO,
              async write(file, bytes, signal) {
                assert(signal);
                nativeRecordIO.write(file, bytes);
                await held(signal);
              },
            },
          },
        });
        const scopes = [root.scope, provider.scope, borrower.scope],
          sizes = scopes.map((scope) => scope.size);
        const operation = effect === "read"
          ? channel.read()
          : Promise.resolve(channel.publish({ revision: 1 }));
        const outcome = caught(() => operation);
        await workMilestone(
          operation,
          entered.promise,
          "three-custodian IO entered",
        );
        for (const [index, scope] of scopes.entries()) {
          assert(
            scope.size > sizes[index],
            `custodian ${index} did not admit held work`,
          );
        }
        root.scope.onCancel(() => cancelled.resolve());
        const close = root.close();
        await workMilestone(
          close,
          cancelled.promise,
          "fixture root cancellation started",
        );
        await fixtureScope((checking) => {
          checking.onCancel(() => release.resolve());
          checking.defer(() => outcome);
          checking.defer(() => close);
          assertEquals(active, 1);
          assert(channel.signal.aborted);
          assert(
            Deno.statSync(fixture.root).isDirectory,
            "fixture deleted while borrowed IO remained active",
          );
        });
        assertInstanceOf(await outcome, OwnershipError);
        assertEquals(active, 0);
        for (const scope of scopes) assertEquals(scope.size, 0);
        await assertRejects(
          () => Deno.stat(fixture.root),
          Deno.errors.NotFound,
        );
      });
    },
  );
}

fixtureTest(
  "record admission: root-bound Sync fixture construction drains held mkdir and never recreates its retired root",
  async (testScope) => {
    await fixtureScope(async (cleanup) => {
      const owner = createFixtureScope(), borrower = createFixtureScope();
      cleanup.defer(() => owner.close());
      cleanup.defer(() => borrower.close());
      const fixture = await scopedPluginFixture(owner.scope);
      const entered = fixtureGate(testScope),
        release = fixtureGate(testScope),
        closeEntered = fixtureGate(testScope);
      cleanup.onCancel(() => release.resolve());
      const borrowedFixture = bindPluginFixture(borrower.scope, fixture);
      const ownerSize = owner.scope.size;
      const creating = ownedRecordDirectory(
        borrower.scope,
        {
          ...borrowedFixture,
        },
        "sync-control",
        {
          beforeCreate: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      );
      const outcome = caught(() => creating);
      await workMilestone(
        creating,
        entered.promise,
        "root-bound directory preparation entered",
      );
      assert(
        owner.scope.size > ownerSize,
        "fixture root did not admit directory construction",
      );
      owner.scope.onCancel(() => closeEntered.resolve());
      const close = owner.close();
      await workMilestone(
        close,
        closeEntered.promise,
        "root-bound owner close started",
      );
      await fixtureScope((checking) => {
        checking.onCancel(() => release.resolve());
        checking.defer(() => outcome);
        checking.defer(() => close);
        assert(
          Deno.statSync(fixture.root).isDirectory,
          "fixture root removed before held record construction",
        );
      });
      assertInstanceOf(await outcome, OwnershipError);
      await assertRejects(() => Deno.stat(fixture.root), Deno.errors.NotFound);
    });
  },
);

Deno.test("record admission: fixture root retires borrowed idle observers and fences all Sync ports", async () => {
  await fixtureScope(async (cleanup) => {
    const owner = createFixtureScope(),
      borrower = createFixtureScope(),
      observer = createFixtureScope();
    cleanup.defer(() => owner.close());
    cleanup.defer(() => borrower.close());
    cleanup.defer(() => observer.close());
    const fixture = await scopedPluginFixture(owner.scope);
    const directory = await createSyncStatusDirectory(borrower.scope, fixture);
    const borrowed = borrowRecordDirectory(observer.scope, directory);
    const exit = Promise.withResolvers<{ code: number }>();
    const channel = syncStatusChannel(borrowed, {
      label: "idle Sync",
      exit: exit.promise,
    });
    const reader = syncStatusReader(observer.scope, directory);
    const waiting = channel.wait();
    const outcome = caught(() => waiting);
    // A completed read is a real admission turn while the idle watcher remains.
    assertEquals(await channel.read(), null);
    await owner.close();
    assert(await outcome instanceof Error);
    for (
      const effect of [
        reader.read,
        channel.cancel,
        () => channel.publish({}),
      ]
    ) {
      assertThrows(effect, OwnershipError, "retired");
    }
    for (const effect of [channel.read, channel.wait]) {
      const pending = effect();
      assertInstanceOf(pending, Promise);
      await assertRejects(() => pending, OwnershipError, "retired");
    }
    await assertRejects(() => Deno.stat(fixture.root), Deno.errors.NotFound);
    exit.resolve({ code: 0 });
  });
});

Deno.test("record custody review: every escaped reader and channel effect rejects after retirement", async () => {
  const effects: (() => unknown)[] = [];
  const asynchronous: (() => Promise<unknown>)[] = [];
  let scope!: FixtureScope, root = "", reads = 0;
  await withRecords(async (f) => {
    scope = f.scope;
    root = f.directory.path;
    const channel = recordChannel(f.directory, "value.json", schema, f.owner, {
      io: {
        ...nativeRecordChannelIO,
        read(file, signal) {
          reads++;
          return nativeRecordChannelIO.read(file, signal);
        },
      },
    });
    const reader = recordReader(f.directory, "value.json", schema);
    const syncDirectory = await createSyncStatusDirectory(scope, root);
    const control = syncStatusChannel(syncDirectory, f.owner);
    const syncReader = syncStatusReader(scope, root);
    await channel.publish({ revision: 1 });
    await control.publish({ activities: { office: "sending" } });
    effects.push(
      reader.read,
      () => channel.publish({ revision: 2 }),
      channel.cancel,
      syncReader.read,
      () => control.publish({ activities: { office: "receiving" } }),
      control.cancel,
    );
    asynchronous.push(channel.read, channel.wait, control.read, control.wait);
    assertEquals(Object.hasOwn(reader, "dispose"), false);
    assertEquals(Object.hasOwn(channel, "dispose"), false);
    function checkedCaller() {
      // @ts-expect-error callback record readers have no manual deletion port
      reader.dispose();
      // @ts-expect-error callback record channels have no manual deletion port
      channel.dispose();
    }
    assertEquals(typeof checkedCaller, "function");
  });
  const before = reads;
  for (const effect of effects) assertThrows(effect, OwnershipError, "retired");
  for (const effect of asynchronous) {
    const pending = effect();
    assertInstanceOf(pending, Promise);
    await assertRejects(() => pending, OwnershipError, "retired");
  }
  assertThrows(
    () => openRecordDirectory(scope, root),
    OwnershipError,
    "retired",
  );
  assertEquals(reads, before);
  await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
});

Deno.test("record custody review: owner promise and constructor options are captured once", async () => {
  let ownerReads = 0, thenReads = 0, removals = 0;
  await withRecords(async (f) => {
    const exit = Promise.withResolvers<{ code: number }>();
    f.scope.defer(() => exit.resolve({ code: 0 }));
    const then = exit.promise.then.bind(exit.promise);
    Object.defineProperty(exit.promise, "then", {
      get() {
        thenReads++;
        if (thenReads > 1) throw new Error("owner exit assimilated twice");
        return then;
      },
    });
    const owner = {
      label: "captured record owner",
      get exit() {
        ownerReads++;
        return exit.promise;
      },
    };
    const original = new AbortController(), replacement = new AbortController();
    const remove = original.signal.removeEventListener.bind(original.signal);
    original.signal.removeEventListener =
      ((...args: Parameters<typeof remove>) => {
        removals++;
        return remove(...args);
      }) as typeof original.signal.removeEventListener;
    const options = { signal: original.signal };
    const channel = recordChannel(
      f.directory,
      "value.json",
      schema,
      owner,
      options,
    );
    options.signal = replacement.signal;
    owner.label = "mutated owner";
    const rejected = assertRejects(
      () => channel.wait(),
      Error,
      "captured record owner exited",
    );
    exit.resolve({ code: 17 });
    await rejected;
  });
  assertEquals(ownerReads, 1);
  assertEquals(thenReads, 1);
  assertEquals(removals, 1);
});

Deno.test("record custody review: failed listener construction retains cleanup custody", async () => {
  const failure = new Error("listener construction failed");
  let installed = 0, removed = 0, root = "";
  const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
    add(...args);
    installed++;
    throw failure;
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener =
    ((...args: Parameters<typeof remove>) => {
      remove(...args);
      removed++;
    }) as typeof controller.signal.removeEventListener;
  const error = await caught(() =>
    withRecords((f) => {
      root = f.directory.path;
      recordChannel(f.directory, "value.json", schema, f.owner, {
        signal: controller.signal,
      });
    })
  );
  assertStrictEquals(error, failure);
  assertEquals(installed, 1);
  assertEquals(removed, 1);
  await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
});

Deno.test("record custody review: issued IO capabilities do not reread mutable port objects", async () => {
  await withRecords(async (f) => {
    const io = {
      publication: { ...nativeRecordIO },
      read: nativeRecordChannelIO.read,
    };
    const channel = recordChannel(f.directory, "value.json", schema, f.owner, {
      io,
    });
    io.publication.write = () => {
      throw new Error("mutable publication port reread");
    };
    io.read = () => {
      throw new Error("mutable read port reread");
    };
    const published = await channel.publish({ revision: 3 });
    assertEquals((await channel.read())?.value, published.value);
  });
});

fixtureTest(
  "record custody review: rejecting listener cleanup still joins held IO before root release",
  async (testScope) => {
    const failure = new Error("listener cleanup failed");
    const entered = fixtureGate(testScope),
      joined = fixtureGate(testScope),
      release = fixtureGate(testScope);
    let active = 0, root = "", work!: Promise<unknown>;
    const closing = withRecords(async (f) => {
      root = f.directory.path;
      f.scope.defer(() =>
        assertEquals(active, 0, "read outlived failing channel cleanup")
      );
      const controller = new AbortController();
      const remove = controller.signal.removeEventListener.bind(
        controller.signal,
      );
      controller.signal.removeEventListener =
        ((...args: Parameters<typeof remove>) => {
          remove(...args);
          throw failure;
        }) as typeof controller.signal.removeEventListener;
      const channel = recordChannel(
        f.directory,
        "value.json",
        schema,
        f.owner,
        {
          signal: controller.signal,
          io: {
            ...nativeRecordChannelIO,
            async read(_file, signal) {
              active++;
              entered.resolve();
              try {
                await release.promise;
                signal.throwIfAborted();
                return null;
              } finally {
                active--;
              }
            },
          },
        },
      );
      work = channel.read();
      work.catch(() => undefined);
      f.scope.onCancel(() => joined.resolve());
      await workMilestone(
        work,
        entered.promise,
        "read entered before failing cleanup",
      );
    });
    const outcome = caught(() => closing);
    await fixtureScope(async (checking) => {
      checking.onCancel(() => release.resolve());
      checking.defer(() => work?.catch(() => undefined));
      checking.defer(() => outcome);
      await workMilestone(
        closing,
        joined.promise,
        "failing cleanup cancelled before draining its held read",
      );
      assertEquals(active, 1);
      assert(Deno.statSync(root).isDirectory);
    });
    assertStrictEquals(await outcome, failure);
    assertEquals(active, 0);
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  },
);

Deno.test("record custody review: async snapshots never resolve their decoded resource value", async () => {
  let reads = 0;
  const value = { revision: 1 };
  Object.defineProperty(value, "then", {
    get() {
      reads++;
      throw new Error("decoded value resolved");
    },
  });
  await withRecords(async (f) => {
    const channel = recordChannel(
      f.directory,
      "value.json",
      objectRecordSchema("owned snapshot", () => value),
      f.owner,
    );
    assertStrictEquals((await channel.publish(value)).value, value);
    assertStrictEquals((await channel.read())!.value, value);
    assertStrictEquals((await channel.wait()).value, value);
  });
  assertEquals(reads, 0);
});

Deno.test("record channel review: invalid and retired acquisition reject without escaped directories", async () => {
  let scope!: FixtureScope, parent = "";
  await withRecords(async (f) => {
    scope = f.scope;
    parent = f.directory.path;
    const before = scope.size;
    const invalid = ownedRecordDirectory(scope, parent, "../escape");
    assertInstanceOf(invalid, Promise);
    await assertRejects(() => invalid, TypeError, "single path component");
    assertEquals(scope.size, before);
    assertEquals(entries(f.directory), []);
  });
  const retired = ownedRecordDirectory(scope, parent, "late");
  assertInstanceOf(retired, Promise);
  await assertRejects(() => retired, OwnershipError, "retired");
  assertEquals(scope.size, 0);
  await assertRejects(() => Deno.stat(parent), Deno.errors.NotFound);
});

Deno.test("Sync control review: read-only preload consumes records without asynchronous unload teardown", async () => {
  await fixtureScope(async (scope) => {
    const vault = (await scope.acquire(
      () => Deno.makeTempDir({ prefix: "sync-unload-review-" }),
      (root) => Deno.remove(root, { recursive: true }),
    )).value;
    const state = `${vault}/.globnotes`;
    await Deno.mkdir(state);
    const directory = await createSyncStatusDirectory(scope, state);
    const exit = Promise.withResolvers<{ code: number }>();
    scope.defer(() => exit.resolve({ code: 0 }));
    const control = syncStatusChannel(directory, {
      label: "preload review operation",
      exit: exit.promise,
    });
    await control.publish({ activities: { office: "sending" } });
    const preload =
      new URL("./helpers/sync_status_preload.ts", import.meta.url).href;
    const result = await command(DENO, {
      args: [
        "eval",
        `const add=globalThis.addEventListener, remove=globalThis.removeEventListener;
let unloadRegistrations=0, unloadRemovals=0;
globalThis.addEventListener=function(...args) {
  if(args[0]==="unload") { unloadRegistrations++; throw new Error("asynchronous preload unload teardown"); }
  return add.apply(this,args);
};
globalThis.removeEventListener=function(...args) {
  if(args[0]==="unload") { unloadRemovals++; throw new Error("preload unload cleanup"); }
  return remove.apply(this,args);
};
await import(${JSON.stringify(preload)});
const {DriverSession}=await import(${
          JSON.stringify(
            new URL("../server/hub/drivers/session.ts", import.meta.url).href,
          )
        });
const activity=DriverSession.prototype.activity.call({instance:{id:"office"}});
console.log(JSON.stringify({activity,unloadRegistrations,unloadRemovals}));`,
      ],
      env: { GLOBNOTES_GLOBNOTES_PATH: vault },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, stderr);
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      activity: "sending",
      unloadRegistrations: 0,
      unloadRemovals: 0,
    });
    assert(!stderr.includes("Uncaught"), stderr);
  });
});

for (const replacement of [false, true]) {
  fixtureTest(
    `record channel: held ${
      replacement ? "replacement" : "first"
    } staging is never a readable partial record`,
    async (testScope) => {
      await withRecords(async (f) => {
        if (replacement) publishRecord(f.file, '{"revision":0}');
        const entered = fixtureGate(testScope),
          release = fixtureGate(testScope);
        let writing: Promise<unknown> | undefined = undefined;
        const channel = recordChannel(
          f.directory,
          "value.json",
          schema,
          f.owner,
          {
            io: {
              ...nativeRecordChannelIO,
              publication: {
                ...nativeRecordIO,
                write(file, content) {
                  Deno.writeTextFileSync(file, '{"revision":');
                  entered.resolve();
                  return release.promise.then(() =>
                    Deno.writeTextFile(file, String(content))
                  );
                },
              },
            },
          },
        );
        f.scope.defer(() => writing?.catch(() => undefined));
        f.scope.onCancel(() => release.resolve());
        const value = { revision: 1 };
        writing = Promise.resolve(channel.publish(value));
        await workMilestone(writing, entered.promise, "record staged");
        value.revision = 99;
        assertEquals(
          recordReader(f.directory, "value.json", schema).read()?.value ?? null,
          replacement ? { revision: 0 } : null,
        );
        assertEquals(
          entries(f.directory).filter((name) => name.endsWith(".pending"))
            .length,
          1,
        );
        release.resolve();
        const receipt = await writing;
        assertEquals(receipt, {
          bytes: '{"revision":1}',
          value: { revision: 1 },
        });
        assertEquals(await channel.read(), receipt);
        assertEquals(Deno.readTextFileSync(f.file), '{"revision":1}');
        assertEquals(entries(f.directory), ["value.json"]);
      });
    },
  );
}

for (const winner of [0, 1]) {
  fixtureTest(
    `record channel: two staged exclusive producers have one winner (release ${winner} first)`,
    async (testScope) => {
      await withRecords(async (f) => {
        const gates = [
          fixtureGate(testScope),
          fixtureGate(testScope),
        ];
        const staged = [
          fixtureGate(testScope),
          fixtureGate(testScope),
        ];
        const work: Promise<unknown>[] = [];
        const producers = gates.map((gate, i) =>
          recordChannel(f.directory, "value.json", schema, f.owner, {
            io: {
              ...nativeRecordChannelIO,
              publication: {
                ...nativeRecordIO,
                write(file, content) {
                  nativeRecordIO.write(file, content);
                  staged[i].resolve();
                  return gate.promise;
                },
              },
            },
          })
        );
        f.scope.defer(() => Promise.allSettled(work));
        f.scope.onCancel(() => gates.forEach((gate) => gate.resolve()));
        producers.forEach((producer, i) => {
          const writing = Promise.resolve(
            producer.publish({ revision: i }, { exclusive: true }),
          );
          writing.catch(() => undefined);
          work.push(writing);
        });
        await Promise.all(
          work.map((writing, i) =>
            workMilestone(
              writing,
              staged[i].promise,
              `exclusive producer ${i} staged`,
            )
          ),
        );
        assertEquals(
          Deno.readTextFileSync(
            `${f.directory.path}/${entries(f.directory)[0]}`,
          )
            .startsWith('{"revision":'),
          true,
        );
        assertEquals(await producers[0].read(), null);
        gates[winner].resolve();
        const receipt = await work[winner];
        assertEquals(receipt, {
          bytes: JSON.stringify({ revision: winner }),
          value: { revision: winner },
        });
        gates[1 - winner].resolve();
        await assertRejects(() => work[1 - winner], Deno.errors.AlreadyExists);
        assertEquals(await producers[0].read(), receipt);
        assertEquals(
          Deno.readTextFileSync(f.file),
          JSON.stringify({ revision: winner }),
        );
        assertEquals(entries(f.directory), ["value.json"]);
      });
    },
  );
}

for (const phase of ["write", "rename", "link"] as const) {
  Deno.test(`record channel: failed ${phase} removes only its staging candidate and preserves prior bytes`, async () => {
    await withRecords(async (f) => {
      if (phase !== "link") publishRecord(f.file, '{"revision":7}');
      const failure = new Error(`${phase} sentinel`);
      const publication: RecordIO = {
        ...nativeRecordIO,
        [phase]: (file: string) => {
          if (phase === "write") Deno.writeTextFileSync(file, '{"revision":');
          throw failure;
        },
      };
      const channel = recordChannel(
        f.directory,
        "value.json",
        schema,
        f.owner,
        { io: { ...nativeRecordChannelIO, publication } },
      );
      assertStrictEquals(
        await caught(() =>
          channel.publish({ revision: 8 }, { exclusive: phase === "link" })
        ),
        failure,
      );
      assertEquals(
        entries(f.directory),
        phase === "link" ? [] : ["value.json"],
      );
      assertEquals(
        await channel.read(),
        phase === "link"
          ? null
          : { bytes: '{"revision":7}', value: { revision: 7 } },
      );
    });
  });
}

Deno.test("record channel: exclusive publication never falls back when an IO adapter lacks no-clobber commit", async () => {
  await withRecords(async (f) => {
    const publication = { ...nativeRecordIO, link: undefined };
    const channel = recordChannel(f.directory, "value.json", schema, f.owner, {
      io: { ...nativeRecordChannelIO, publication },
    });
    await assertRejects(
      async () => await channel.publish({ revision: 1 }, { exclusive: true }),
      TypeError,
      "atomic exclusive",
    );
    assertEquals(entries(f.directory), []);
  });
});

for (
  const bytes of ['{"partial":', "null", "true", "[]", '{"revision":"wrong"}']
) {
  Deno.test(`record channel: malformed or wrong object final fails explicitly (${bytes})`, async () => {
    await withRecords(async (f) => {
      Deno.writeTextFileSync(f.file, bytes);
      const channel = recordChannel(f.directory, "value.json", schema, f.owner);
      assertThrows(() =>
        recordReader(f.directory, "value.json", schema).read()
      );
      await assertRejects(() => channel.read());
      await assertRejects(() => channel.wait());
    });
  });
}

Deno.test("record channel: arrays are an explicit schema, not a globally invalid process record", async () => {
  await withRecords(async (f) => {
    const array = arrayRecordSchema("outcomes", (value) => {
      if (value.some((item) => typeof item !== "string")) {
        throw new TypeError("Invalid outcomes");
      }
      return value as string[];
    });
    const channel = recordChannel(f.directory, "value.json", array, f.owner);
    const receipt = await channel.publish(["one", "two"]);
    assertEquals(await channel.read(), receipt);
    assertEquals(receipt.bytes, '["one","two"]');
    assertThrows(
      () => recordReader(f.directory, "value.json", schema).read(),
      TypeError,
      "expected object",
    );
    for (const bytes of ["{}", "null", '[{"partial":']) {
      Deno.writeTextFileSync(f.file, bytes);
      await assertRejects(() => channel.read());
    }
  });
});

for (const beforeExit of [null, '{"revision":1}']) {
  fixtureTest(
    `record channel: an in-flight pre-exit ${
      beforeExit === null ? "miss" : "snapshot"
    } is joined, then a fresh serialized read sees the final record`,
    async (testScope) => {
      await withRecords(async (f) => {
        if (beforeExit !== null) publishRecord(f.file, beforeExit);
        const entered = fixtureGate(testScope),
          release = fixtureGate(testScope);
        let probes = 0, pending = 0, peak = 0;
        const channel = recordChannel(
          f.directory,
          "value.json",
          schema,
          f.owner,
          {
            io: {
              ...nativeRecordChannelIO,
              async read(file, signal) {
                probes++;
                pending++;
                peak = Math.max(peak, pending);
                const bytes = await nativeRecordChannelIO.read(file, signal);
                try {
                  if (probes === 1) {
                    entered.resolve();
                    await release.promise;
                  }
                  return bytes;
                } finally {
                  pending--;
                }
              },
            },
          },
        );
        f.scope.onCancel(() => release.resolve());
        const waiting = channel.wait();
        assertStrictEquals(channel.wait(), waiting);
        await workMilestone(waiting, entered.promise, "pre-exit read started");
        publishRecord(f.file, '{"revision":42}');
        f.exit.resolve({ code: 17 });
        await f.exit.promise;
        release.resolve();
        assertEquals(await waiting, {
          bytes: '{"revision":42}',
          value: { revision: 42 },
        });
        assertEquals({ probes, pending, peak }, {
          probes: 2,
          pending: 0,
          peak: 1,
        });
      });
    },
  );
}

fixtureTest(
  "record channel: owner exit without a final record rejects after its final read",
  async (testScope) => {
    await withRecords(async (f) => {
      const entered = fixtureGate(testScope);
      let probes = 0;
      const channel = recordChannel(
        f.directory,
        "value.json",
        schema,
        f.owner,
        {
          io: {
            ...nativeRecordChannelIO,
            read() {
              probes++;
              entered.resolve();
              return null;
            },
          },
        },
      );
      const waiting = channel.wait();
      const rejected = assertRejects(
        () => waiting,
        Error,
        "actual record owner exited before revision/value.json: 23",
      );
      await workMilestone(waiting, entered.promise, "missing-record probe");
      f.exit.resolve({ code: 23 });
      await rejected;
      assertEquals(probes, 2);
    });
  },
);

fixtureTest(
  "record channel: cancellation joins the pending read and later exit starts no probe",
  async (testScope) => {
    await withRecords(async (f) => {
      const entered = fixtureGate(testScope);
      let probes = 0, pending = 0;
      const channel = recordChannel(
        f.directory,
        "value.json",
        schema,
        f.owner,
        {
          io: {
            ...nativeRecordChannelIO,
            read(_file, signal) {
              probes++;
              pending++;
              return new Promise<null>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
                entered.resolve();
              }).finally(() => pending--);
            },
          },
        },
      );
      const primary = new Error("record cancelled");
      const waiting = channel.wait();
      const rejected = caught(() => waiting);
      await workMilestone(waiting, entered.promise, "pending record read");
      channel.cancel(primary);
      assertStrictEquals(await rejected, primary);
      assertEquals(pending, 0);
      f.exit.resolve({ code: 0 });
      await f.exit.promise;
      assertEquals(probes, 1);
      await assertRejects(() => channel.read(), Error, "record cancelled");
    });
  },
);

fixtureTest(
  "record observer: owner exit after cancellation never invokes the supplied probe",
  async (testScope) => {
    await withRecords(async (f) => {
      const controller = new AbortController();
      const entered = fixtureGate(testScope);
      let probes = 0;
      const waiting = waitForRecord(
        f.directory.path,
        "cancelled observer",
        () => {
          probes++;
          entered.resolve();
          return null;
        },
        [f.owner],
        controller.signal,
      );
      const rejected = assertRejects(
        () => waiting,
        Error,
        "observer cancelled",
      );
      await workMilestone(waiting, entered.promise, "initial observer read");
      controller.abort(new Error("observer cancelled"));
      await rejected;
      f.exit.resolve({ code: 0 });
      await f.exit.promise;
      assertEquals(probes, 1);
    });
  },
);

Deno.test("record channel: a completed observation starts no later read after owner exit", async () => {
  let probes = 0;
  const exit = Promise.withResolvers<{ code: number }>();
  await withRecords(async (f) => {
    publishRecord(f.file, '{"revision":1}');
    const channel = recordChannel(f.directory, "value.json", schema, {
      label: "late owner",
      exit: exit.promise,
    }, {
      io: {
        ...nativeRecordChannelIO,
        read(file, signal) {
          probes++;
          return nativeRecordChannelIO.read(file, signal);
        },
      },
    });
    assertEquals((await channel.wait()).value, { revision: 1 });
  });
  exit.resolve({ code: 0 });
  await exit.promise;
  assertEquals(probes, 1);
});

for (const retired of ["cancel", "exit"] as const) {
  fixtureTest(
    `record channel: ${retired} during staging fences the actual publication boundary`,
    async (testScope) => {
      await withRecords(async (f) => {
        const release = fixtureGate(testScope),
          entered = fixtureGate(testScope);
        let writing: Promise<unknown> | undefined = undefined;
        const channel = recordChannel(
          f.directory,
          "value.json",
          schema,
          f.owner,
          {
            io: {
              ...nativeRecordChannelIO,
              publication: {
                ...nativeRecordIO,
                write(file, content) {
                  nativeRecordIO.write(file, content);
                  entered.resolve();
                  return release.promise;
                },
              },
            },
          },
        );
        f.scope.defer(() => writing?.catch(() => undefined));
        f.scope.onCancel(() => release.resolve());
        writing = Promise.resolve(channel.publish({ revision: 1 }));
        const rejected = caught(() => writing);
        await workMilestone(
          writing,
          entered.promise,
          "retiring staged publisher",
        );
        if (retired === "cancel") {
          channel.cancel(new Error("publisher cancelled"));
        } else {
          f.exit.resolve({ code: 17 });
          await f.exit.promise;
        }
        release.resolve();
        const error = await rejected;
        assert(error instanceof Error);
        assert(
          error.message.includes(
            retired === "cancel"
              ? "publisher cancelled"
              : "exited before record publication",
          ),
        );
        assertEquals(entries(f.directory), []);
      });
    },
  );
}

Deno.test("record channel: required owners and issued directory/schema custody reject forged or borrowed writes", async () => {
  await withRecords((f) => {
    assertThrows(
      () => recordChannel({ ...f.directory }, "value.json", schema, f.owner),
      TypeError,
      "not issued",
    );
    assertThrows(
      () =>
        recordChannel(
          f.directory,
          "value.json",
          { name: "fake" } as RecordSchema<RecordValue>,
          f.owner,
        ),
      TypeError,
      "not issued",
    );
    assertThrows(
      () =>
        recordChannel(f.directory, "value.json", schema, {} as ProcessOwner),
      TypeError,
      "actual owner",
    );
    assertThrows(
      () => recordReader(f.directory, "../elsewhere", schema),
      TypeError,
      "single path",
    );
    const readerRoot = openRecordDirectory(f.scope, f.directory.path);
    const borrowed = recordChannel(readerRoot, "value.json", schema, f.owner);
    assertThrows(
      () => borrowed.publish({ revision: 1 }),
      TypeError,
      "read-only",
    );
    assertEquals(entries(f.directory), []);
    function checkedCaller() {
      // @ts-expect-error a string is not owned record-directory custody
      recordChannel(f.directory.path, "value.json", schema, f.owner);
      // @ts-expect-error a channel requires the real process/operation owner
      recordChannel(f.directory, "value.json", schema);
      const channel = recordChannel(f.directory, "value.json", schema, f.owner);
      // @ts-expect-error callers cannot substitute a path and arbitrary probe
      channel.wait("different", () => null);
    }
    assertEquals(typeof checkedCaller, "function");
  });
});

Deno.test("record channel: already-cancelled ownership never starts its first probe", async () => {
  await withRecords(async (f) => {
    const controller = new AbortController(),
      primary = new Error("already cancelled");
    controller.abort(primary);
    let probes = 0;
    const channel = recordChannel(f.directory, "value.json", schema, f.owner, {
      signal: controller.signal,
      io: {
        ...nativeRecordChannelIO,
        read() {
          probes++;
          return null;
        },
      },
    });
    assertStrictEquals(await caught(() => channel.wait()), primary);
    assertStrictEquals(
      await caught(() => channel.publish({ revision: 1 })),
      primary,
    );
    assertEquals(probes, 0);
  });
});

fixtureTest(
  "record channel: enclosing fixture cancellation drains its read before deleting its root",
  async (testScope) => {
    let root = "", scope!: FixtureScope, activeReads = 0;
    let waiting: Promise<unknown> | undefined;
    await withRecords(async (f) => {
      root = f.directory.path;
      scope = f.scope;
      const entered = fixtureGate(testScope);
      const channel = recordChannel(
        f.directory,
        "value.json",
        schema,
        f.owner,
        {
          io: {
            ...nativeRecordChannelIO,
            read(_file, signal) {
              activeReads++;
              return new Promise<null>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
                entered.resolve();
              }).finally(() => activeReads--);
            },
          },
        },
      );
      waiting = channel.wait();
      waiting.catch(() => undefined);
      await workMilestone(
        waiting,
        entered.promise,
        "scope-owned active record read",
      );
    });
    await assertRejects(() => waiting!, Error, "retired");
    assertEquals(activeReads, 0);
    assertEquals(scope.size, 0);
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  },
);

for (const operation of ["read", "publish"] as const) {
  fixtureTest(
    `record channel: scope disposal joins a direct ${operation} before root deletion`,
    async (testScope) => {
      const entered = fixtureGate(testScope);
      const cancelled = fixtureGate(testScope);
      const release = fixtureGate(testScope);
      let root = "", settled = false, workSettled = false;
      let work: Promise<unknown> | undefined;
      const closing = withRecords(async (f) => {
        root = f.directory.path;
        f.scope.defer(() =>
          assert(
            workSettled,
            `direct ${operation} outlived its channel disposer`,
          )
        );
        const channel = recordChannel(
          f.directory,
          "value.json",
          schema,
          f.owner,
          {
            io: {
              ...nativeRecordChannelIO,
              async read(_file, signal) {
                signal.addEventListener("abort", () => cancelled.resolve(), {
                  once: true,
                });
                entered.resolve();
                await release.promise;
                signal.throwIfAborted();
                return null;
              },
              publication: {
                ...nativeRecordIO,
                async write(file, content) {
                  nativeRecordIO.write(file, content);
                  entered.resolve();
                  await release.promise;
                },
              },
            },
          },
        );
        if (operation === "publish") {
          channel.signal.addEventListener("abort", () => cancelled.resolve(), {
            once: true,
          });
        }
        work = Promise.resolve(
          operation === "read"
            ? channel.read()
            : channel.publish({ revision: 1 }),
        ).finally(() => {
          workSettled = true;
        });
        work.catch(() => undefined);
        await workMilestone(
          work,
          entered.promise,
          `direct ${operation} entered`,
        );
      }).then(() => {
        settled = true;
      });
      await fixtureScope(async (checking) => {
        checking.onCancel(() => release.resolve());
        checking.defer(() => work?.catch(() => undefined));
        checking.defer(() => closing);
        await workMilestone(
          closing,
          cancelled.promise,
          `direct ${operation} cancelled`,
        );
        assertEquals(settled, false);
        assert(Deno.statSync(root).isDirectory);
      });
      await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
    },
  );
}

fixtureTest(
  "Sync control: the actual preload consumes only whole validated snapshots",
  async (testScope) => {
    await fixtureScope(async (scope) => {
      const vault = (await scope.acquire(
        () => Deno.makeTempDir({ prefix: "sync-record-pilot-" }),
        (root) => Deno.remove(root, { recursive: true }),
      )).value;
      const state = `${vault}/.globnotes`;
      await Deno.mkdir(state);
      const root = await createSyncStatusDirectory(scope, state);
      const exit = Promise.withResolvers<{ code: number }>();
      scope.defer(() => exit.resolve({ code: 0 }));
      const control = syncStatusChannel(root, {
        label: "Sync fixture operation",
        exit: exit.promise,
      });
      const observe = async () => {
        const preload =
          new URL("./helpers/sync_status_preload.ts", import.meta.url).href;
        const session =
          new URL("../server/hub/drivers/session.ts", import.meta.url).href;
        const result = await command(DENO, {
          args: [
            "eval",
            `import ${JSON.stringify(preload)}; import {DriverSession} from ${
              JSON.stringify(session)
            }; try { console.log(JSON.stringify({activity:DriverSession.prototype.activity.call({instance:{id:"office"}})})); } catch(error) { console.log(JSON.stringify({error:error.name})); }`,
          ],
          env: { GLOBNOTES_GLOBNOTES_PATH: vault },
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(
          result.success,
          true,
          new TextDecoder().decode(result.stderr),
        );
        return JSON.parse(new TextDecoder().decode(result.stdout));
      };
      await control.publish({ activities: { office: "sending" } });
      assertEquals(await observe(), { activity: "sending" });
      const release = fixtureGate(testScope),
        entered = fixtureGate(testScope);
      let writing: Promise<unknown> | undefined = undefined;
      const held = recordChannel(
        root,
        "status.json",
        objectRecordSchema("Sync held control", (value) => value),
        { label: "Sync fixture operation", exit: exit.promise },
        {
          io: {
            ...nativeRecordChannelIO,
            publication: {
              ...nativeRecordIO,
              write(file, content) {
                Deno.writeTextFileSync(file, '{"activities":');
                entered.resolve();
                return release.promise.then(() =>
                  Deno.writeTextFile(file, String(content))
                );
              },
            },
          },
        },
      );
      scope.defer(() => writing?.catch(() => undefined));
      scope.onCancel(() => release.resolve());
      writing = Promise.resolve(
        held.publish({ activities: { office: "receiving" } }),
      );
      await workMilestone(writing, entered.promise, "Sync producer staged");
      assertEquals(await observe(), { activity: "sending" });
      release.resolve();
      await writing;
      assertEquals(await observe(), { activity: "receiving" });
      assertEquals(syncStatusReader(scope, state).read()?.value, {
        activities: { office: "receiving" },
      });
      for (
        const text of [
          '{"activities":',
          "[]",
          '{"activities":{"office":"invalid"}}',
        ]
      ) {
        Deno.writeTextFileSync(`${root.path}/status.json`, text);
        const observation = await observe();
        assert(["SyntaxError", "TypeError"].includes(observation.error));
      }
    });
  },
);
