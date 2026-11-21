// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  type DriverCycleStatus,
  DriverSupervisor,
} from "../server/hub/drivers/supervisor.ts";
import {
  type DriverInstance,
  DriverPeers,
} from "../server/hub/drivers/peers.ts";
import { OwnershipError } from "../shared/ownership.js";
import { bootServer, type TestServer } from "./helpers/boot.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import {
  bindDriverStartup,
  createDriverStartupDirectory,
} from "./helpers/driver_startup.ts";
import {
  driverStartupSchema,
  type DriverStartupSnapshot,
  startupFailurePrefix,
} from "./helpers/driver_startup_schema.ts";
import {
  publishDriverStartup,
  reportDriverStartupFailure,
} from "./helpers/driver_startup_protocol.ts";
import { observeDriverStartup } from "./helpers/driver_startup_preload.ts";
import { storageServerFixture } from "./helpers/driver_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import {
  recordReader,
  type RecordSnapshot,
} from "./helpers/owned_record_channel.ts";
import { publishRecord } from "./helpers/process_records.ts";
import { done, pending, ReadinessError, waitUntil } from "./helpers/wait.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

const snapshot = (
  changes: Partial<DriverStartupSnapshot> = {},
): DriverStartupSnapshot => ({
  pid: 123,
  owner: "123:initial",
  sequence: 1,
  pending: true,
  states: { driver: "starting" },
  failure: null,
  ...changes,
});
function withStartup(
  body: (f: {
    publish: (changes?: Partial<DriverStartupSnapshot>) => void;
    corrupt: (bytes: string) => void;
    bind: (
      options?: Parameters<typeof bindDriverStartup>[4],
    ) => ReturnType<typeof bindDriverStartup>;
    read: () => RecordSnapshot<DriverStartupSnapshot> | null;
    replace: () => void;
    exit: () => void;
    server: TestServer;
  }) => void | Promise<void>,
) {
  return fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "driver-phase-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const exited = Promise.withResolvers<Deno.CommandStatus>();
    let status: Deno.CommandStatus | null = null;
    const server = {
      pid: 123,
      exited: exited.promise,
      status: () => status,
    } as TestServer;
    let current = server;
    await body({
      server,
      publish: (changes) =>
        publishDriverStartup(directory.path, snapshot(changes)),
      corrupt: (bytes) =>
        publishRecord(`${directory.path}/initial.json`, bytes),
      bind: (options) =>
        bindDriverStartup(scope, directory, server, () => current, options),
      read: () =>
        recordReader(directory, "initial.json", driverStartupSchema).read(),
      replace: () => {
        current = { ...server, pid: 456 };
      },
      exit: () => {
        status = { success: false, code: 17, signal: null };
        exited.resolve(status);
      },
    });
  });
}

Deno.test("driver phase: explicit Active and Paused require same initial cycle completion", async () => {
  for (const expected of ["active", "paused"] as const) {
    await withStartup(async (f) => {
      f.publish();
      const bound = f.bind();
      f.publish({ pending: false, states: { driver: expected } });
      const result = await bound.initialDriver("driver", expected);
      assertEquals(result, { pid: 123, owner: "123:initial", state: expected });
      await assertRejects(
        async () =>
          await bound.initialDriver("driver", undefined as unknown as "active"),
        TypeError,
        "Initial driver requires explicit active or paused state",
      );
    });
  }
});

Deno.test("driver phase PR107: pending failed projection is not a settled mismatch", () =>
  withStartup(async (f) => {
    f.publish({ states: { driver: "failed" } });
    let reads = 0;
    const bound = f.bind({
      read() {
        const value = f.read();
        // The actual first completion read sees Failed while still draining.
        if (++reads === 2) {
          f.publish({ pending: false, states: { driver: "active" } });
        }
        return value;
      },
    });
    const observing = bound.initialDriver("driver", "active");
    assertEquals(await bounded(observing, "pending failure drains"), {
      pid: 123,
      owner: "123:initial",
      state: "active",
    });
    assertEquals(reads >= 3, true);
  }));

Deno.test("driver phase PR107: missing boot record cannot admit a replacement cycle", () =>
  withStartup(async (f) => {
    const bound = f.bind();
    f.publish({
      owner: "123:2",
      sequence: 2,
      pending: false,
      states: { driver: "active" },
    });
    await assertRejects(
      () => bound.initialDriver("driver", "active"),
      Error,
      "driver 'driver' initial cycle: cycle owner replaced",
    );
  }));

Deno.test("driver phase PR107: body lock is cancelled without awaiting stream cancellation", async () => {
  await fixtureScope(async (scope) => {
    const pulled = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    let held = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled.resolve();
      },
      cancel() {
        cancelled.resolve();
        return cancellation.promise;
      },
    }, { highWaterMark: 0 });
    const f = (await scope.acquire(() =>
      storageServerFixture([], {
        requestFetch(input, init) {
          return held
            ? Promise.resolve(new Response(body))
            : fetch(input, init);
        },
      }), (f) => f.close())).value;
    held = true;
    const request = f.call("drivers");
    request.catch(() => {});
    try {
      await bounded(
        workMilestone(request, pulled.promise, "locked body read"),
        "body acquired",
      );
      const before = [...f.packets];
      await bounded(f.close(), "close ignores body cancellation completion");
      await bounded(cancelled.promise, "locked reader receives cancellation");
      await assertRejects(
        () => request,
        OwnershipError,
        "Fixture scope retired",
      );
      assertEquals(f.packets, before);
      assertEquals(body.locked, false);
    } finally {
      cancellation.resolve();
      await f.close();
    }
  });
});

Deno.test("driver phase PR107: overlapping replacement never boots two live servers", async () => {
  await fixtureScope(async (scope) => {
    const f = (await scope.acquire(() =>
      storageServerFixture([]), (f) => f.close())).value;
    const first = f.restart();
    const second = f.restart();
    first.catch(() => {});
    second.catch(() => {});
    const a = await first;
    const b = await second;
    assertEquals([a.server.status()?.success, b.server.status()], [true, null]);
    assertStrictEquals(f.server(), b.server);
    const response = await fetch(`${b.server.baseUrl}/_/api/health`);
    assertEquals(response.status, 200);
    await response.body?.cancel();
  });
});

/** A real status producer with only its persistence effect stubbed. The preload
 * must capture observeStatus synchronously, not read a fake async HTTP view. */
const preloadStatuses = new WeakMap<
  DriverPeers,
  { generation: object; states: Map<string, string> }
>();
function preloadPeers(
  instances = () =>
    [{ id: "driver", plugin: "plugin", revision: 1 }] as DriverInstance[],
) {
  const peers = new DriverPeers(
    {
      db: { prepare: () => ({ run() {} }) },
    } as unknown as ConstructorParameters<typeof DriverPeers>[0],
  );
  peers.instances = instances;
  const state = {
    generation: Object.freeze({}),
    states: new Map<string, string>(),
  };
  preloadStatuses.set(peers, state);
  const observe = peers.observeStatus;
  peers.observeStatus = function (peer, status, enabled) {
    observe.call(this, peer, status, enabled);
    state.states.set(peer, status);
  };
  return peers;
}
function preloadSupervisor(): DriverSupervisor {
  return Object.assign(Object.create(DriverSupervisor.prototype), {
    subscribe: () => () => {},
    statusSnapshot(this: DriverSupervisor): readonly DriverCycleStatus[] {
      const captured = preloadStatuses.get(this.peers);
      return this.peers.instances().map((peer) => ({
        peer: peer.id,
        generation: captured!.generation,
        cycle: 1,
        status: captured!.states.get(peer.id)!,
        result: null,
      }));
    },
  });
}

Deno.test("driver phase PR107: owned body decoding preserves bytes and read error identity", async () => {
  await fixtureScope(async (scope) => {
    let response: Response | undefined;
    const f = (await scope.acquire(() =>
      storageServerFixture([], {
        requestFetch(input, init) {
          return response ? Promise.resolve(response) : fetch(input, init);
        },
      }), (f) => f.close())).value;
    const bytes = new TextEncoder().encode('{"label":"caf\u00e9"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split in the middle of the multibyte character, not just JSON tokens.
        const split = bytes.indexOf(0xc3) + 1;
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    response = new Response(body);
    assertEquals(await f.call("body-contract"), { label: "caf\u00e9" });
    assertEquals(body.locked, false);
    response = new Response(null, { status: 204 });
    assertEquals(await f.call("body-contract"), null);
    const before = [...f.packets];
    const reason = Error("body read failed");
    const failedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(reason);
      },
    });
    response = new Response(failedBody);
    assertStrictEquals(
      await assertRejects(
        () => f.call("body-contract"),
        Error,
        "body read failed",
      ),
      reason,
    );
    assertEquals(failedBody.locked, false);
    assertEquals(f.packets, before);
  });
});

Deno.test("driver phase PR107: close cancels queued replacements before another boot", async () => {
  await fixtureScope(async (scope) => {
    const f = (await scope.acquire(() =>
      storageServerFixture([]), (f) => f.close())).value;
    const original = f.server();
    const first = f.restart(), second = f.restart();
    first.catch(() => {});
    second.catch(() => {});
    await bounded(f.close(), "queued replacement retirement");
    const a = await assertRejects(
      () =>
        first,
      OwnershipError,
      "Fixture scope retired",
    );
    const b = await assertRejects(
      () => second,
      OwnershipError,
      "Fixture scope retired",
    );
    assertStrictEquals(a, b);
    assertEquals(original.status()?.success, true);
    assertThrows(
      () => f.server(),
      OwnershipError,
      "Owner is retired",
    );
  });
});

Deno.test("driver phase: replaced cycle cannot supply expected state", () =>
  withStartup(async (f) => {
    f.publish();
    const bound = f.bind();
    f.publish({
      owner: "123:replacement",
      pending: false,
      states: { driver: "active" },
    });
    await assertRejects(
      () => bound.initialDriver("driver", "active"),
      Error,
      "driver 'driver' initial cycle: cycle owner replaced",
    );
  }));

Deno.test("driver phase review: a captured terminal projection cannot hide a newer failure", () =>
  withStartup(async (f) => {
    f.publish({ pending: false, states: { driver: "active" } });
    const bound = f.bind();
    f.publish({
      pending: false,
      states: { driver: "active" },
      failure: "late failure",
    });
    await assertRejects(
      () => bound.initialDriver("driver", "active"),
      Error,
      "driver 'driver' initial cycle: late failure",
    );
  }));

Deno.test("driver phase review: an empty rejection remains terminal instead of success", () =>
  withStartup(async (f) => {
    f.publish({ pending: false, states: { driver: "active" }, failure: "" });
    await assertRejects(
      () => f.bind().initialDriver("driver", "active"),
      Error,
      "driver 'driver' initial cycle: ",
    );
  }));

Deno.test("driver phase review: server identity ports are captured once before observation", () =>
  withStartup(async (f) => {
    f.publish();
    const bound = f.bind();
    Object.defineProperties(f.server, {
      pid: {
        get() {
          throw Error("pid reread");
        },
      },
      exited: {
        get() {
          throw Error("exit reread");
        },
      },
    });
    f.publish({ pending: false, states: { driver: "active" } });
    assertEquals(await bound.initialDriver("driver", "active"), {
      pid: 123,
      owner: "123:initial",
      state: "active",
    });
  }));

Deno.test("driver phase review: admission and completion share one captured exit subscription", () =>
  withStartup(async (f) => {
    let reads = 0;
    const exited = f.server.exited;
    const then = exited.then;
    Object.defineProperty(exited, "then", {
      get() {
        reads++;
        if (reads > 1) throw Error("exit subscription reread");
        return then;
      },
    });
    const observing = f.bind().initialDriver("driver", "active");
    f.publish({ pending: false, states: { driver: "active" } });
    assertEquals(await bounded(observing, "initial cycle admission"), {
      pid: 123,
      owner: "123:initial",
      state: "active",
    });
    assertEquals(reads, 1);
  }));

Deno.test("driver phase review: fixture inputs are captured once and repeated close joins", async () => {
  await fixtureScope(async (scope) => {
    const reads = { native: 0, observedTime: 0 };
    const f = (await scope.acquire(() =>
      storageServerFixture([], {
        get native() {
          reads.native++;
          return false;
        },
        get observedTime() {
          reads.observedTime++;
          return 42;
        },
      }), (f) => f.close())).value;
    assertEquals(reads, { native: 1, observedTime: 1 });
    assertEquals(f.clock!.now(), 42);
    const closing = f.close();
    assertStrictEquals(f.close(), closing);
    await closing;
    assertThrows(() => f.server(), OwnershipError, "Owner is retired");
  });
});

Deno.test("driver phase review: preload records thrown undefined and retires pending publications", async () => {
  await fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "driver-preload-review-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const work = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = function () {
      this.peers.observeStatus("driver", "active", true);
      return work.promise;
    };
    const listeners = new Set<() => void>();
    const supervisor = Object.assign(
      preloadSupervisor(),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: preloadPeers(),
        view: () =>
          Promise.resolve({ instances: [{ id: "driver", status: "active" }] }),
        subscribe: (notify: () => void) => {
          listeners.add(notify);
          return () => {
            listeners.delete(notify);
          };
        },
      },
    ) as DriverSupervisor;
    const restore = observeDriverStartup(directory.path);
    scope.defer(restore);
    assertStrictEquals(supervisor.reconcile(), work.promise);
    work.reject(undefined);
    let rejected = false;
    try {
      await work.promise;
    } catch (error) {
      rejected = true;
      assertStrictEquals(error, undefined);
    }
    assertEquals(rejected, true);
    const reader = recordReader(directory, "initial.json", driverStartupSchema);
    await waitUntil(
      () =>
        reader.read()?.value.pending === false
          ? done()
          : pending("terminal publication"),
      { label: "undefined failure publication" },
    );
    assertEquals(reader.read()!.value, {
      pid: Deno.pid,
      owner: `${Deno.pid}:1`,
      sequence: 1,
      pending: false,
      states: { driver: "active" },
      failure: "undefined",
    });
    await restore();
    const nextWork = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = function () {
      this.peers.observeStatus("driver", "active", true);
      return nextWork.promise;
    };
    const retire = observeDriverStartup(directory.path);
    scope.defer(retire);
    supervisor.reconcile();
    await bounded(Promise.resolve(retire()), "retire unresolved initial cycle");
    assertEquals([...listeners], []);
    const retained = reader.read()!.value;
    nextWork.resolve();
    await nextWork.promise;
    assertEquals(reader.read()!.value, retained);
  });
});

Deno.test("driver phase review: cancellation settles admitted HTTP even when IO ignores abort", async () => {
  await fixtureScope(async (scope) => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    let held = false;
    const f = (await scope.acquire(
      () =>
        storageServerFixture([], {
          requestFetch(input, init) {
            if (!held) return fetch(input, init);
            entered.resolve();
            return response.promise;
          },
        }),
      (f) => f.close(),
    )).value;
    held = true;
    await f.admit((signal) => {
      signal.addEventListener(
        "abort",
        (event) => event.stopImmediatePropagation(),
        {
          once: true,
        },
      );
    });
    const request = f.call("drivers");
    request.catch(() => {});
    let closing: Promise<void> | undefined;
    try {
      await bounded(
        workMilestone(request, entered.promise, "held fixture HTTP"),
        "HTTP admission",
      );
      const packets = [...f.packets];
      closing = f.close();
      assertStrictEquals(f.close(), closing);
      await bounded(closing, "HTTP cancellation before fixture drain");
      await assertRejects(
        () => request,
        OwnershipError,
        "Fixture scope retired",
      );
      assertEquals(f.packets, packets);
    } finally {
      // Rescue the intentionally uncooperative IO before joining a broken close.
      response.resolve(new Response("{}", { status: 200 }));
      await request.catch(() => {});
      await closing;
    }
  });
});

Deno.test("driver phase: admitted work installs no competing readiness timer", () =>
  withStartup(async (f) => {
    f.publish({ states: { driver: "active" } });
    const bound = f.bind();
    const original = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (() => {
        throw Error("competing driver work timer");
      }) as unknown as typeof setTimeout;
      const completion = bound.initialDriver("driver", "active");
      f.publish({ pending: false, states: { driver: "active" } });
      assertEquals(await completion, {
        pid: 123,
        owner: "123:initial",
        state: "active",
      });
    } finally {
      globalThis.setTimeout = original;
    }
  }));

Deno.test("driver phase main2: HTTP observation failures reject with exact identity, never outcomes", async () => {
  await fixtureScope(async (scope) => {
    let failing = false;
    let reason: unknown;
    const f = (await scope.acquire(() =>
      storageServerFixture([], {
        requestFetch(input, init) {
          return failing ? Promise.reject(reason) : fetch(input, init);
        },
      }), (f) => f.close())).value;
    const before = [...f.packets];
    failing = true;
    for (
      const failure of [Error("HTTP observation failed"), NaN, -0, undefined]
    ) {
      reason = failure;
      const request = f.call("drivers");
      if (failure instanceof Error) {
        assertStrictEquals(
          await assertRejects(() => request, Error, "HTTP observation failed"),
          failure,
        );
      } else {
        let rejected = false;
        try {
          await request;
        } catch (error) {
          rejected = true;
          assertStrictEquals(error, failure);
        }
        assertEquals(rejected, true);
      }
      assertEquals(f.packets, before);
    }
  });
});

Deno.test("driver phase main2: projection failure fails observation without replacing product completion", async () => {
  await fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "driver-observation-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const product = Promise.resolve();
    const failure = new AbortController();
    DriverSupervisor.prototype.reconcile = () => product;
    const supervisor = Object.assign(
      preloadSupervisor(),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: preloadPeers(() => {
          throw Error("projection failed");
        }),
        subscribe: () => () => {},
      },
    ) as DriverSupervisor;
    scope.defer(
      observeDriverStartup(directory.path, {
        report: (error) => failure.abort(error),
      }),
    );
    assertStrictEquals(supervisor.reconcile(), product);
    await product;
    const exited = Promise.withResolvers<Deno.CommandStatus>();
    const server = {
      pid: Deno.pid,
      exited: exited.promise,
      status: () => null,
    } as TestServer;
    await assertRejects(
      () =>
        bindDriverStartup(scope, directory, server, () => server, {
          signal: failure.signal,
        }).initialDriver(
          "driver",
          "active",
        ),
      Error,
      "projection failed",
    );
  });
});

for (const phase of ["initial", "terminal"] as const) {
  Deno.test(`driver phase PR107: ${phase} publication failure preserves product and fails fixture`, async () => {
    await fixtureScope(async (scope) => {
      const parent = await scope.acquire(
        () => Deno.makeTempDir({ prefix: "preload-publication-" }),
        (root) => Deno.remove(root, { recursive: true }),
      );
      const directory = await createDriverStartupDirectory(scope, parent.value);
      const original = DriverSupervisor.prototype.reconcile;
      scope.defer(() => {
        DriverSupervisor.prototype.reconcile = original;
      });
      const work = Promise.withResolvers<void>();
      let calls = 0;
      DriverSupervisor.prototype.reconcile = function () {
        calls++;
        this.peers.observeStatus("driver", "active", true);
        return work.promise;
      };
      const supervisor = Object.assign(
        preloadSupervisor(),
        {
          adapters: {
            lifecycle: { epoch: 1 },
            plugins: { driverOwner: () => ({ epoch: 1 }) },
          },
          peers: preloadPeers(),
          subscribe: () => () => {},
        },
      ) as DriverSupervisor;
      const error = Error(`${phase} record write failed`);
      const reports: unknown[] = [];
      const failure = new AbortController();
      scope.defer(observeDriverStartup(directory.path, {
        publish(directory, snapshot) {
          assertEquals(calls, 1);
          if (snapshot.pending === (phase === "initial")) throw error;
          publishDriverStartup(directory, snapshot);
        },
        report(error) {
          reports.push(error);
          failure.abort(error);
        },
      }));
      assertStrictEquals(supervisor.reconcile(), work.promise);
      assertEquals(calls, 1);
      const exited = Promise.withResolvers<Deno.CommandStatus>();
      const server = {
        pid: Deno.pid,
        exited: exited.promise,
        status: () => null,
      } as TestServer;
      const observing = bindDriverStartup(
        scope,
        directory,
        server,
        () => server,
        { signal: failure.signal },
      ).initialDriver("driver", "active");
      observing.catch(() => {});
      work.resolve();
      await work.promise;
      assertStrictEquals(
        await assertRejects(
          () => bounded(observing, "publication fault transport"),
          Error,
          error.message,
        ),
        error,
      );
      assertEquals(reports.length, 1);
      assertStrictEquals(reports[0], error);
    });
  });
}

Deno.test("driver phase PR107: observer failures cannot replace an original synchronous throw", async () => {
  await fixtureScope((scope) => {
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const productError = Error("original reconcile throw");
    let calls = 0;
    DriverSupervisor.prototype.reconcile = () => {
      calls++;
      throw productError;
    };
    const supervisor = Object.assign(
      preloadSupervisor(),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: preloadPeers(() => []),
      },
    ) as DriverSupervisor;
    const publications: DriverStartupSnapshot[] = [];
    let reports = 0;
    scope.defer(observeDriverStartup("unused", {
      publish(_directory, snapshot) {
        publications.push(snapshot);
        throw Error("publication failed");
      },
      report() {
        reports++;
        throw Error("report transport failed");
      },
    }));
    assertStrictEquals(
      assertThrows(
        () => supervisor.reconcile(),
        Error,
        "original reconcile throw",
      ),
      productError,
    );
    assertEquals([calls, reports, publications], [1, 1, [{
      pid: Deno.pid,
      owner: `${Deno.pid}:1`,
      sequence: 1,
      pending: false,
      states: {},
      failure: "Error: original reconcile throw",
    }]]);
  });
});

Deno.test("driver phase PR107: terminal status is copied at settlement before later recovery", async () => {
  await fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "preload-terminal-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const work = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = function () {
      this.peers.observeStatus("driver", "starting", true);
      return work.promise;
    };
    const catalog = Promise.withResolvers<void>();
    let viewReads = 0;
    let live = "failed";
    const peers = preloadPeers();
    const supervisor = Object.assign(
      preloadSupervisor(),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers,
        subscribe: () => () => {},
        async view() {
          viewReads++;
          await catalog.promise;
          return { instances: [{ id: "driver", status: live }] };
        },
      },
    ) as DriverSupervisor;
    scope.defer(observeDriverStartup(directory.path));
    assertStrictEquals(supervisor.reconcile(), work.promise);
    peers.observeStatus("driver", "failed", true);
    const recovery = work.promise.then(() => {
      live = "active";
      peers.observeStatus("driver", live, true);
      catalog.resolve();
    });
    work.resolve();
    await recovery;
    assertEquals(
      recordReader(directory, "initial.json", driverStartupSchema).read()!
        .value,
      {
        pid: Deno.pid,
        owner: `${Deno.pid}:1`,
        sequence: 1,
        pending: false,
        states: { driver: "failed" },
        failure: null,
      },
    );
    assertEquals(viewReads, 0);
  });
});

Deno.test("driver phase PR107: real child reports record filesystem failure through captured pipe", async () => {
  await fixtureScope(async (scope) => {
    const children: TestServer[] = [];
    const ready = Promise.withResolvers<void>(),
      framed = Promise.withResolvers<void>();
    let deliver: (() => void) | undefined;
    let attempts = 0;
    const f = (await scope.acquire(() =>
      storageServerFixture([], {
        async serverBoot(inputs, options) {
          const attempt = ++attempts;
          if (attempt === 3) {
            assertEquals(children.map((child) => child.status()?.success), [
              true,
              true,
            ]);
            await Deno.remove(record);
          }
          let stderr = "";
          const consume = options!.observeOutput!;
          const child = await bootServer(inputs, {
            ...options,
            observeOutput(name, chunk) {
              if (attempt !== 2 || name !== "stderr") {
                consume(name, chunk);
                return;
              }
              stderr += chunk;
              if (
                stderr.includes(startupFailurePrefix) && stderr.endsWith("\n")
              ) framed.resolve();
              deliver = () => consume("stderr", stderr);
            },
          });
          children.push(child);
          if (attempt === 2) ready.resolve();
          return child;
        },
      }), (f) => f.close())).value;
    const record = `${f.statePath}/driver-startup/initial.json`;
    await f.admit(async () => {
      await Deno.remove(record);
      await Deno.mkdir(record);
    });
    const restarting = f.restart();
    restarting.catch(() => {});
    let settled = false;
    restarting.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await bounded(
      workMilestone(restarting, ready.promise, "second child transport ready"),
      "health before pipe delivery",
    );
    await bounded(
      workMilestone(
        restarting,
        framed.promise,
        "complete stderr frame captured",
      ),
      "failure frame captured",
    );
    assertEquals([settled, children[1].status()], [false, null]);
    const queued = f.restart();
    queued.catch(() => {});
    deliver!();
    await assertRejects(
      () => bounded(restarting, "independent publication error pipe"),
      Error,
      "driver startup observation failed:",
    );
    const replacement = await bounded(
      queued,
      "queued restart after rejected child shutdown",
    );
    assertEquals(children.map((child) => child.status()?.success ?? null), [
      true,
      true,
      null,
    ]);
    assertStrictEquals(replacement.server, children[2]);
    assertStrictEquals(f.server(), children[2]);
  });
});

Deno.test("driver phase round2: partial failure-frame writes retain every byte and newline", () => {
  const chunks: Uint8Array[] = [];
  let reads = 0;
  const writer = {
    get writeSync() {
      reads++;
      return function (this: unknown, bytes: Uint8Array) {
        assertStrictEquals(this, writer);
        const written = Math.min(3, bytes.length);
        chunks.push(bytes.slice(0, written));
        return written;
      };
    },
  };
  reportDriverStartupFailure(Error("split \u00e9 frame"), writer);
  const expected = new TextEncoder().encode(
    startupFailurePrefix +
      JSON.stringify({ failure: "Error: split \u00e9 frame" }) + "\n",
  );
  assertEquals(
    chunks,
    Array.from(
      { length: Math.ceil(expected.length / 3) },
      (_, i) => expected.slice(i * 3, i * 3 + 3),
    ),
  );
  assertEquals(reads, 1);
  assertThrows(
    () => reportDriverStartupFailure("zero", { writeSync: () => 0 }),
    Error,
    "Driver startup failure transport made no progress",
  );
  const cause = Error("pipe closed");
  assertStrictEquals(
    assertThrows(
      () =>
        reportDriverStartupFailure("closed", {
          writeSync() {
            throw cause;
          },
        }),
      Error,
      "pipe closed",
    ),
    cause,
  );
});

for (const superseded of [false, true]) {
  Deno.test(`driver phase round2: collect failure disposes and cannot report across generations (superseded=${superseded})`, async () => {
    await fixtureScope(async (scope) => {
      const parent = await scope.acquire(
        () => Deno.makeTempDir({ prefix: "driver-generation-" }),
        (root) => Deno.remove(root, { recursive: true }),
      );
      const directory = await createDriverStartupDirectory(scope, parent.value);
      const original = DriverSupervisor.prototype.reconcile;
      scope.defer(() => {
        DriverSupervisor.prototype.reconcile = original;
      });
      const works = new WeakMap<DriverSupervisor, Promise<void>>();
      DriverSupervisor.prototype.reconcile = function () {
        this.peers.observeStatus("driver", "active", true);
        return works.get(this)!;
      };
      const construct = () => {
        const work = Promise.withResolvers<void>();
        const listeners = new Set<() => void>();
        let throwing = false, failedReads = 0;
        const peers = preloadPeers(() => {
          if (throwing) {
            failedReads++;
            throw Error("obsolete or terminal collect failed");
          }
          return [{
            id: "driver",
            plugin: "plugin",
            revision: 1,
          }] as DriverInstance[];
        });
        const supervisor = Object.assign(preloadSupervisor(), {
          adapters: {
            lifecycle: { epoch: 1 },
            plugins: { driverOwner: () => ({ epoch: 1 }) },
          },
          peers,
          subscribe(notify: () => void) {
            listeners.add(notify);
            return () => {
              listeners.delete(notify);
            };
          },
        }) as DriverSupervisor;
        works.set(supervisor, work.promise);
        return {
          supervisor,
          work,
          listeners,
          failedReads: () => failedReads,
          fail: () => {
            throwing = true;
          },
        };
      };
      const reports: unknown[] = [];
      const publications: DriverStartupSnapshot[] = [];
      scope.defer(observeDriverStartup(directory.path, {
        report: (error) => {
          reports.push(error);
        },
        publish(directory, snapshot) {
          publications.push(snapshot);
          publishDriverStartup(directory, snapshot);
        },
      }));
      const old = construct();
      old.supervisor.reconcile();
      const callbacks = [...old.listeners];
      const replacement = superseded ? construct() : undefined;
      replacement?.supervisor.reconcile();
      const before = [...publications];
      old.fail();
      if (superseded) {
        for (const notify of callbacks) notify();
        assertEquals(old.failedReads(), 0);
        assertEquals(reports, []);
      }
      old.work.resolve();
      await old.work.promise;
      assertEquals(old.failedReads(), superseded ? 0 : 1);
      assertEquals(
        reports.map((error) => String(error)),
        superseded ? [] : ["Error: obsolete or terminal collect failed"],
      );
      assertEquals([...old.listeners], []);
      for (const notify of callbacks) notify();
      assertEquals(publications, before);
      assertEquals(
        reports.map((error) => String(error)),
        superseded ? [] : ["Error: obsolete or terminal collect failed"],
      );
      replacement?.work.resolve();
      await replacement?.work.promise;
    });
  });
}

Deno.test("driver phase round2: manual-sync replacement cannot overwrite the first cycle while a peer is held", async () => {
  await fixtureScope(async (scope) => {
    const acquired = Promise.withResolvers<TestServer>();
    const handoff = Promise.withResolvers<void>();
    scope.onCancel(() => handoff.resolve());
    let boots = 0;
    const a = (await scope.acquire(() =>
      memoryRemote(), (remote) => remote.close())).value;
    const b = (await scope.acquire(() =>
      memoryRemote(), (remote) =>
      remote.close())).value;
    a.put("first.md", "first cycle bytes");
    b.put("second.md", "held peer bytes");
    const f = (await scope.acquire(
      () =>
        storageServerFixture([a.authority, b.authority], {
          observedTime: 0,
          async serverBoot(inputs, options) {
            const child = await bootServer(inputs, options);
            if (++boots === 2) {
              // Discovery can reach its remote before the transport owner has
              // returned. Force that ordering rather than rely on host load.
              acquired.resolve(child);
              await handoff.promise;
            }
            return child;
          },
        }),
      (f) =>
        f.close(),
    )).value;
    const first = await f.add(a.baseUrl, a.token, "First"),
      second = await f.add(b.baseUrl, b.token, "Second");
    const predecessor = f.server();
    let booting!: ReturnType<typeof f.restart>;
    a.faults.push({
      path: "/list",
      status: 503,
      message: "first cycle failed",
    });
    await heldOperation({
      label: "round2 held peer",
      progress: { kind: "controlled", clock: "external" },
      signal: scope.signal,
      owner: () => b,
    }, async (hold) => {
      b.faults.push({ path: "/list", before: hold });
      booting = f.restart();
      const restarted = await booting;
      await assertRejects(
        () => restarted.initialDriver(first, "active"),
        Error,
        `driver '${first}' initial cycle: failed, expected active`,
      );
      return restarted;
    }, async (work) => {
      await work.reached();
      let candidate: TestServer;
      try {
        candidate = await bounded(
          workMilestone(booting, acquired.promise, "replacement acquisition"),
          "replacement health before transport handoff",
        );
        assertStrictEquals(f.server(), predecessor);
        assertEquals([predecessor.status()?.code, candidate.status()], [
          0,
          null,
        ]);
      } finally {
        handoff.resolve();
      }
      // The held remote is not the transport owner. Join the actual restart
      // before HTTP can sample a retired predecessor, even when discovery wins.
      const transport = await bounded(
        booting,
        "replacement transport admission",
      );
      assertStrictEquals(transport.server, candidate);
      assertStrictEquals(f.server(), candidate);
      await waitUntil(
        async () =>
          (await f.one(first)).status === "failed"
            ? done()
            : pending("first cycle failure"),
        {
          label: "first peer failed before manual replacement",
          children: [transport.server],
        },
      );
      await f.sync(first);
      assertEquals(
        [(await f.one(first)).status, (await f.one(second)).status],
        ["active", "starting"],
      );
      await work.result();
      assertEquals(
        [(await f.one(first)).status, (await f.one(second)).status],
        ["active", "active"],
      );
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/first.md`),
        "first cycle bytes",
      );
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/second.md`),
        "held peer bytes",
      );
    });
  });
});

Deno.test("driver phase round3: queued startup discovery cannot replace the first pass failure", async () => {
  await fixtureScope(async (scope) => {
    const remote = (await scope.acquire(() =>
      memoryRemote(), (remote) => remote.close())).value;
    remote.put("first.md", "queued pass bytes");
    const root = (await scope.acquire(() =>
      Deno.makeTempDir({ prefix: "driver-queued-pass-" }), (root) =>
      Deno.remove(root, { recursive: true }))).value;
    const preload = `${root}/queued-sync.mjs`;
    Deno.writeTextFileSync(
      preload,
      `import { DriverSupervisor } from ${
        JSON.stringify(
          new URL("../server/hub/drivers/supervisor.ts", import.meta.url).href,
        )
      };
const sync = DriverSupervisor.prototype.sync;
DriverSupervisor.prototype.sync = function (...args) {
  const stop = this.subscribe(() => {
    for (const snapshot of this.statusSnapshot()) {
      if (snapshot.result !== null) console.log("DRIVER_PASS_RESULT " + JSON.stringify({cycle: snapshot.cycle, result: snapshot.result}));
    }
  });
  const work = sync.apply(this, args);
  work.then(stop, stop);
  console.log("DRIVER_MANUAL_SYNC_ADMITTED");
  return work;
};`,
    );
    const queued = Promise.withResolvers<void>();
    const results = new Map<number, string>();
    const resultsReported = Promise.withResolvers<void>();
    const f = (await scope.acquire(() =>
      storageServerFixture([remote.authority], {
        observedTime: 0,
        serverBoot(inputs, options) {
          let stdout = "";
          return bootServer(inputs, {
            ...options,
            denoArgs: [...options!.denoArgs!, "--preload", preload],
            observeOutput(name, chunk) {
              options!.observeOutput!(name, chunk);
              if (name === "stdout") {
                stdout += chunk;
                if (stdout.includes("DRIVER_MANUAL_SYNC_ADMITTED\n")) {
                  queued.resolve();
                }
                for (const line of stdout.split("\n").slice(0, -1)) {
                  if (!line.startsWith("DRIVER_PASS_RESULT ")) {
                    continue;
                  }
                  const snapshot = JSON.parse(
                    line.slice("DRIVER_PASS_RESULT ".length),
                  );
                  results.set(snapshot.cycle, snapshot.result);
                }
                if (results.get(2) === "active") {
                  resultsReported.resolve();
                }
              }
            },
          });
        },
      }), (f) =>
      f.close())).value;
    const id = await f.add(remote.baseUrl, remote.token);
    let booting!: ReturnType<typeof f.restart>;
    await heldOperation({
      label: "first discovery before queued manual pass",
      progress: { kind: "controlled", clock: "external" },
      signal: scope.signal,
      owner: () =>
        remote,
    }, async (hold) => {
      remote.faults.push({
        path: "/list",
        status: 503,
        message: "first pass failed",
        before: hold,
      });
      booting = f.restart();
      const restarted = await booting;
      await assertRejects(
        () =>
          restarted.initialDriver(id, "active"),
        Error,
        `driver '${id}' initial cycle: failed, expected active`,
      );
      return restarted;
    }, async (work) => {
      await work.reached();
      const transport = await bounded(
        booting,
        "queued pass transport admission",
      );
      const syncing = f.sync(id);
      await bounded(
        workMilestone(
          syncing,
          queued.promise,
          "manual sync queued behind startup",
        ),
        "queued manual sync admission",
      );
      work.release();
      assertEquals(
        (await bounded(syncing, "queued discovery completion")).status,
        "active",
      );
      await work.result();
      await bounded(
        workMilestone(
          transport.server.exited,
          resultsReported.promise,
          "both pass results delivered",
        ),
        "queued pass result pipe",
      );
      assertEquals([...results], [[1, "failed"], [2, "active"]]);
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/first.md`),
        "queued pass bytes",
      );
    });
  });
});

Deno.test("driver phase round3: a self-exited admission candidate cannot poison queued replacement", async () => {
  await fixtureScope(async (scope) => {
    const remote = (await scope.acquire(() =>
      memoryRemote(), (remote) => remote.close())).value;
    const root = (await scope.acquire(() =>
      Deno.makeTempDir({ prefix: "driver-self-exit-" }), (root) =>
      Deno.remove(root, { recursive: true }))).value;
    const preload = `${root}/self-exit.mjs`;
    Deno.writeTextFileSync(
      preload,
      `const serve = Deno.serve;
Deno.serve = function (...args) {
  const server = serve.apply(this, args);
  fetch(${
        JSON.stringify(`${remote.baseUrl}/exit`)
      }, {headers: {authorization: ${
        JSON.stringify(`Bearer ${remote.token}`)
      }}}).then(() => Deno.exit(17));
  return server;
};`,
    );
    let boots = 0;
    const acquired = Promise.withResolvers<TestServer>();
    const f = (await scope.acquire(() =>
      storageServerFixture([], {
        async serverBoot(inputs, options) {
          const attempt = ++boots;
          const child = await bootServer(inputs, {
            ...options,
            denoArgs: [
              ...options!.denoArgs!,
              ...(attempt === 2 ? ["--preload", preload] : []),
            ],
          });
          if (attempt === 2) {
            await Deno.remove(`${f.statePath}/driver-startup/initial.json`);
            acquired.resolve(child);
          }
          return child;
        },
      }), (f) =>
      f.close())).value;
    await heldOperation({
      label: "candidate self exit during admission",
      progress: { kind: "controlled", clock: "external" },
      signal: scope.signal,
      owner: () =>
        remote,
    }, async (hold) => {
      remote.faults.push({ path: "/exit", before: hold, status: 200 });
      return await f.restart();
    }, async (work) => {
      await work.reached();
      const candidate = await bounded(
        acquired.promise,
        "self-exit candidate healthy",
      );
      const queued = f.restart();
      queued.catch(() => {});
      const error = await assertRejects(
        () =>
          work.result(),
        AggregateError,
        "Driver startup observation and child shutdown failed",
      );
      assertEquals(candidate.status()?.code, 17);
      assertEquals(error.errors.map((failure) => failure.constructor.name), [
        "ReadinessError",
        "Error",
      ]);
      assertStrictEquals(error.cause, error.errors[0]);
      assertEquals(
        error.errors[1].message,
        `server exited on its own before close() (pid ${candidate.pid}, exit code 17). stderr:\n${candidate.logs().stderr}`,
      );
      const replacement = await bounded(
        queued,
        "replacement after self-exited candidate",
      );
      assertEquals([boots, replacement.server.status()], [3, null]);
      assertStrictEquals(f.server(), replacement.server);
    });
  });
});

Deno.test("driver phase round3: settled peer result ignores later live failure while another peer is pending", async () => {
  await fixtureScope(async (scope) => {
    const root = (await scope.acquire(() =>
      Deno.makeTempDir({ prefix: "driver-settled-result-" }), (root) =>
      Deno.remove(root, { recursive: true }))).value;
    const directory = await createDriverStartupDirectory(scope, root);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const work = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = () =>
      work.promise;
    const generation = Object.freeze({});
    let statuses: readonly DriverCycleStatus[] = [
      {
        peer: "first",
        generation,
        cycle: 1,
        status: "active",
        result: "active",
      },
      { peer: "held", generation, cycle: 1, status: "starting", result: null },
    ];
    const listeners = new Set<() => void>();
    const supervisor = Object.assign(preloadSupervisor(), {
      adapters: {
        lifecycle: { epoch: 1 },
        plugins: { driverOwner: () => ({ epoch: 1 }) },
      },
      peers: preloadPeers(() =>
        ["first", "held"].map((id) => ({
          id,
          plugin: "plugin",
          revision: 1,
        })) as DriverInstance[]
      ),
      statusSnapshot: () =>
        statuses,
      subscribe(notify: () => void) {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
    });
    scope.defer(observeDriverStartup(directory.path));
    assertStrictEquals(supervisor.reconcile(), work.promise);
    const server = {
      pid: Deno.pid,
      exited: Promise.withResolvers<Deno.CommandStatus>().promise,
      status: () => null,
    } as TestServer;
    const bound = bindDriverStartup(scope, directory, server, () => server);
    statuses = [
      {
        peer: "first",
        generation,
        cycle: 1,
        status: "failed",
        result: "active",
      },
      {
        peer: "held",
        generation,
        cycle: 1,
        status: "active",
        result: "active",
      },
    ];
    for (const notify of listeners) notify();
    work.resolve();
    await work.promise;
    assertEquals(await bound.initialDriver("first", "active"), {
      pid: Deno.pid,
      owner: `${Deno.pid}:1`,
      state: "active",
    });
    assertEquals(
      recordReader(directory, "initial.json", driverStartupSchema).read()!.value
        .states,
      { first: "active", held: "active" },
    );
  });
});

Deno.test("driver phase round2: status cache keys include peer, slot generation and cycle sequence", async () => {
  await fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "driver-cycle-cache-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const work = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = () => work.promise;
    const generation = Object.freeze({});
    let statuses: readonly DriverCycleStatus[] = [
      { peer: "driver", generation, cycle: 1, status: "failed", result: null },
      { peer: "held", generation, cycle: 1, status: "starting", result: null },
    ];
    const listeners = new Set<() => void>();
    const supervisor = Object.assign(preloadSupervisor(), {
      adapters: {
        lifecycle: { epoch: 1 },
        plugins: { driverOwner: () => ({ epoch: 1 }) },
      },
      peers: preloadPeers(() =>
        ["driver", "held"].map((id) => ({
          id,
          plugin: "plugin",
          revision: 1,
        })) as DriverInstance[]
      ),
      statusSnapshot: () => statuses,
      subscribe(notify: () => void) {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
    });
    const reports: unknown[] = [];
    scope.defer(observeDriverStartup(directory.path, {
      report: (error) => {
        reports.push(error);
      },
    }));
    assertStrictEquals(supervisor.reconcile(), work.promise);
    statuses = [
      {
        peer: "driver",
        generation,
        cycle: 2,
        status: "active",
        result: "active",
      },
      {
        peer: "held",
        generation,
        cycle: 1,
        status: "active",
        result: "active",
      },
    ];
    for (const notify of listeners) notify();
    work.resolve();
    await work.promise;
    assertEquals(
      recordReader(directory, "initial.json", driverStartupSchema).read()!
        .value,
      {
        pid: Deno.pid,
        owner: `${Deno.pid}:1`,
        sequence: 1,
        pending: false,
        states: { driver: "failed", held: "active" },
        failure: null,
      },
    );
    assertEquals([...listeners], []);
    assertEquals(reports, []);
  });
});

Deno.test("driver phase: replaced server cannot borrow a completed old cycle", () =>
  withStartup(async (f) => {
    f.publish({ pending: false, states: { driver: "active" } });
    const bound = f.bind();
    f.replace();
    await assertRejects(
      () => bound.initialDriver("driver", "active"),
      Error,
      "driver 'driver' initial cycle: server owner replaced",
    );
  }));

Deno.test("driver phase: completed absent, Starting or wrong terminal state rejects without recapture", async () => {
  for (
    const states of [{} as Record<string, string>, { driver: "starting" }, {
      driver: "paused",
    }, {
      driver: "failed",
    }]
  ) {
    await withStartup(async (f) => {
      f.publish();
      const bound = f.bind();
      f.publish({ pending: false, states });
      await assertRejects(
        () => bound.initialDriver("driver", "active"),
        Error,
        `driver 'driver' initial cycle: ${
          states.driver && states.driver !== "starting"
            ? states.driver
            : `cycle completed with ${states.driver ?? "absent"}`
        }, expected active`,
      );
    });
  }
});

Deno.test("driver phase: matching projection is not completion, child exit and cancellation stay terminal", async () => {
  await withStartup(async (f) => {
    f.publish({ states: { driver: "active" } });
    const bound = f.bind();
    f.exit();
    await assertRejects(
      () => bound.initialDriver("driver", "active"),
      Error,
      "driver server 123 exited before driver initial cycle/initial.json: 17",
    );
  });
  await withStartup(async (f) => {
    f.publish();
    const controller = new AbortController();
    controller.signal.addEventListener(
      "abort",
      (event) => event.stopImmediatePropagation(),
    );
    const cancelled = f.bind().initialDriver(
      "driver",
      "active",
      controller.signal,
    );
    const cause = Error("owned phase cancelled");
    controller.abort(cause);
    assertStrictEquals(
      await assertRejects(() => cancelled, Error, "owned phase cancelled"),
      cause,
    );
  });
});

Deno.test("driver phase: failure precedes matching terminal projection", () =>
  withStartup(async (f) => {
    f.publish({
      pending: false,
      states: { driver: "active" },
      failure: "initial reconcile rejected",
    });
    await assertRejects(
      () => f.bind().initialDriver("driver", "active"),
      Error,
      "driver 'driver' initial cycle: initial reconcile rejected",
    );
  }));

Deno.test("driver phase: fixture retirement cancels and joins its pending observer before deleting records", async () => {
  let observation:
    | ReturnType<ReturnType<typeof bindDriverStartup>["initialDriver"]>
    | undefined;
  await withStartup((f) => {
    f.publish();
    observation = f.bind().initialDriver("driver", "active");
  });
  await assertRejects(
    () => observation!,
    OwnershipError,
    "Fixture scope retired",
  );
});

Deno.test("driver phase: stale pid is not admission and child exit supplies the verdict", () =>
  withStartup(async (f) => {
    f.publish({ pid: 456, pending: false, states: { driver: "active" } });
    const bound = f.bind();
    f.exit();
    const error = await assertRejects(
      () => bound.initialDriver("driver", "active"),
      ReadinessError,
      "driver 'driver' initial cycle: admission: child exited (pid 123, exit code 17)",
    );
    assertEquals([error.label, error.reason, error.state], [
      "driver 'driver' initial cycle: admission",
      "child exited (pid 123, exit code 17)",
      { last: "nothing observed yet", stdout: undefined, stderr: undefined },
    ]);
  }));

Deno.test("driver phase: strict schema rejects malformed terminal snapshots", () =>
  withStartup((f) => {
    for (
      const changes of [
        { pending: "false" },
        { states: [] },
        { states: { driver: true } },
        { pid: 0 },
        { owner: "" },
        { sequence: 0 },
        { sequence: 1.5 },
        { sequence: "1" },
        { sequence: undefined },
        { failure: 7 },
        { extra: true },
      ]
    ) {
      assertThrows(
        () => f.publish(changes as unknown as Partial<DriverStartupSnapshot>),
        TypeError,
        "Invalid driver initial-cycle snapshot",
      );
      f.corrupt(
        JSON.stringify(
          snapshot(changes as unknown as Partial<DriverStartupSnapshot>),
        ),
      );
      assertThrows(
        () => f.bind(),
        TypeError,
        "Invalid driver initial-cycle snapshot",
      );
    }
    f.corrupt("{");
    assertThrows(
      () => f.bind(),
      SyntaxError,
      "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    );
  }));

Deno.test("driver phase: preload returns original work, rejects replacement and unsubscribes on terminal failure", async () => {
  await fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "driver-preload-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const work = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = function () {
      this.peers.observeStatus("driver", "active", true);
      return work.promise;
    };
    const listeners = new Set<() => void>();
    let revision = 1;
    const supervisor = Object.assign(
      preloadSupervisor(),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: preloadPeers(() =>
          [{ id: "driver", plugin: "plugin", revision }] as DriverInstance[]
        ),
        view: () =>
          Promise.resolve({ instances: [{ id: "driver", status: "active" }] }),
        subscribe: (callback: () => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    ) as DriverSupervisor;
    const restore = observeDriverStartup(directory.path);
    scope.defer(restore);
    assertStrictEquals(supervisor.reconcile(), work.promise);
    revision++;
    for (const notify of listeners) notify();
    const reader = recordReader(directory, "initial.json", driverStartupSchema);
    await waitUntil(
      () =>
        reader.read()?.value.failure
          ? done()
          : pending("replacement publication"),
      { label: "preload replacement" },
    );
    const captured = reader.read()!.value;
    assertEquals(captured, {
      pid: Deno.pid,
      owner: `${Deno.pid}:1`,
      sequence: 1,
      pending: true,
      states: { driver: "active" },
      failure: "cycle owner replaced",
    });
    work.reject(Error("reconcile failed"));
    await assertRejects(() => work.promise, Error, "reconcile failed");
    await waitUntil(
      () =>
        reader.read()?.value.pending === false
          ? done()
          : pending("completion publication"),
      { label: "preload completion" },
    );
    assertEquals(listeners.size, 0);
    assertEquals(reader.read()!.value, {
      ...captured,
      pending: false,
      failure: "cycle owner replaced",
    });
  });
});

Deno.test("driver phase: an old supervisor completion cannot overwrite its replacement snapshot", async () => {
  await fixtureScope(async (scope) => {
    const parent = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "driver-replacement-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const directory = await createDriverStartupDirectory(scope, parent.value);
    const original = DriverSupervisor.prototype.reconcile;
    scope.defer(() => {
      DriverSupervisor.prototype.reconcile = original;
    });
    const works = new WeakMap<DriverSupervisor, Promise<void>>();
    DriverSupervisor.prototype.reconcile = function () {
      return works.get(this)!;
    };
    const construct = (work: Promise<void>) => {
      const listeners = new Set<() => void>();
      const supervisor = Object.assign(
        preloadSupervisor(),
        {
          adapters: {
            lifecycle: { epoch: 1 },
            plugins: { driverOwner: () => ({ epoch: 1 }) },
          },
          peers: { instances: () => [] },
          view: () => Promise.resolve({ instances: [] }),
          subscribe: (callback: () => void) => {
            listeners.add(callback);
            return () => listeners.delete(callback);
          },
        },
      ) as DriverSupervisor;
      works.set(supervisor, work);
      return { supervisor, listeners };
    };
    scope.defer(observeDriverStartup(directory.path));
    const oldWork = Promise.withResolvers<void>(),
      newWork = Promise.withResolvers<void>();
    const old = construct(oldWork.promise),
      replacement = construct(newWork.promise);
    old.supervisor.reconcile();
    replacement.supervisor.reconcile();
    const reader = recordReader(directory, "initial.json", driverStartupSchema);
    const retained = reader.read()!.value.owner;
    newWork.resolve();
    await waitUntil(
      () =>
        reader.read()?.value.pending === false
          ? done()
          : pending("replacement completion"),
      { label: "replacement complete" },
    );
    oldWork.reject(Error("old cycle failed late"));
    await assertRejects(() => oldWork.promise, Error, "old cycle failed late");
    await waitUntil(
      () => old.listeners.size === 0 ? done() : pending("old listener"),
      { label: "old cycle retired" },
    );
    assertEquals(reader.read()!.value, {
      pid: Deno.pid,
      owner: retained,
      sequence: 2,
      pending: false,
      states: {},
      failure: null,
    });
  });
});

Deno.test("driver phase: HTTP serves Starting during held discovery, then same cycle imports bytes", async () => {
  await fixtureScope(async (scope) => {
    const remote = (await scope.acquire(
      () => memoryRemote(),
      (remote) => remote.close(),
    )).value;
    remote.put("note.md", "before restart");
    const f = (await scope.acquire(
      () => storageServerFixture([remote.authority]),
      (f) => f.close(),
    )).value;
    const id = await f.add(remote.baseUrl, remote.token);
    remote.put("note.md", "captured cycle bytes");
    const owner = {};
    let booting!: ReturnType<typeof f.restart>;
    await heldOperation({
      label: "initial discovery",
      progress: { kind: "controlled", clock: "external" },
      signal: scope.signal,
      owner: () => owner,
    }, async (hold) => {
      remote.faults.push({ path: "/list", before: hold });
      booting = f.restart();
      const restarted = await booting;
      const result = await restarted.initialDriver(id, "active");
      return { restarted, result };
    }, async (work) => {
      await work.reached();
      // Discovery may enter before boot's health read returns. Join that actual
      // transport owner, never sample f.server() while it still names the old one.
      const transport = await booting;
      const health = await fetch(`${transport.server.baseUrl}/_/api/health`);
      assertEquals(health.status, 200);
      await health.body?.cancel();
      assertEquals((await f.one(id)).status, "starting");
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/note.md`),
        "before restart",
      );
      const { restarted, result } = await work.result();
      assertEquals(result, {
        pid: restarted.server.pid,
        owner: `${restarted.server.pid}:1`,
        state: "active",
      });
      assertEquals((await f.one(id)).status, "active");
      assertEquals(
        Deno.readTextFileSync(`${f.vault}/note.md`),
        "captured cycle bytes",
      );
    });
  });
});

Deno.test("driver phase: native Worker deadline settles the original startup cycle without a readiness verdict", async () => {
  await fixtureScope(async (scope) => {
    const remote = (await scope.acquire(
      () => memoryRemote(),
      (remote) => remote.close(),
    )).value;
    remote.put("note.md", "native retained bytes");
    const f = (await scope.acquire(
      () => storageServerFixture([remote.authority], { native: true }),
      (f) => f.close(),
    )).value;
    const id = await f.add(remote.baseUrl, remote.token, "Native", {
      atomicGroups: true,
    });
    remote.native.hang = true;
    const restarted = await f.restart();
    await assertRejects(
      () => restarted.initialDriver(id, "active"),
      Error,
      `driver '${id}' initial cycle: failed, expected active`,
    );
    assertEquals((await f.one(id)).status, "failed");
    assertEquals(
      Deno.readTextFileSync(`${f.vault}/note.md`),
      "native retained bytes",
    );
    remote.native.hang = false;
    await f.sync(id);
    assertEquals((await f.one(id)).status, "active");
    await assertRejects(
      () => restarted.initialDriver(id, "active"),
      Error,
      `driver '${id}' initial cycle: failed, expected active`,
    );
  });
});
