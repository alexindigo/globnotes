// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { VaultHub } from "../server/hub/hub.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { PluginRuntime } from "../server/plugins/runtime.ts";
import { state } from "../server/state.ts";
import { auxiliaryFixture } from "./helpers/auxiliary_fixture.ts";
import { backupFixture } from "./helpers/backup_fixture.ts";
import { bundle } from "./helpers/plugin_lifecycle.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { restoreState } from "./helpers/state.ts";
import { bounded, WorkerDeliveryGate } from "./helpers/worker_liveness.ts";
import {
  pluginOperationsFixture,
  withPluginOperationsFixture,
} from "./helpers/plugin_operations_fixture.ts";
import { pluginFixture, withPluginFixture } from "./helpers/plugin_fixture.ts";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { OwnershipError } from "../shared/ownership.js";
import { workMilestone } from "./helpers/product_settlement.ts";
import { hubOperationsFixture } from "./helpers/hub_fixture.ts";

const scopePlugin = {
  id: "scope-pilot",
  manifest: {
    runtime: { server: "service.js" },
    capabilities: { network: false, imports: false },
  },
  files: {
    "service.js":
      "export function activate(ctx) { ctx.commands.register({id:'ping', label:'ping', target:'server'}, () => 'pong'); }",
  },
};

for (const source of ["original", "spread", "retained"] as const) {
  Deno.test(`fixture admission: ${source} root disposal drains a held borrower mkdir`, async () => {
    const retained = source === "retained"
      ? await pluginOperationsFixture(scopePlugin)
      : undefined;
    await retained?.close();
    const original = retained?.fixture ?? await pluginFixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    const mkdir = Deno.mkdir, remove = Deno.remove;
    let removalStarted = false;
    let borrower:
      | Awaited<ReturnType<typeof pluginOperationsFixture>>
      | undefined;
    Deno.mkdir = async (path, options) => {
      if (String(path).endsWith(`/${scopePlugin.id}`)) {
        entered.resolve();
        await release.promise;
      }
      await mkdir(path, options);
    };
    Deno.remove = async (path, options) => {
      if (String(path) === original.root) {
        removalStarted = true;
        await remove(path, options);
        removed.resolve();
      } else await remove(path, options);
    };
    const preparing = pluginOperationsFixture({
      ...scopePlugin,
      fixture: source === "spread" ? { ...original } : original,
    });
    const rejected = assertRejects(() => preparing, OwnershipError, "retired");
    rejected.catch(() => {}); // Also observed when entry itself fails.
    // Observe completion even if the regression unexpectedly admits a borrower.
    preparing.then((value) => {
      borrower = value;
    }, () => {});
    try {
      await workMilestone(preparing, entered.promise, "borrower mkdir entered");
      const deleting = original.dispose();
      // With the old split custody, root removal starts synchronously. Finish
      // that removal before releasing mkdir so the original recreation is exact.
      if (removalStarted) await removed.promise;
      release.resolve();
      await Promise.all([deleting, rejected]);
      await assertRejects(() => Deno.stat(original.root), Deno.errors.NotFound);
    } finally {
      release.resolve();
      await preparing.catch(() => {});
      Deno.mkdir = mkdir;
      Deno.remove = remove;
      try {
        await borrower?.close();
      } finally {
        try {
          await original.dispose();
        } finally {
          await remove(original.root, { recursive: true }).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          });
        }
      }
    }
  });
}

for (const order of ["LIFO", "non-LIFO"] as const) {
  Deno.test(`fixture state: overlapping preparation and ${order} close preserve active bindings`, async () => {
    const previous = { ...state };
    const roots = await Promise.all([pluginFixture(), pluginFixture()]);
    const installed = Promise.withResolvers<void>();
    const write = Deno.writeTextFile;
    let manifests = 0;
    Deno.writeTextFile = async (path, data, options) => {
      await write(path, data, options);
      if (String(path).endsWith("/manifest.json")) {
        if (++manifests === 2) installed.resolve();
        await installed.promise;
      }
    };
    const fixtures: Awaited<ReturnType<typeof pluginOperationsFixture>>[] = [];
    try {
      await Promise.all(
        roots.map((fixture) =>
          pluginOperationsFixture({ ...scopePlugin, fixture }).then((value) => {
            fixtures.push(value);
          })
        ),
      );
      const active = fixtures.find((fixture) =>
        fixture.config === state.config
      )!;
      assert(active);
      const earlier = fixtures.find((fixture) => fixture !== active)!;
      const first = order === "LIFO" ? active : earlier;
      const remaining = first === active ? earlier : active;
      await first.close();
      assertEquals(state.config, remaining.config);
      assertEquals(state.notes.storagePath, remaining.fixture.vault);
      assertEquals(state.plugins, remaining.manager);
      assertEquals(state.hub, remaining.hub);
      await remaining.close();
      assertEquals({ ...state }, previous);
    } finally {
      Deno.writeTextFile = write;
      await fixtureScope((cleanup) => {
        cleanup.defer(() => restoreState(previous));
        for (const root of roots) cleanup.defer(() => root.dispose());
        for (const fixture of fixtures) cleanup.defer(() => fixture.close());
      });
    }
  });
}

Deno.test("fixture admission: root disposal closes a borrowed runtime before deleting its files", async () => {
  const previous = { ...state };
  const root = await pluginFixture();
  const borrower = await pluginOperationsFixture({
    ...scopePlugin,
    fixture: root,
  });
  try {
    assertEquals(await borrower.command("ping"), "pong");
    await root.dispose();
    await assertRejects(() => Deno.stat(root.root), Deno.errors.NotFound);
    assertThrows(
      () => borrower.scope.assertCurrent(),
      OwnershipError,
      "retired",
    );
    assertThrows(() => borrower.hub.store.files());
    assertEquals(borrower.runtime.commands(), []);
    assertEquals({ ...state }, previous);
  } finally {
    try {
      await borrower.close();
    } finally {
      await root.dispose();
    }
  }
});

Deno.test("fixture admission: backup extension helpers share their root's currency", async () => {
  const root = await pluginFixture();
  const backup = await backupFixture({ fixture: root });
  try {
    await root.dispose();
    for (
      const invoke of [
        () => backup.settings(),
        () => backup.configure(2),
        () => backup.status(),
      ]
    ) {
      await assertRejects(invoke, OwnershipError, "retired");
    }
    await assertRejects(() => Deno.stat(root.root), Deno.errors.NotFound);
  } finally {
    try {
      await backup.close();
    } finally {
      await root.dispose();
    }
  }
});

Deno.test("fixture state: a held acquisition cannot capture another fixture's future bindings", async () => {
  const previous = { ...state };
  const roots = await Promise.all([pluginFixture(), pluginFixture()]);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const descriptor = Object.getOwnPropertyDescriptor(
    VaultHub.prototype,
    "then",
  );
  let hold = true;
  Object.defineProperty(VaultHub.prototype, "then", {
    configurable: true,
    get() {
      if (!hold) return undefined;
      hold = false;
      return (resolve: (value: VaultHub) => void) => {
        entered.resolve();
        release.promise.then(() => resolve(this));
      };
    },
  });
  const fixtures: Awaited<ReturnType<typeof pluginOperationsFixture>>[] = [];
  const preparing = pluginOperationsFixture({
    ...scopePlugin,
    fixture: roots[0],
  }).then((value) => {
    fixtures.push(value);
    return value;
  });
  try {
    await workMilestone(
      preparing,
      entered.promise,
      "first hub acquisition held",
    );
    const second = await pluginOperationsFixture({
      ...scopePlugin,
      fixture: roots[1],
    });
    fixtures.push(second);
    release.resolve();
    const first = await preparing;
    assertEquals(state.config, first.config);
    await first.close();
    assertEquals(state.config, second.config);
    assertEquals(state.hub, second.hub);
    await second.close();
    assertEquals({ ...state }, previous);
  } finally {
    release.resolve();
    await preparing.catch(() => {});
    if (descriptor) {
      Object.defineProperty(VaultHub.prototype, "then", descriptor);
    } else Reflect.deleteProperty(VaultHub.prototype, "then");
    await fixtureScope((cleanup) => {
      cleanup.defer(() => restoreState(previous));
      for (const root of roots) cleanup.defer(() => root.dispose());
      for (const fixture of fixtures) cleanup.defer(() => fixture.close());
    });
  }
});

for (const order of ["LIFO", "non-LIFO"] as const) {
  Deno.test(`fixture state: hub siblings handle ${order} closure`, () => {
    const previous = { ...state };
    const first = hubOperationsFixture(), second = hubOperationsFixture();
    const fixtures = order === "LIFO" ? [second, first] : [first, second];
    let closed = 0;
    try {
      fixtures[closed++].close();
      assertEquals(state.hub, fixtures[1].hub);
      assertEquals(state.operations, fixtures[1].operations);
      fixtures[closed++].close();
      assertEquals({ ...state }, previous);
    } finally {
      try {
        while (closed < fixtures.length) fixtures[closed++].close();
      } finally {
        restoreState(previous);
      }
    }
  });
}

Deno.test("fixture state: lifecycle bundle closure does not clobber an active operations fixture", async () => {
  const previous = { ...state };
  const lifecycle = await bundle({ retain: false });
  let operations:
    | Awaited<ReturnType<typeof pluginOperationsFixture>>
    | undefined;
  let closed = false;
  try {
    operations = await pluginOperationsFixture(scopePlugin);
    await lifecycle.dispose();
    closed = true;
    assertEquals(state.config, operations.config);
    await operations.close();
    assertEquals({ ...state }, previous);
  } finally {
    await fixtureScope((cleanup) => {
      cleanup.defer(() => restoreState(previous));
      if (!closed) cleanup.defer(() => lifecycle.dispose());
      if (operations) {
        cleanup.defer(() => operations!.fixture.dispose());
        cleanup.defer(() => operations!.close());
      }
    });
  }
});

Deno.test("fixture capabilities: escaped installation cannot recreate a retired root", async () => {
  const escaped = await withPluginFixture(async (fixture) => {
    await fixture.install("live", {});
    return { root: fixture.root, install: fixture.install };
  });
  try {
    await assertRejects(
      async () => await escaped.install("late", {}),
      OwnershipError,
      "retired",
    );
    await assertRejects(() => Deno.stat(escaped.root), Deno.errors.NotFound);
  } finally {
    await Deno.remove(escaped.root, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
});

Deno.test("fixture capabilities: callback entries never expose root disposal", async () => {
  await withPluginFixture(async (fixture) => {
    // @ts-expect-error Manual deletion is not a callback capability.
    assertEquals(fixture.dispose, undefined);
    assertEquals(Reflect.has(fixture, "dispose"), false);
    await withPluginOperationsFixture({
      ...scopePlugin,
      fixture: { ...fixture, dispose: () => Promise.resolve() },
    }, (operations) => {
      // @ts-expect-error Borrowed compatibility capabilities are not projected.
      assertEquals(operations.fixture.dispose, undefined);
      assertEquals(Reflect.has(operations.fixture, "dispose"), false);
    });
  });
});

Deno.test("fixture capabilities: retirement drains an in-flight installation before root deletion", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const mkdir = Deno.mkdir;
  let root = "", rejected: Promise<unknown> = Promise.resolve();
  Deno.mkdir = async (path, options) => {
    if (String(path).endsWith("/inflight")) {
      entered.resolve();
      await release.promise;
    }
    await mkdir(path, options);
  };
  const running = withPluginFixture(async (fixture, scope) => {
    root = fixture.root;
    const installing = fixture.install("inflight", {});
    rejected = assertRejects(() => installing, OwnershipError, "retired");
    await entered.promise;
    scope.defer(() => closing.resolve());
  });
  try {
    try {
      await workMilestone(
        running,
        closing.promise,
        "fixture installation drain entered",
      );
      assert((await Deno.stat(root)).isDirectory);
    } finally {
      release.resolve();
      try {
        await Promise.all([running, rejected]);
      } finally {
        Deno.mkdir = mkdir;
      }
    }
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
});

Deno.test("fixture capabilities: every escaped operation rejects before effects", async () => {
  const escaped = await withPluginOperationsFixture(
    scopePlugin,
    (fixture) => fixture,
  );
  try {
    for (
      const invoke of [
        () => escaped.fixture.install("late", {}),
        () => escaped.command("ping"),
        () => escaped.save("Late", "late"),
        () => escaped.create("Late", "late"),
        () => escaped.remove("Late"),
      ]
    ) {
      await assertRejects(
        async () => await invoke(),
        OwnershipError,
        "retired",
      );
    }
    await assertRejects(
      () => Deno.stat(escaped.fixture.root),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(escaped.fixture.root, { recursive: true }).catch(
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      },
    );
  }
});

Deno.test("fixture capabilities: retained evidence admits a new scope but never revives the old one", async () => {
  const first = await pluginOperationsFixture(scopePlugin);
  let next: Awaited<ReturnType<typeof pluginOperationsFixture>> | undefined;
  try {
    await first.close();
    await assertRejects(
      async () => await first.fixture.install("retired", {}),
      OwnershipError,
      "retired",
    );
    next = await pluginOperationsFixture({
      ...scopePlugin,
      fixture: first.fixture,
    });
    assertEquals(await next.command("ping"), "pong");
    await next.create("Resumed", "retained root consumer");
    assertEquals(
      await Deno.readTextFile(`${first.fixture.vault}/Resumed.md`),
      "retained root consumer",
    );
    await next.close();
    await assertRejects(
      async () => await next!.fixture.install("retired-next", {}),
      OwnershipError,
      "retired",
    );
    await next.fixture.dispose();
    await assertRejects(
      () => Deno.stat(first.fixture.root),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () =>
        withPluginOperationsFixture(
          { ...scopePlugin, fixture: next!.fixture },
          () => {},
        ),
      OwnershipError,
      "retired",
    );
  } finally {
    try {
      await next?.close();
    } finally {
      try {
        await first.close();
      } finally {
        await first.fixture.dispose();
      }
    }
  }
});

for (
  const failure of [
    "root",
    "mkdir-1",
    "mkdir-2",
    "install",
    "scan",
    "configure",
    "reconcile",
    "body",
    "runtime-close",
    "manager-stop",
    "state-restore",
    "hub-stop",
    "root-remove",
    "report",
  ]
) {
  Deno.test(`fixture operations ownership: ${failure} releases preparation and every later owner`, async () => {
    const primary = new Error(`operations ${failure}`),
      cleanup = new Error(`close ${failure}`);
    const previous = { ...state };
    const roots: string[] = [], events: string[] = [];
    const hubs: VaultHub[] = [],
      managers: PluginManager[] = [],
      runtimes: PluginRuntime[] = [];
    const originals = {
      temp: Deno.makeTempDir,
      mkdir: Deno.mkdir,
      remove: Deno.remove,
      scan: VaultHub.prototype.scanNow,
      hubStop: VaultHub.prototype.stop,
      configure: PluginManager.prototype.configureRuntime,
      managerStop: PluginManager.prototype.stop,
      reconcile: PluginRuntime.prototype.reconcile,
      runtimeClose: PluginRuntime.prototype.close,
      assign: Object.assign,
      log: console.log,
    };
    let scope: FixtureScope | undefined, mkdir = 0;
    let restoring = false;
    const delivery = new WorkerDeliveryGate();
    delivery.holdHeartbeat = false;
    Object.assign = ((target: object, ...sources: object[]) => {
      const result = originals.assign(target, ...sources);
      if (target === state && restoring && failure === "state-restore") {
        throw cleanup;
      }
      return result;
    }) as typeof Object.assign;
    console.log = (...args) => {
      if (
        failure === "report" &&
        String(args[0]).includes("retainedPluginFixture")
      ) {
        events.push("report");
        throw cleanup;
      }
      originals.log(...args);
    };
    Deno.makeTempDir = async (options) => {
      if (options?.prefix === "globnotes-platform-" && failure === "root") {
        throw primary;
      }
      const root = await originals.temp(options);
      if (options?.prefix === "globnotes-platform-") roots.push(root);
      return root;
    };
    Deno.mkdir = async (path, options) => {
      if (roots.some((root) => String(path).startsWith(root))) {
        mkdir++;
        if (
          failure === `mkdir-${mkdir}` || (failure === "install" && mkdir === 3)
        ) throw primary;
      }
      await originals.mkdir(path, options);
    };
    Deno.remove = async (path, options) => {
      await originals.remove(path, options);
      if (roots.includes(String(path))) {
        events.push("root");
        if (failure === "root-remove") throw cleanup;
      }
    };
    VaultHub.prototype.scanNow = function (...args) {
      hubs.push(this);
      if (failure === "scan") throw primary;
      return originals.scan.apply(this, args);
    };
    VaultHub.prototype.stop = function () {
      originals.hubStop.call(this);
      events.push("hub");
      if (failure === "hub-stop") throw cleanup;
    };
    PluginManager.prototype.configureRuntime = function (...args) {
      managers.push(this);
      const runtime = originals.configure.apply(this, args);
      runtimes.push(runtime);
      if (failure === "configure") throw primary;
      return runtime;
    };
    PluginManager.prototype.stop = function () {
      originals.managerStop.call(this);
      events.push("manager");
      if (failure === "manager-stop") throw cleanup;
    };
    PluginRuntime.prototype.reconcile = async function () {
      await originals.reconcile.call(this);
      if (failure === "reconcile") throw primary;
    };
    PluginRuntime.prototype.close = async function () {
      await originals.runtimeClose.call(this);
      restoring = true;
      events.push("runtime");
      if (failure === "runtime-close") throw cleanup;
    };
    try {
      let error: unknown;
      try {
        await withPluginOperationsFixture({
          ...scopePlugin,
          retain: failure === "report",
        }, async (fixture) => {
          scope = fixture.scope;
          assertEquals(await fixture.command("ping"), "pong");
          throw primary;
        });
      } catch (caught) {
        error = caught;
      }
      if (
        failure.endsWith("close") || failure.endsWith("stop") ||
        failure === "root-remove" || failure === "state-restore" ||
        failure === "report"
      ) {
        assert(error instanceof AggregateError);
        assertEquals(error.cause, primary);
        assertEquals(error.errors, [primary, cleanup]);
      } else assertEquals(error, primary);
      assertEquals({ ...state }, previous);
      if (scope) assertEquals(scope.size, 0);
      // Observe all outcomes before rescue cleanup: a leaked hub/root/Worker
      // cannot be made green by the finally below.
      for (const root of roots) {
        if (failure === "report") assert((await Deno.stat(root)).isDirectory);
        else await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
      }
      for (const hub of hubs) assertThrows(() => hub.store.files());
      assert(delivery.workers.every((worker) => worker.terminated > 0));
      if (runtimes.length) {
        assertEquals(events.slice(0, 3), ["runtime", "manager", "hub"]);
        assertEquals(runtimes[0].commands(), []);
      }
      if (roots.length) {
        assertEquals(events.at(-1), failure === "report" ? "report" : "root");
      }
    } finally {
      Deno.makeTempDir = originals.temp;
      Object.assign = originals.assign;
      console.log = originals.log;
      Deno.mkdir = originals.mkdir;
      Deno.remove = originals.remove;
      VaultHub.prototype.scanNow = originals.scan;
      VaultHub.prototype.stop = originals.hubStop;
      PluginManager.prototype.configureRuntime = originals.configure;
      PluginManager.prototype.stop = originals.managerStop;
      PluginRuntime.prototype.reconcile = originals.reconcile;
      PluginRuntime.prototype.close = originals.runtimeClose;
      // Rescue must attempt every independent cleanup even if one close fails.
      await fixtureScope((cleanup) => {
        for (const root of roots) {
          cleanup.defer(() =>
            originals.remove(root, { recursive: true }).catch((error) => {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            })
          );
        }
        cleanup.defer(() => delivery.restore());
        cleanup.defer(() => restoreState(previous));
        for (const hub of hubs) {
          cleanup.defer(() => {
            try {
              originals.hubStop.call(hub);
            } catch { /* already closed */ }
          });
        }
        for (const manager of managers) {
          cleanup.defer(() => originals.managerStop.call(manager));
        }
        for (const runtime of runtimes) {
          cleanup.defer(() => originals.runtimeClose.call(runtime));
        }
      });
    }
  });
}

Deno.test("fixture roots: compatibility construction fails before caller try without leaking its root", async () => {
  const mkdir = Deno.mkdir, temp = Deno.makeTempDir;
  const roots: string[] = [], primary = new Error("root preparation");
  Deno.makeTempDir = async (options) => {
    const root = await temp(options);
    roots.push(root);
    return root;
  };
  Deno.mkdir = () => Promise.reject(primary);
  try {
    let error: unknown;
    try {
      await pluginFixture();
    } catch (caught) {
      error = caught;
    }
    assertEquals(error, primary);
    assertEquals(roots.length, 1);
    await assertRejects(() => Deno.stat(roots[0]), Deno.errors.NotFound);
  } finally {
    Deno.mkdir = mkdir;
    Deno.makeTempDir = temp;
    for (const root of roots) {
      await Deno.remove(root, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
});

Deno.test("fixture operations: borrowed roots survive while callback-owned work and state retire", async () => {
  await withPluginFixture(async (fixture) => {
    const borrowed = { ...fixture, dispose: () => Promise.resolve() };
    let scope!: FixtureScope;
    await withPluginOperationsFixture(
      { ...scopePlugin, fixture: borrowed },
      (operations) => {
        scope = operations.scope;
      },
    );
    assertEquals(scope.size, 0);
    assert((await Deno.stat(fixture.root)).isDirectory);
  });
});

Deno.test("fixture operations: compatibility close retains evidence explicitly and is idempotent", async () => {
  const fixture = await pluginOperationsFixture(scopePlugin);
  try {
    await fixture.close();
    await fixture.close();
    assertEquals(fixture.scope.size, 0);
    assert((await Deno.stat(fixture.fixture.root)).isDirectory);
    assertThrows(() => fixture.hub.store.files());
  } finally {
    try {
      await fixture.close();
    } finally {
      await fixture.fixture.dispose();
    }
  }
});

Deno.test("fixture operations: retained evidence disposal survives a rejected close", async () => {
  const fixture = await pluginOperationsFixture(scopePlugin);
  const primary = new Error("retained close failure");
  fixture.scope.defer(() => {
    throw primary;
  });
  try {
    await assertRejects(
      async () => {
        try {
          await fixture.close();
        } finally {
          try {
            await fixture.close();
          } finally {
            await fixture.fixture.dispose();
          }
        }
      },
      Error,
      primary.message,
    );
    await assertRejects(
      () => Deno.stat(fixture.fixture.root),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(fixture.fixture.root, { recursive: true }).catch(
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      },
    );
  }
});

const scenarios = [
  {
    name: "bundle reconcile removes opted-out fixture",
    id: "recorder",
    stage: "reconcile",
    retain: false,
    setup: () => bundle({ retain: false }),
  },
  {
    name: "bundle settled rejection retains evidence",
    id: "recorder",
    stage: "settled",
    retain: true,
    setup: () => bundle(),
  },
  {
    name: "bundle cleanup errors preserve setup error",
    id: "recorder",
    stage: "reconcile",
    retain: true,
    cleanupErrors: true,
    setup: () => bundle({ retain: false }),
  },
  {
    name: "auxiliary reconcile retains evidence",
    id: "auxiliary",
    stage: "reconcile",
    retain: true,
    setup: () => auxiliaryFixture(),
  },
  {
    name: "backup reconcile restores state",
    id: "globnotes-backup",
    stage: "reconcile",
    retain: true,
    setup: () => backupFixture(),
  },
  {
    name: "auxiliary partial configure closes manager-owned runtime",
    id: "auxiliary",
    stage: "configure",
    retain: true,
    setup: () => auxiliaryFixture(),
  },
];

for (const scenario of scenarios) {
  Deno.test(`fixture setup cleanup: ${scenario.name}`, async () => {
    const setupError = new Error("fixture setup sentinel");
    const cleanupError = new Error("fixture cleanup sentinel");
    const events: string[] = [];
    const roots: string[] = [];
    const managers: PluginManager[] = [];
    const runtimes: PluginRuntime[] = [];
    const hubs: VaultHub[] = [];
    const scanNow = VaultHub.prototype.scanNow;
    const previousState = { ...state };
    const makeTempDir = Deno.makeTempDir;
    const remove = Deno.remove;
    const configure = PluginManager.prototype.configureRuntime;
    const reconcile = PluginRuntime.prototype.reconcile;
    const close = PluginRuntime.prototype.close;
    const stop = PluginManager.prototype.stop;
    const gate = new WorkerDeliveryGate();
    gate.holdHeartbeat = false;
    VaultHub.prototype.scanNow = function (...args) {
      if (!hubs.includes(this)) hubs.push(this);
      return scanNow.apply(this, args);
    };
    Deno.makeTempDir = async (options) => {
      const root = await makeTempDir(options);
      if (options?.prefix === "globnotes-platform-") roots.push(root);
      return root;
    };
    Deno.remove = async (path, options) => {
      if (roots.includes(String(path))) {
        events.push("fixture");
        if (scenario.cleanupErrors) throw cleanupError;
      }
      await remove(path, options);
    };
    PluginManager.prototype.configureRuntime = function (...args) {
      managers.push(this);
      const runtime = configure.apply(this, args);
      runtimes.push(runtime);
      if (scenario.stage === "configure") throw setupError;
      return runtime;
    };
    PluginRuntime.prototype.reconcile = async function () {
      await reconcile.call(this);
      await pluginSettled(this, scenario.id, "ready");
      if (scenario.stage === "settled") {
        const status = this.status;
        this.status = () => {
          this.status = status;
          throw setupError;
        };
        return;
      }
      throw setupError;
    };
    PluginRuntime.prototype.close = async function () {
      events.push("runtime");
      await close.call(this);
      if (scenario.cleanupErrors) throw cleanupError;
    };
    PluginManager.prototype.stop = function () {
      events.push("manager");
      stop.call(this);
      if (scenario.cleanupErrors) throw cleanupError;
    };
    try {
      const error = await bounded(
        scenario.setup().then(() => undefined, (error: unknown) => error),
        scenario.name,
        10000,
      );
      assertEquals(error, setupError);
      assertEquals(events.slice(0, 2), ["runtime", "manager"]);
      assertEquals({ ...state }, previousState);
      assertEquals(managers.length, 1);
      assertEquals(runtimes.length, 1);
      assertEquals(runtimes[0].isEnabled(scenario.id), false);
      assertEquals(runtimes[0].commands(), []);
      if (scenario.name.startsWith("bundle")) {
        assertEquals(hubs.length, 1);
        assertThrows(() => hubs[0].store.files());
      }
      if (scenario.stage !== "configure") assert(gate.workers.length > 0);
      assert(gate.workers.every((worker) => worker.terminated > 0));
      assertEquals(roots.length, 1);
      if (scenario.retain) {
        assert((await Deno.stat(roots[0])).isDirectory);
      } else {
        await assertRejects(() => Deno.stat(roots[0]), Deno.errors.NotFound);
      }
      if (scenario.cleanupErrors) {
        assertEquals(events, ["runtime", "manager", "fixture"]);
      }
    } finally {
      Deno.makeTempDir = makeTempDir;
      Deno.remove = remove;
      PluginManager.prototype.configureRuntime = configure;
      PluginRuntime.prototype.reconcile = reconcile;
      PluginRuntime.prototype.close = close;
      PluginManager.prototype.stop = stop;
      VaultHub.prototype.scanNow = scanNow;
      await fixtureScope((cleanup) => {
        for (const root of roots) {
          cleanup.defer(() =>
            remove(root, { recursive: true }).catch((error) => {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            })
          );
        }
        cleanup.defer(() => gate.restore());
        cleanup.defer(() => restoreState(previousState));
        for (const hub of hubs) {
          cleanup.defer(() => {
            try {
              hub.stop();
            } catch { /* already closed by the failed setup owner */ }
          });
        }
        for (const manager of managers) cleanup.defer(() => stop.call(manager));
        for (const runtime of runtimes) {
          cleanup.defer(() => close.call(runtime));
        }
      });
    }
  });
}
