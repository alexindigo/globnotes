// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
} from "./helpers/fixture_scope_engine.ts";
import { OwnershipError } from "../shared/ownership.js";
import { bootServer, type TestServer } from "./helpers/boot.ts";
import { buildClient } from "./helpers/completed_build.ts";
import {
  captureOwnedCommand,
  type ChildSignalClock,
  type OwnedChild,
  spawnOwnedChild,
} from "./helpers/owned_child.ts";
import { command, DENO } from "./helpers/process.ts";
import { publishRecord } from "./helpers/process_records.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { isPromise } from "./helpers/fixture_coordination.ts";

function scheduledSignals() {
  const tasks: {
    callback: () => void;
    milliseconds: number;
    cleared: boolean;
  }[] = [];
  const clock: ChildSignalClock = {
    set(callback, milliseconds) {
      const task = { callback, milliseconds, cleared: false };
      tasks.push(task);
      return () => {
        task.cleared = true;
      };
    },
  };
  return { clock, tasks };
}
const waitingArgs = ["eval", "await Deno.stdin.read(new Uint8Array(1));"];
const options = {
  args: waitingArgs,
  stdin: "piped",
  stdout: "null",
  stderr: "null",
} as const;
async function finish(child: OwnedChild) {
  const writer = child.stdin.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
  return await child.exited;
}
async function absent(pid: number) {
  const result = await command("bash", {
    args: ["-c", 'kill -0 "$1"', "owned-child-absence", String(pid)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.success, false);
  assert(new TextDecoder().decode(result.stderr).includes("No such process"));
}

for (const launch of [captureOwnedCommand, spawnOwnedChild]) {
  Deno.test(`child owner: ${launch.name} does not spawn after an environment getter retires its scope`, async () => {
    const lifetime = createFixtureScope();
    let closing: Promise<void> | undefined;
    const work = launch(lifetime.scope, "/nonexistent/cancelled-child", {
      env: {
        get FIXTURE_VALUE() {
          closing = lifetime.close();
          return "unused";
        },
      },
    });
    try {
      assert(closing);
      const error = await assertRejects(
        () => work,
        OwnershipError,
        "Fixture scope retired",
      );
      assertStrictEquals(error, lifetime.scope.signal.reason);
      await bounded(closing, "construction cancellation without spawn");
    } finally {
      await lifetime.close();
    }
  });
}

Deno.test("child owner: capture kills and joins a group cancelled during native spawn", async () => {
  const lifetime = createFixtureScope();
  let closing: Promise<void> | undefined;
  const args = ["-c", 'kill -STOP "$$"'];
  // Native argument capture runs inside spawn, after the last pre-spawn check.
  Object.defineProperty(args, 0, {
    get() {
      closing = lifetime.close();
      return "-c";
    },
  });
  const statusDescriptor = Object.getOwnPropertyDescriptor(
    Deno.ChildProcess.prototype,
    "status",
  )!;
  const text = Response.prototype.text;
  let child: Deno.ChildProcess | undefined;
  let status: Deno.CommandStatus | undefined;
  const drained: string[] = [];
  let work!: ReturnType<typeof captureOwnedCommand>;
  try {
    Object.defineProperty(Deno.ChildProcess.prototype, "status", {
      ...statusDescriptor,
      get() {
        child = this;
        return (statusDescriptor.get!.call(this) as Promise<Deno.CommandStatus>)
          .then((result) => status = result);
      },
    });
    Response.prototype.text = async function () {
      const value = await text.call(this);
      drained.push(value);
      return value;
    };
    work = captureOwnedCommand(lifetime.scope, "bash", { args });
    work.catch(() => {});
  } finally {
    Object.defineProperty(
      Deno.ChildProcess.prototype,
      "status",
      statusDescriptor,
    );
    Response.prototype.text = text;
  }
  try {
    assert(closing);
    await bounded(closing, "cancelled group status and pipe drain");
    const error = await assertRejects(
      () => work,
      OwnershipError,
      "Fixture scope retired",
    );
    assertStrictEquals(error, lifetime.scope.signal.reason);
    assertEquals([status, drained], [
      { success: false, code: 137, signal: "SIGKILL" },
      ["", ""],
    ]);
  } finally {
    // Rescue a regressed owner only after the containment verdict.
    if (child && !status) child.kill("SIGKILL");
    await lifetime.close();
  }
});

Deno.test("child owner: normal capture returns status and both streams", async () => {
  await fixtureScope(async (scope) => {
    assertEquals(
      await captureOwnedCommand(scope, "bash", {
        args: ["-c", "printf out; printf err >&2; exit 17"],
      }),
      {
        status: { success: false, code: 17, signal: null },
        stdout: "out",
        stderr: "err",
      },
    );
  });
});

Deno.test("child owner review: retired and failed acquisition reject without escaped children", async () => {
  let scope!: FixtureScope;
  await fixtureScope(async (owner) => {
    scope = owner;
    const before = scope.size;
    const failed = spawnOwnedChild(
      scope,
      "/nonexistent/p12-review-child",
      options,
    );
    assertEquals(isPromise(failed), true);
    await assertRejects(
      () => failed,
      Deno.errors.NotFound,
      "/nonexistent/p12-review-child",
    );
    assertEquals(scope.size, before);
  });
  const retired = spawnOwnedChild(scope, DENO, options);
  assertEquals(isPromise(retired), true);
  await assertRejects(() => retired, OwnershipError, "retired");
  assertEquals(scope.size, 0);
});

for (const port of ["options", "scheduler"] as const) {
  Deno.test(`child owner review: throwing ${port} getter rejects only after acquisition admission`, async () => {
    const failure = new Error(`${port} getter failed`);
    const reads: string[] = [];
    const launchOptions = {
      ...options,
      get args() {
        reads.push("options");
        if (port === "options") throw failure;
        return waitingArgs;
      },
    };
    const scheduler: ChildSignalClock = {
      get set(): ChildSignalClock["set"] {
        reads.push("scheduler");
        throw failure;
      },
    };
    let retired!: FixtureScope;
    await fixtureScope(async (scope) => {
      retired = scope;
      const acquisition = spawnOwnedChild(
        scope,
        DENO,
        launchOptions,
        scheduler,
      );
      assertEquals(isPromise(acquisition), true);
      assertStrictEquals(
        await assertRejects(() => acquisition, Error, failure.message),
        failure,
      );
      assertEquals([reads, scope.size], [
        port === "options" ? ["options"] : ["options", "scheduler"],
        0,
      ]);
    });
    reads.length = 0;
    const acquisition = spawnOwnedChild(
      retired,
      DENO,
      launchOptions,
      scheduler,
    );
    assertEquals(isPromise(acquisition), true);
    await assertRejects(() => acquisition, OwnershipError, "retired");
    assertEquals([reads, retired.size], [[], 0]);
  });
}

Deno.test("child owner review: scheduler is captured once with its original receiver", async () => {
  await fixtureScope(async (scope) => {
    let reads = 0;
    const receivers: unknown[] = [];
    const scheduler: ChildSignalClock = {
      get set() {
        reads++;
        return function (this: ChildSignalClock) {
          receivers.push(this);
          return () => {};
        };
      },
    };
    const child =
      (await spawnOwnedChild(scope, DENO, options, scheduler)).value;
    child.signalAfter(5000, "SIGKILL")();
    child.signalAfter(5000, "SIGKILL")();
    assertEquals(reads, 1);
    assertEquals(receivers.length, 2);
    assertStrictEquals(receivers[0], scheduler);
    assertStrictEquals(receivers[1], scheduler);
    assertEquals(await finish(child), { success: true, code: 0, signal: null });
  });
});

for (
  const option of ["cwd", "host", "origin", "healthFetch", "denoArgs"] as const
) {
  Deno.test(`child owner review: boot ${option} getter errors use the async rejection channel`, async () => {
    const failure = new Error(`boot ${option} getter failed`);
    let reads = 0;
    const options = Object.defineProperty({}, option, {
      get() {
        reads++;
        throw failure;
      },
    });
    const starting = bootServer({}, options);
    assertEquals(isPromise(starting), true);
    assertStrictEquals(
      await assertRejects(() => starting, Error, failure.message),
      failure,
    );
    assertEquals(reads, 1);
  });
}

Deno.test("child owner review: boot joins rejected actual status without an unhandled readiness rejection", async () => {
  await fixtureScope(async (scope) => {
    const root = (await scope.acquire(
      () => Deno.makeTempDir({ prefix: "child-status-review-" }),
      (root) => Deno.remove(root, { recursive: true }),
    )).value;
    const preload = `${root}/preload.mjs`, record = `${root}/child.json`;
    await Deno.writeTextFile(
      preload,
      `Deno.writeTextFileSync(${
        JSON.stringify(record)
      },JSON.stringify({pid:Deno.pid,cwd:Deno.cwd(),vault:Deno.env.get("GLOBNOTES_GLOBNOTES_PATH")??Deno.env.get("GLOBNOTES__VAULTS_BASEPATH")+"/globnotes"})); console.log("globnotes listening on http://127.0.0.1:1"); Deno.exit(17);`,
    );
    // Build preparation owns another child. Complete it before observing only
    // the server's status, including when this checkout has production assets.
    const build = await buildClient(scope);
    const original = Object.getOwnPropertyDescriptor(
      Deno.ChildProcess.prototype,
      "status",
    )!;
    assert(original.get);
    const failure = new Error("P12 actual status rejection");
    scope.defer(() =>
      Object.defineProperty(Deno.ChildProcess.prototype, "status", original)
    );
    Object.defineProperty(Deno.ChildProcess.prototype, "status", {
      ...original,
      get() {
        return (original.get!.call(this) as Promise<Deno.CommandStatus>).then(
          () => {
            throw failure;
          },
        );
      },
    });
    const error = await assertRejects(
      () => bootServer({}, { build, denoArgs: ["--preload", preload] }),
      Error,
      "P12 actual status rejection",
    );
    assertStrictEquals(error, failure);
    const child = JSON.parse(await Deno.readTextFile(record));
    await absent(child.pid);
    await assertRejects(
      () => Deno.stat(child.cwd),
      Deno.errors.NotFound,
      `stat '${child.cwd}'`,
    );
    await assertRejects(
      () => Deno.stat(child.vault),
      Deno.errors.NotFound,
      `stat '${child.vault}'`,
    );
  });
});

Deno.test("child owner: actual status retires every signal timer before held mandatory collection", async () => {
  await fixtureScope(async (scope) => {
    let signals = 0;
    let actualStatus!: Promise<Deno.CommandStatus>;
    const descriptor = Object.getOwnPropertyDescriptor(
      Deno.ChildProcess.prototype,
      "status",
    )!;
    scope.defer(() =>
      Object.defineProperty(Deno.ChildProcess.prototype, "status", descriptor)
    );
    Object.defineProperty(Deno.ChildProcess.prototype, "status", {
      ...descriptor,
      get() {
        return actualStatus = descriptor.get!.call(this);
      },
    });
    await scope.acquire(() => {
      const original = Deno.ChildProcess.prototype.kill;
      Deno.ChildProcess.prototype.kill = function (signo) {
        signals++;
        return original.call(this, signo);
      };
      return original;
    }, (original) => {
      Deno.ChildProcess.prototype.kill = original;
    });
    const scheduler = scheduledSignals();
    const child =
      (await spawnOwnedChild(scope, DENO, options, scheduler.clock)).value;
    child.signalAfter(5000, "SIGKILL");
    child.signalAfter(15000, "SIGTERM");
    const release = Promise.withResolvers<void>();
    let collected = false;
    const completion = child.exited.then(async () => {
      await release.promise;
      collected = true;
    });
    try {
      const writer = child.stdin.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
      const native = await actualStatus;
      assertEquals(native, { success: true, code: 0, signal: null });
      assertEquals(child.status(), native);
      assertEquals(collected, false);
      assertEquals(scheduler.tasks.map((task) => task.cleared), [true, true]);
      scheduler.tasks.forEach((task) => task.callback());
      assertEquals(child.signal("SIGKILL"), false);
      child.signalAfter(1, "SIGKILL");
      assertEquals(scheduler.tasks.length, 2);
      assertEquals(
        signals,
        0,
        "no OS signal may follow actual status, even from a queued callback",
      );
      await absent(child.pid);
    } finally {
      release.resolve();
      await completion;
    }
    assertEquals(collected, true);
  });
});

Deno.test("child owner: a cancelled signal callback is inert while the child is still running", async () => {
  await fixtureScope(async (scope) => {
    const scheduler = scheduledSignals();
    const child =
      (await spawnOwnedChild(scope, DENO, options, scheduler.clock)).value;
    const cancel = child.signalAfter(5000, "SIGKILL");
    cancel();
    cancel();
    scheduler.tasks[0].callback();
    assertEquals(child.status(), null);
    assertEquals((await finish(child)).code, 0);
  });
});

Deno.test("child owner: a failed timer clear remains tracked for status retirement", async () => {
  await fixtureScope(async (scope) => {
    const events: string[] = [];
    const failure = new Error("timer clear failed");
    let callback!: () => void;
    const scheduler: ChildSignalClock = {
      set(invoke) {
        callback = invoke;
        return () => {
          events.push(events.length === 0 ? "clear failed" : "cleared");
          cancel();
          if (events.length === 1) throw failure;
        };
      },
    };
    const child =
      (await spawnOwnedChild(scope, DENO, options, scheduler)).value;
    const cancel = child.signalAfter(5000, "SIGKILL");
    assertStrictEquals(assertThrows(cancel, Error, failure.message), failure);
    callback();
    assertEquals(await finish(child), { success: true, code: 0, signal: null });
    assertEquals(events, ["clear failed", "cleared"]);
  });
});

Deno.test("child owner: successful timer clearing joins reentrant cancellation", async () => {
  await fixtureScope(async (scope) => {
    const events: string[] = [];
    let callback!: () => void;
    const scheduler: ChildSignalClock = {
      set(invoke) {
        callback = invoke;
        return () => {
          events.push("clear entered");
          cancel();
          events.push("clear returned");
        };
      },
    };
    const child =
      (await spawnOwnedChild(scope, DENO, options, scheduler)).value;
    const cancel = child.signalAfter(5000, "SIGKILL");
    cancel();
    cancel();
    callback();
    assertEquals(await finish(child), { success: true, code: 0, signal: null });
    assertEquals(events, ["clear entered", "clear returned"]);
  });
});

Deno.test("child owner: termination owns one escalation and joins the actual child", async () => {
  await fixtureScope(async (scope) => {
    const scheduler = scheduledSignals();
    const child =
      (await spawnOwnedChild(scope, DENO, options, scheduler.clock)).value;
    const first = child.terminate(5000);
    assertStrictEquals(child.terminate(5000), first);
    await first;
    assertEquals(scheduler.tasks.map((task) => task.milliseconds), [5000]);
    assertEquals(scheduler.tasks[0].cleared, true);
    scheduler.tasks[0].callback();
    assertEquals(child.signal("SIGTERM"), false);
    await absent(child.pid);
  });
});

for (const phase of ["setup", "publication"] as const) {
  Deno.test(`child owner: failed ${phase} before return reaps before releasing its cwd and preserves the cause`, async () => {
    let child: OwnedChild | undefined, cwd = "", primary: unknown;
    const sentinel = new Error("setup sentinel");
    await fixtureScope(async (rescue) => {
      rescue.defer(async () => {
        if (!cwd) return;
        try {
          await Deno.remove(cwd, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      });
      rescue.defer(() => child?.reap());
      const failure = await assertRejects(
        () =>
          fixtureScope(async (scope) => {
            cwd = (await scope.acquire(
              () => Deno.makeTempDir({ prefix: "owned-child-" }),
              async (root) => {
                assert(
                  child?.status(),
                  "child must be reaped before cwd release",
                );
                await Deno.remove(root, { recursive: true });
              },
            )).value;
            child =
              (await spawnOwnedChild(scope, DENO, { ...options, cwd })).value;
            try {
              if (phase === "setup") throw sentinel;
              await publishRecord(cwd, "{}"); // Cannot publish a file over the owned directory.
            } catch (error) {
              primary = error;
              throw error;
            }
          }),
        phase === "setup" ? Error : Deno.errors.IsADirectory,
        phase === "setup" ? "setup sentinel" : "Is a directory",
      );
      assertStrictEquals(failure, primary);
      if (phase === "setup") assertStrictEquals(primary, sentinel);
      assert(child?.status());
      await absent(child!.pid);
      await assertRejects(
        () => Deno.stat(cwd),
        Deno.errors.NotFound,
        `stat '${cwd}'`,
      );
    });
  });
}

Deno.test("child owner: a failed spawn releases its reserved root without returning a handle", async () => {
  let cwd = "", returned = false;
  await assertRejects(
    () =>
      fixtureScope(async (scope) => {
        cwd = (await scope.acquire(
          () => Deno.makeTempDir({ prefix: "child-spawn-failure-" }),
          (root) => Deno.remove(root, { recursive: true }),
        )).value;
        await spawnOwnedChild(scope, `${cwd}/missing-program`, {
          stdout: "null",
          stderr: "null",
        });
        returned = true;
      }),
    Deno.errors.NotFound,
    "Failed to spawn",
  );
  assertEquals(returned, false);
  await assertRejects(
    () => Deno.stat(cwd),
    Deno.errors.NotFound,
    `stat '${cwd}'`,
  );
});

Deno.test("child owner: scope disposal reaps a child even when another disposer fails", async () => {
  let child: OwnedChild | undefined;
  await assertRejects(
    () =>
      fixtureScope(async (scope) => {
        child = (await spawnOwnedChild(scope, DENO, options)).value;
        scope.defer(() => {
          throw new Error("other cleanup failed");
        });
      }),
    Error,
    "other cleanup failed",
  );
  assert(child?.status());
  await absent(child!.pid);
  const writer = child!.stdin.getWriter();
  try {
    await assertRejects(
      () => writer.write(new Uint8Array([1])),
      TypeError,
      "closed",
    );
  } finally {
    writer.releaseLock();
  }
});

Deno.test("child owner: failed status subscription closes stdin and reaps before acquisition rejects", async () => {
  await fixtureScope(async (scope) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Deno.ChildProcess.prototype,
      "status",
    )!;
    scope.defer(() =>
      Object.defineProperty(Deno.ChildProcess.prototype, "status", descriptor)
    );
    let child: Deno.ChildProcess | undefined;
    const cancellations: string[] = [];
    scope.defer(async () => {
      // Rescue only after the verdict, without reading and closing pipes for
      // the implementation under test.
      if (child) {
        await Promise.all([child.stdout.cancel(), child.stderr.cancel()]);
      }
    });
    const failure = new Error("child status construction failed");
    Object.defineProperty(Deno.ChildProcess.prototype, "status", {
      ...descriptor,
      get() {
        if (!child) {
          child = this;
          for (const name of ["stdout", "stderr"] as const) {
            const stream = child![name], cancel = stream.cancel;
            stream.cancel = function (reason) {
              cancellations.push(name);
              return cancel.call(this, reason);
            };
          }
          throw failure;
        }
        return descriptor.get!.call(this);
      },
    });
    const error = await assertRejects(
      () =>
        bounded(
          spawnOwnedChild(scope, DENO, {
            ...options,
            stdout: "piped",
            stderr: "piped",
          }),
          "failed child status construction",
        ),
      Error,
      failure.message,
    );
    assertStrictEquals(error, failure);
    await absent(child!.pid);
    const writer = child!.stdin.getWriter();
    try {
      await assertRejects(
        () => writer.write(new Uint8Array([1])),
        TypeError,
        "closed",
      );
    } finally {
      writer.releaseLock();
    }
    assertEquals(cancellations, ["stderr", "stdout"]);
    const readers = [child!.stdout.getReader(), child!.stderr.getReader()];
    try {
      assertEquals(
        await bounded(
          Promise.all(readers.map((reader) => reader.closed)),
          "failed construction pipes closed",
        ),
        [undefined, undefined],
      );
    } finally {
      for (const reader of readers) reader.releaseLock();
    }
  });
});

Deno.test("child owner: signalling in the native exit callback joins Deno's already-terminated status", async () => {
  await fixtureScope(async (scope) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Deno.ChildProcess.prototype,
      "status",
    )!;
    const nativeKill = Deno.ChildProcess.prototype.kill;
    scope.defer(() =>
      Object.defineProperty(Deno.ChildProcess.prototype, "status", descriptor)
    );
    scope.defer(() => {
      Deno.ChildProcess.prototype.kill = nativeKill;
    });
    const raced = Promise.withResolvers<unknown>();
    let nativeFailure: unknown;
    Deno.ChildProcess.prototype.kill = function (signal) {
      try {
        return nativeKill.call(this, signal);
      } catch (error) {
        nativeFailure = error;
        throw error;
      }
    };
    Object.defineProperty(Deno.ChildProcess.prototype, "status", {
      ...descriptor,
      get() {
        const actual = descriptor.get!.call(this) as Promise<
          Deno.CommandStatus
        >;
        actual.then(() => {
          try {
            raced.resolve(owned.signal("SIGTERM"));
          } catch (error) {
            raced.resolve(error);
          }
        });
        return actual;
      },
    });
    const owned = (await spawnOwnedChild(scope, DENO, options)).value;
    const result = await finish(owned);
    assertInstanceOf(nativeFailure, TypeError);
    assertEquals([
      await bounded(raced.promise, "native exit signal callback"),
      nativeFailure.message,
      result,
      await owned.reap(),
    ], [
      false,
      "Child process has already terminated",
      { success: true, code: 0, signal: null },
      { success: true, code: 0, signal: null },
    ]);
  });
});

Deno.test("child owner: cancellation reaps before admitted child work drains and roots release", async () => {
  const events: string[] = [];
  let child: OwnedChild | undefined;
  let rejected: Promise<Error> | undefined;
  await fixtureScope(async (rescue) => {
    rescue.defer(() => child?.reap());
    await bounded(
      fixtureScope(async (scope) => {
        scope.defer(() => events.push("root released"));
        child = (await spawnOwnedChild(scope, DENO, options)).value;
        const admitted = scope.admit(async () => {
          events.push("admitted");
          const status = await child!.exited;
          events.push("child reaped");
          return status;
        });
        rejected = assertRejects(() => admitted, OwnershipError, "retired");
        assertEquals(events, ["admitted"]);
      }),
      "child cancellation before admission drain",
    );
    await rejected;
    assertEquals(events, ["admitted", "child reaped", "root released"]);
    assertEquals(child!.status()?.signal, "SIGKILL");
    await absent(child!.pid);
  });
});

for (
  const outcome of [
    "response",
    "error",
    "pending-fetch",
    "pending-cancel",
    "rejected-cancel",
  ] as const
) {
  Deno.test(`child owner: boot discards a health ${outcome} completed after actual child exit`, async () => {
    await fixtureScope(async (scope) => {
      const root = (await scope.acquire(() =>
        Deno.makeTempDir({ prefix: "boot-exit-barrier-" }), (root) =>
        Deno.remove(root, { recursive: true }))).value;
      const preload = `${root}/preload.mjs`, record = `${root}/child.json`;
      await Deno.writeTextFile(
        preload,
        `
Deno.writeTextFileSync(${
          JSON.stringify(record)
        }, JSON.stringify({pid:Deno.pid,cwd:Deno.cwd(),vault:Deno.env.get("GLOBNOTES_GLOBNOTES_PATH")??Deno.env.get("GLOBNOTES__VAULTS_BASEPATH")+"/globnotes"}));
Deno.serve({hostname:"127.0.0.1",port:0,onListen({port}) {console.log("globnotes listening on http://127.0.0.1:"+port);}}, request => {
  if(new URL(request.url).pathname === "/exit") Deno.exit(17);
  return new Response("healthy");
});
await new Promise(()=>{});
`,
      );
      const build = await buildClient(scope);
      const descriptor = Object.getOwnPropertyDescriptor(
        Deno.ChildProcess.prototype,
        "status",
      )!;
      scope.defer(() =>
        Object.defineProperty(Deno.ChildProcess.prototype, "status", descriptor)
      );
      let actualStatus!: Promise<Deno.CommandStatus>;
      Object.defineProperty(Deno.ChildProcess.prototype, "status", {
        ...descriptor,
        get() {
          return actualStatus = descriptor.get!.call(this);
        },
      });
      const events: string[] = [];
      const cancelled = Promise.withResolvers<void>();
      let observingExit: Promise<void> | undefined;
      const healthFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        events.push("health received");
        await response.body?.cancel();
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        observingExit = (async () => {
          await fetch(new URL("/exit", url)).catch(() => {});
          assertEquals(
            await bounded(actualStatus, "health fixture actual exit"),
            {
              success: false,
              code: 17,
              signal: null,
            },
          );
          events.push("child exited");
        })();
        await observingExit;
        if (outcome === "error") {
          throw new Error("stale health error");
        }
        if (outcome === "pending-fetch") {
          return await new Promise<Response>(() => {});
        }
        if (outcome === "pending-cancel" || outcome === "rejected-cancel") {
          return new Response(
            new ReadableStream({
              cancel() {
                events.push("body cancel");
                cancelled.resolve();
                return outcome === "pending-cancel"
                  ? new Promise<void>(() => {})
                  : Promise.reject(new Error("body cancellation failed"));
              },
            }),
          );
        }
        return response;
      };
      let escaped: TestServer | undefined;
      scope.defer(() =>
        escaped?.close().catch(() => {})
      );
      await assertRejects(
        () =>
          bounded(
            bootServer({}, {
              build,
              denoArgs: ["--preload", preload],
              healthFetch,
            })
              .then(
                (server) => {
                  escaped = server;
                  return server;
                },
              ),
            "boot exit barrier",
          ),
        Error,
        "server exited before it was healthy",
      );
      // Boot must not join uncooperative IO, but this test owns the injected
      // callback's real exit observation before checking its event consumer.
      assert(observingExit);
      await bounded(observingExit, "health callback exit observation");
      if (outcome === "pending-cancel" || outcome === "rejected-cancel") {
        await bounded(
          cancelled.promise,
          "health response cancellation invoked",
        );
      }
      assertEquals([events, escaped], [
        [
          "health received",
          "child exited",
          ...(outcome === "pending-cancel" || outcome === "rejected-cancel"
            ? ["body cancel"]
            : []),
        ],
        undefined,
      ]);
      const child = JSON.parse(await Deno.readTextFile(record));
      await absent(child.pid);
      for (const directory of [child.cwd, child.vault]) {
        await assertRejects(
          () => Deno.stat(directory),
          Deno.errors.NotFound,
          `stat '${directory}'`,
        );
      }
    });
  });
}
