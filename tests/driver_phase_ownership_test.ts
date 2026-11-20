// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { DriverSupervisor } from "../server/hub/drivers/supervisor.ts";
import { OwnershipError } from "../shared/ownership.js";
import type { TestServer } from "./helpers/boot.ts";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import {
  bindDriverStartup,
  createDriverStartupDirectory,
} from "./helpers/driver_startup.ts";
import {
  driverStartupSchema,
  type DriverStartupSnapshot,
} from "./helpers/driver_startup_schema.ts";
import { publishDriverStartup } from "./helpers/driver_startup_protocol.ts";
import { observeDriverStartup } from "./helpers/driver_startup_preload.ts";
import { storageServerFixture } from "./helpers/driver_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { heldOperation } from "./helpers/owned_operation.ts";
import { recordReader } from "./helpers/owned_record_channel.ts";
import { publishRecord } from "./helpers/process_records.ts";
import { done, pending, ReadinessError, waitUntil } from "./helpers/wait.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { workMilestone } from "./helpers/product_settlement.ts";

const snapshot = (
  changes: Partial<DriverStartupSnapshot> = {},
): DriverStartupSnapshot => ({
  pid: 123,
  owner: "123:initial",
  pending: true,
  states: { driver: "starting" },
  failure: null,
  ...changes,
});
function withStartup(
  body: (f: {
    publish: (changes?: Partial<DriverStartupSnapshot>) => void;
    corrupt: (bytes: string) => void;
    bind: () => ReturnType<typeof bindDriverStartup>;
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
      bind: () => bindDriverStartup(scope, directory, server, () => current),
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
    DriverSupervisor.prototype.reconcile = () => work.promise;
    const listeners = new Set<() => void>();
    const supervisor = Object.assign(
      Object.create(DriverSupervisor.prototype),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: { instances: () => [] },
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
      pending: false,
      states: { driver: "active" },
      failure: "undefined",
    });
    await restore();
    const nextWork = Promise.withResolvers<void>();
    DriverSupervisor.prototype.reconcile = () => nextWork.promise;
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
    DriverSupervisor.prototype.reconcile = () => product;
    const supervisor = Object.assign(
      Object.create(DriverSupervisor.prototype),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: { instances: () => [] },
        view: () => Promise.reject(Error("projection failed")),
        subscribe: () => () => {},
      },
    ) as DriverSupervisor;
    scope.defer(observeDriverStartup(directory.path));
    assertStrictEquals(supervisor.reconcile(), product);
    await product;
    const reader = recordReader(directory, "initial.json", driverStartupSchema);
    await waitUntil(() => {
      const snapshot = reader.read()?.value;
      return snapshot && !snapshot.pending &&
          snapshot.failure === "Error: projection failed"
        ? done()
        : pending("projection failure");
    }, { label: "driver projection failure publication" });
    const exited = Promise.withResolvers<Deno.CommandStatus>();
    const server = {
      pid: Deno.pid,
      exited: exited.promise,
      status: () => null,
    } as TestServer;
    await assertRejects(
      () =>
        bindDriverStartup(scope, directory, server, () => server).initialDriver(
          "driver",
          "active",
        ),
      Error,
      "driver 'driver' initial cycle: Error: projection failed",
    );
    assertEquals(reader.read()!.value, {
      pid: Deno.pid,
      owner: `${Deno.pid}:1`,
      pending: false,
      states: {},
      failure: "Error: projection failed",
    });
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
    DriverSupervisor.prototype.reconcile = () => work.promise;
    const listeners = new Set<() => void>();
    let revision = 1;
    const supervisor = Object.assign(
      Object.create(DriverSupervisor.prototype),
      {
        adapters: {
          lifecycle: { epoch: 1 },
          plugins: { driverOwner: () => ({ epoch: 1 }) },
        },
        peers: {
          instances: () => [{ id: "driver", plugin: "plugin", revision }],
        },
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
        Object.create(DriverSupervisor.prototype),
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
  });
});
