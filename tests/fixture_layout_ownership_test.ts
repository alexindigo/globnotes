// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import * as path from "@std/path";
import {
  createFixtureScope,
  type FixtureScope,
  fixtureScope,
} from "./helpers/fixture_scope_engine.ts";
import {
  admitLayout,
  bindLayout,
  type FixtureLayout,
  fixtureLayout,
  layoutEnvironment,
} from "./helpers/fixture_layout.ts";
import {
  buildClient,
  completeBuild,
  type CompletedBuild,
  installCompletedBuild,
  repositoryBuild,
} from "./helpers/completed_build_engine.ts";
import { bootServer, UnexpectedServerExitError } from "./helpers/boot.ts";
import { workMilestone } from "./helpers/product_settlement.ts";
import { OwnershipError } from "../shared/ownership.js";
import { bounded } from "./helpers/worker_liveness.ts";
import { bootPrefixAuthFixture } from "../client/tests/e2e/prefix-auth-fixture.mjs";
import { spawnOwnedChild } from "./helpers/owned_child.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import {
  fixtureGate,
  fixtureTest,
  isPromise,
  waitForCancellation,
} from "./helpers/fixture_coordination.ts";

const html =
  "<!doctype html><title>immutable fixture</title><p>completed bytes</p>";
const fixtureBuild = (scope: FixtureScope) =>
  completeBuild(scope, async (output) => {
    await Deno.mkdir(output);
    await Deno.writeTextFile(`${output}/index.html`, html);
  });
const absentRoot = async (root: string) => {
  const message = `No such file or directory (os error 2): stat '${root}'`;
  const error = await assertRejects(
    () => Deno.stat(root),
    Deno.errors.NotFound,
    message,
  );
  assertEquals(error.message, message);
};
const note = async (base: string, name: string, content: string) => {
  const response = await fetch(`${base}/_/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: name, content }),
  });
  assertEquals(response.status, 200);
  await response.body?.cancel();
};

Deno.test("layout review: construction captures every input and option once before awaits", async () => {
  await fixtureScope(async (scope) => {
    const root = (await scope.acquire(() =>
      Deno.makeTempDir({ prefix: "layout-capture-" }), (root) =>
      Deno.remove(root, { recursive: true }))).value;
    const reads: string[] = [];
    const capture = (name: string, value: unknown) => ({
      enumerable: true,
      get() {
        reads.push(name);
        return value;
      },
    });
    const inputs = Object.defineProperties({}, {
      GLOBNOTES__VAULTS_BASEPATH: capture("instance", root),
      GLOBNOTES_GLOBNOTES_PATH: capture("vault", `${root}/notes`),
      GLOBNOTES__METADATA_PATH: capture("metadata", `${root}/state`),
    });
    const options = Object.defineProperties({}, {
      cwd: capture("cwd", `${root}/app`),
      artifacts: capture("artifacts", `${root}/evidence`),
      build: capture("build", undefined),
      retainPersistent: capture("retention", undefined),
    });
    const layout = await fixtureLayout(scope, inputs, options);
    assertEquals(reads, [
      "instance",
      "vault",
      "metadata",
      "cwd",
      "artifacts",
      "build",
      "retention",
    ]);
    assertEquals([
      layout.instance,
      layout.vault,
      layout.metadata,
      layout.cwd,
      layout.artifacts,
      layout.environment,
    ], [
      root,
      `${root}/notes`,
      `${root}/state/globnotes`,
      `${root}/app`,
      `${root}/evidence`,
      {
        GLOBNOTES__VAULTS_BASEPATH: root,
        GLOBNOTES_GLOBNOTES_PATH: `${root}/notes`,
        GLOBNOTES__METADATA_PATH: `${root}/state`,
      },
    ]);
  });
});

Deno.test("layout review: boot captures options once and concurrent close joins its actual completion", async () => {
  await fixtureScope(async (scope) => {
    const build = await fixtureBuild(scope),
      layout = await fixtureLayout(scope, {}, { build });
    const reads: string[] = [];
    const options = Object.defineProperties({}, {
      layout: {
        enumerable: true,
        get() {
          reads.push("layout");
          return layout;
        },
      },
      healthFetch: {
        enumerable: true,
        get() {
          reads.push("healthFetch");
          return fetch;
        },
      },
      denoArgs: {
        enumerable: true,
        get() {
          reads.push("denoArgs");
          return [];
        },
      },
    });
    const inputs = Object.defineProperty({}, "fixtureAuth", {
      enumerable: true,
      get() {
        reads.push("fixtureAuth");
        return { auth_type: "none" };
      },
    });
    const server = (await scope.acquire(() =>
      bootServer(inputs, options), (server) =>
      server.close())).value;
    assertEquals(reads, ["fixtureAuth", "healthFetch", "denoArgs", "layout"]);
    const closing = server.close();
    assertStrictEquals(server.close(), closing);
    // Close owns its SIGTERM grace and SIGKILL escalation; a generic bound of
    // the same length would fail a server that legitimately uses that grace.
    await closing;
    assertEquals(await server.exited, { success: true, code: 0, signal: null });
    assertEquals(
      await Deno.readTextFile(`${layout.cwd}/client/dist/index.html`),
      html,
    );
  });
});

fixtureTest(
  "build review: cancelling an admitted producer settles through its captured signal before release",
  async (coordination) => {
    const lifetime = createFixtureScope();
    const entered = fixtureGate(coordination);
    const events: string[] = [];
    let root = "";
    const work = completeBuild(lifetime.scope, async (output, signal) => {
      root = path.dirname(output);
      events.push("entered");
      entered.resolve();
      signal.addEventListener(
        "abort",
        (event) => event.stopImmediatePropagation(),
        { once: true },
      );
      try {
        await waitForCancellation(signal);
      } finally {
        events.push("cancelled");
      }
    });
    work.catch(() => {});
    try {
      await workMilestone(work, entered.promise, "signal-aware producer entry");
    } finally {
      await bounded(lifetime.close(), "signal-aware producer cancellation");
    }
    const error = await assertRejects(
      () => work,
      OwnershipError,
      "Fixture scope retired",
    );
    assertStrictEquals(error, lifetime.scope.signal.reason);
    await absentRoot(root);
    events.push("released");
    assertEquals(events, ["entered", "cancelled", "released"]);
  },
);

Deno.test("build review: a cached production build is cancelled by its waiting fixture owner", async () => {
  const lifetime = createFixtureScope();
  const work = repositoryBuild(lifetime.scope, { required: true });
  work.catch(() => {});
  await bounded(lifetime.close(), "cached build borrower cancellation");
  await assertRejects(() => work, OwnershipError, "Owner is retired");
});

for (const mode of ["concrete", "optional", "required"] as const) {
  Deno.test(`build review: retired ${mode} acquisition rejects before donor or producer access`, async () => {
    const lifetime = createFixtureScope();
    await lifetime.close();
    const work = mode === "concrete"
      ? buildClient(lifetime.scope)
      : repositoryBuild(lifetime.scope, { required: mode === "required" });
    assertEquals(isPromise(work), true);
    await assertRejects(() => work, OwnershipError, "Owner is retired");
    assertEquals(lifetime.scope.size, 0);
  });
}

const nativeLayout = async (scope: FixtureScope) => {
  // Production compilation is preparation, not a readiness/deadlock probe.
  // Join its owned child and immutable capture before callers bound a fault.
  await repositoryBuild(scope, { required: true });
  const root = (await scope.acquire(
    () => Deno.makeTempDir({ prefix: "native-layout-contract-" }),
    (root) => Deno.remove(root, { recursive: true }),
  )).value;
  const directory = `${root}/evidence`,
    vault = `${root}/vault`,
    state = `${root}/state/globnotes`;
  for (const dir of [directory, vault, state]) {
    await Deno.mkdir(dir, { recursive: true });
  }
  const lookup = (await spawnOwnedChild(scope, "getent", {
    args: ["ahostsv4", Deno.env.get("GLOBNOTES_TEST_HOST")!],
    stdout: "piped",
    stderr: "null",
  })).value;
  const addresses = await new Response(lookup.stdout).text();
  assertEquals((await lookup.exited).code, 0);
  const address = addresses.trim().split(/\s+/)[0];
  return {
    directory,
    vault,
    state,
    prefix: "",
    setup: true,
    headers: {},
    originDependencies: {
      resolve: () => [address],
      addresses: () => [address],
    },
  };
};

Deno.test("build review: every borrower of an in-flight cached build can cancel its producer", async () => {
  await fixtureScope(async (cleanup) => {
    const first = createFixtureScope(), second = createFixtureScope();
    cleanup.defer(() => first.close());
    cleanup.defer(() => second.close());
    const work = repositoryBuild(first.scope, { required: true });
    const borrowed = repositoryBuild(second.scope, { required: true });
    assertStrictEquals(work, borrowed);
    work.catch(() => {});
    await bounded(second.close(), "second build borrower cancellation");
    await assertRejects(() => work, OwnershipError, "Owner is retired");
    first.scope.assertCurrent();
  });
});

Deno.test("build review: cancelling a spawned production build reports its cancellation, not a build failure", async () => {
  await fixtureScope(async (cleanup) => {
    const lifetime = createFixtureScope();
    cleanup.defer(() => lifetime.close());
    const work = repositoryBuild(lifetime.scope, { required: true });
    work.catch(() => {});
    // Observe this process's actual build child; the pattern excludes the probe.
    const spawned = waitUntil(async () => {
      const probe = (await spawnOwnedChild(cleanup, "bash", {
        args: [
          "-c",
          'for d in /proc/[0-9]*; do read -r _ _ _ ppid _ < "$d/stat" 2>/dev/null || continue; [ "$ppid" = "$1" ] || continue; tr "\\0" " " < "$d/cmdline" 2>/dev/null | grep -q -- "build[:]client" && exit 0; done; exit 1',
          "production-build-child",
          String(Deno.pid),
        ],
        stdout: "null",
        stderr: "null",
      })).value;
      return (await probe.exited).success
        ? done()
        : pending({ spawned: false });
    }, { label: "production build child spawned" });
    await workMilestone(work, spawned, "production build child spawned");
    await bounded(lifetime.close(), "spawned production cancellation");
    await assertRejects(() => work, OwnershipError, "Fixture scope retired");
  });
});

Deno.test("build review: a borrower arriving after producer cancellation starts a fresh producer", async () => {
  await fixtureScope(async (cleanup) => {
    const first = createFixtureScope(), second = createFixtureScope();
    cleanup.defer(() => first.close());
    cleanup.defer(() => second.close());
    const cancelled = repositoryBuild(first.scope, { required: true });
    cancelled.catch(() => {});
    // Retirement is synchronous; the cached job's rejection is not yet settled.
    const closing = first.close();
    const fresh = repositoryBuild(second.scope, { required: true });
    fresh.catch(() => {});
    assertNotStrictEquals(fresh, cancelled);
    await bounded(closing, "first build borrower cancellation");
    await assertRejects(() => cancelled, OwnershipError, "Owner is retired");
    second.scope.assertCurrent();
    // The fresh producer is real compilation: its owned child bounds it.
    const build = await fresh;
    assertEquals(
      build?.assets.filter((asset) => asset.path === "index.html").length,
      1,
    );
    assertStrictEquals(
      await repositoryBuild(second.scope, { required: true }),
      build,
    );
  });
});

Deno.test("layout review: unissued layout admission rejects as a promise before its effect", async () => {
  await fixtureScope(async (scope) => {
    let entered = 0;
    const work = admitLayout({} as FixtureLayout, scope, () => {
      entered++;
    });
    assertEquals(isPromise(work), true);
    await assertRejects(
      () => work,
      TypeError,
      "Layout custody was not issued",
    );
    assertEquals(entered, 0);
  });
});

for (const required of [false, true]) {
  Deno.test(`build P05: option callback retirement fences donor lookup and cached delivery (required=${required})`, async () => {
    await fixtureScope(async (scope) => {
      // Wait for actual production/capture; this contract tests the later
      // synchronous retirement fence, not how fast Vite runs on a loaded CPU.
      const completed = await repositoryBuild(scope, { required: true });
      assert(completed);
      const borrower = createFixtureScope();
      scope.defer(() => borrower.close());
      let closing: Promise<void> | undefined;
      const events: string[] = [];
      const stat = Deno.statSync;
      Deno.statSync = (file) => {
        events.push("donor lookup");
        return stat(file);
      };
      try {
        const work = repositoryBuild(borrower.scope, {
          get required() {
            events.push("option captured");
            closing = borrower.close();
            return required;
          },
        });
        await assertRejects(
          () => bounded(work, "retired build delivery"),
          OwnershipError,
          "Owner is retired",
        );
        assertEquals(events, ["option captured"]);
      } finally {
        Deno.statSync = stat;
        await closing;
      }
    });
  });
}

Deno.test("native layout review: failed log acquisition preserves existing evidence and reaps before rejection", async () => {
  await fixtureScope(async (scope) => {
    const input = await nativeLayout(scope),
      file = `${input.directory}/server-stdout.log`;
    await Deno.writeTextFile(file, "borrowed existing evidence");
    // Startup and cleanup are real work with owned deadlines (readiness waits,
    // terminate grace); the failure precedes readiness, so no generic bound.
    await assertRejects(
      () => bootPrefixAuthFixture(input),
      Deno.errors.AlreadyExists,
      `File exists (os error 17): open '${file}'`,
    );
    assertEquals(await Deno.readTextFile(file), "borrowed existing evidence");
    const record = JSON.parse(
      await Deno.readTextFile(`${input.directory}/startup-ownership.json`),
    );
    await absentRoot(record.cwd);
    await absentRoot(record.instance);
  });
});

Deno.test("native layout review: concurrent close joins the same child and drain completion", async () => {
  await fixtureScope(async (scope) => {
    const input = await nativeLayout(scope);
    const server = (await scope.acquire(() =>
      bootPrefixAuthFixture(input), (server) =>
      server.close())).value;
    const closing = server.close();
    assertStrictEquals(server.close(), closing);
    // Native close owns terminate()'s grace and escalation; no generic bound.
    await closing;
    await absentRoot(server.cwd);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${input.directory}/startup-ownership.json`),
      ).pid,
      server.pid,
    );
  });
});

Deno.test("native layout P13: receipt failure before handoff reaps its child and releases owned roots", async () => {
  await fixtureScope(async (scope) => {
    const input = await nativeLayout(scope),
      file = `${input.directory}/startup-ownership.json`;
    await Deno.writeTextFile(file, "borrowed receipt");
    const write = Deno.writeTextFile;
    let attempted: { pid: number; cwd: string; instance: string } | undefined;
    Deno.writeTextFile = (target, data, options) => {
      if (String(target) === file) attempted = JSON.parse(data as string);
      return write(target, data, options);
    };
    try {
      await assertRejects(
        () => bootPrefixAuthFixture(input),
        Deno.errors.AlreadyExists,
        `File exists (os error 17): writefile '${file}'`,
      );
    } finally {
      Deno.writeTextFile = write;
    }
    assert(attempted);
    const probe = (await spawnOwnedChild(scope, "bash", {
      args: [
        "-c",
        'kill -0 "$1"',
        "native-receipt-child-absence",
        String(attempted.pid),
      ],
      stdout: "null",
      stderr: "null",
    })).value;
    assertEquals((await probe.exited).success, false);
    await absentRoot(attempted.cwd);
    await absentRoot(attempted.instance);
    assertEquals(await Deno.readTextFile(file), "borrowed receipt");
  });
});

for (const cleanupFailure of [false, true]) {
  Deno.test(`native layout P13: self-exit close keeps cleanup failure distinct (${cleanupFailure})`, async () => {
    await fixtureScope(async (scope) => {
      const input = await nativeLayout(scope);
      let claimed = false, observed: unknown;
      const server = (await scope.acquire(() =>
        bootPrefixAuthFixture(input), async (server) => {
        try {
          await server.close();
        } catch (error) {
          if (!claimed || !Object.is(error, observed)) {
            throw error;
          }
        }
      })).value;
      const killer = (await spawnOwnedChild(scope, "bash", {
        args: [
          "-c",
          'kill -TERM "$1"',
          "native-self-exit",
          String(server.pid),
        ],
        stdout: "null",
        stderr: "null",
      })).value;
      assertEquals((await killer.exited).code, 0);
      await waitUntil(async () => {
        const probe = (await spawnOwnedChild(scope, "bash", {
          args: [
            "-c",
            'kill -0 "$1"',
            "native-self-exit-absence",
            String(server.pid),
          ],
          stdout: "null",
          stderr: "null",
        })).value;
        return (await probe.exited).success
          ? pending({ pid: server.pid })
          : done();
      }, { label: "native self-exit before close" });
      const remove = Deno.remove, removal = Error("native cwd release failed");
      let closing: Promise<void> | undefined;
      try {
        // Install inside the restoring try: nothing may run between patch and try.
        if (cleanupFailure) {
          Deno.remove = (file, options) =>
            String(file) === server.cwd
              ? Promise.reject(removal)
              : remove(file, options);
        }
        closing = server.close();
        assertStrictEquals(server.close(), closing);
        const error = await assertRejects(
          () =>
            bounded(closing!, "native self-exit cleanup"),
          cleanupFailure ? AggregateError : UnexpectedServerExitError,
          cleanupFailure
            ? "Owned resource release failed"
            : `Prefix fixture server exited on its own before close() (pid ${server.pid}, exit code 0)`,
        );
        observed = error;
        claimed = true;
        if (cleanupFailure) {
          const errors = (error as AggregateError).errors;
          assertEquals(
            errors.map((value) =>
              value.message
            ),
            [
              `Prefix fixture server exited on its own before close() (pid ${server.pid}, exit code 0)`,
              removal.message,
            ],
          );
          assertEquals(errors[0] instanceof UnexpectedServerExitError, true);
          assertStrictEquals(errors[1], removal);
          assertEquals(error instanceof UnexpectedServerExitError, false);
        }
      } finally {
        Deno.remove = remove;
      }
      assertStrictEquals(server.close(), closing!);
      await absentRoot(server.cwd);
      const record = JSON.parse(
        await Deno.readTextFile(`${input.directory}/startup-ownership.json`),
      );
      await absentRoot(record.instance);
    });
  });
}

for (
  const [phase, outcome] of [
    ["health", "response"],
    ["health", "error"],
    [
      "catalog",
      "response",
    ],
    ["catalog", "error"],
    ["health", "held"],
    ["catalog", "held"],
    ["health", "held disposal"],
    ["catalog", "held body"],
  ] as const
) {
  Deno.test(`native layout review: ${phase} ${outcome} after actual child exit cannot escape a handle`, async () => {
    await fixtureScope(async (scope) => {
      const input = await nativeLayout(scope);
      const overlapsBuild = outcome === "held disposal" ||
        outcome === "held body";
      const foreignIndex = `${input.directory}/foreign-index.html`;
      const checkoutIndex = path.fromFileUrl(
        new URL("../client/dist/index.html", import.meta.url),
      );
      const newIndex = "<!doctype html><title>independent rebuild</title>";
      let foreignIndexReads = 0;
      if (overlapsBuild) {
        await Deno.writeTextFile(foreignIndex, html);
        // Model the separate build in this test's own directory. A lookup of
        // the checkout's index sees the publication without touching the checkout.
        const read = Deno.readFile;
        scope.defer(() => {
          Deno.readFile = read;
        });
        Deno.readFile = (file, options) => {
          const requested = file instanceof URL
            ? path.fromFileUrl(file)
            : path.normalize(file);
          if (requested !== checkoutIndex) return read(file, options);
          foreignIndexReads++;
          return read(foreignIndex, options);
        };
      }
      const events: string[] = [];
      const observedExit = fixtureGate(scope),
        held = fixtureGate(scope),
        responded = fixtureGate(scope);
      let bodyDisposals = 0;
      const exitingFetch: typeof fetch = async (url, options) => {
        const response = await fetch(url, options);
        responded.resolve();
        const exit = async () => {
          const child = JSON.parse(
            await Deno.readTextFile(
              `${input.directory}/startup-ownership.json`,
            ),
          );
          events.push("response received");
          if (overlapsBuild) {
            await Deno.writeTextFile(foreignIndex, newIndex);
          }
          const killer = (await spawnOwnedChild(scope, "bash", {
            args: ["-c", 'kill -TERM "$1"', "native-exit", String(child.pid)],
            stdout: "null",
            stderr: "null",
          })).value;
          assertEquals((await killer.exited).code, 0);
          await waitUntil(async () => {
            const probe = (await spawnOwnedChild(scope, "bash", {
              args: [
                "-c",
                'kill -0 "$1"',
                "native-exit-absence",
                String(child.pid),
              ],
              stdout: "null",
              stderr: "null",
            })).value;
            return (await probe.exited).success
              ? pending({ pid: child.pid })
              : done();
          }, { label: "native layout actual process absence" });
          events.push("child exited");
          observedExit.resolve();
        };
        if (outcome === "held body") {
          await response.body?.cancel();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"plugins":'));
              },
              async pull() {
                await exit();
                await held.promise;
              },
              cancel() {
                bodyDisposals++;
                return held.promise;
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        await exit();
        if (outcome === "held") {
          await response.body?.cancel();
          return await held.promise.then(() => response);
        }
        if (outcome === "held disposal") {
          await response.body?.cancel();
          return {
            ok: true,
            status: 200,
            body: { cancel: () => held.promise },
          } as unknown as Response;
        }
        if (outcome === "error") {
          await response.body?.cancel();
          throw new Error("stale native readiness error");
        }
        return response;
      };
      let escaped = false;
      const work = bootPrefixAuthFixture({
        ...input,
        ...phase === "health"
          ? { healthFetch: exitingFetch }
          : { catalogFetch: exitingFetch },
      }).then((server) => {
        escaped = true;
        scope.defer(() => server.close());
        return server;
      });
      work.catch(() => undefined);
      // Real startup is bounded by the fixture's own readiness waits. Contain
      // only the injected exit and fence, after the live server has responded.
      await workMilestone(work, responded.promise, "native server responded");
      await assertRejects(
        () => bounded(work, "native exit barrier"),
        Error,
        "Prefix fixture server exited: 0",
      );
      const child = JSON.parse(
        await Deno.readTextFile(`${input.directory}/startup-ownership.json`),
      );
      await bounded(
        observedExit.promise,
        "native injected IO observed actual exit",
      );
      assertEquals([events, escaped], [
        ["response received", "child exited"],
        false,
      ]);
      assertEquals(bodyDisposals, outcome === "held body" ? 1 : 0);
      if (overlapsBuild) {
        assertEquals(
          [foreignIndexReads, await Deno.readTextFile(foreignIndex)],
          [
            0,
            newIndex,
          ],
        );
      }
      await absentRoot(child.cwd);
      await absentRoot(child.instance);
    });
  });
}

Deno.test("layout owner: simultaneous default layouts isolate complete roots without manufacturing metadata or vault overrides", async () => {
  let roots: string[] = [];
  await fixtureScope(async (scope) => {
    const build = await fixtureBuild(scope);
    const layouts = await Promise.all([
      fixtureLayout(scope, {}, { build }),
      fixtureLayout(scope, {}, { build }),
    ]);
    roots = layouts.flatMap(
      (layout) => [layout.instance, layout.vault, layout.cwd, layout.artifacts],
    );
    assertEquals(new Set(roots).size, 8);
    for (const layout of layouts) {
      const env = layoutEnvironment(layout);
      assertEquals(Object.hasOwn(env, "GLOBNOTES__METADATA_PATH"), false);
      assertEquals(Object.hasOwn(env, "GLOBNOTES_GLOBNOTES_PATH"), false);
      assertEquals(layout.metadata, path.join(layout.vault, ".globnotes"));
    }
    const servers = await Promise.all(
      layouts.map((layout) =>
        scope.acquire(
          () => bootServer({ fixtureAuth: { auth_type: "none" } }, { layout }),
          (server) => server.close(),
        )
      ),
    );
    await note(servers[0].value.baseUrl, "OnlyHere", "first layout\n");
    assertEquals(
      await Deno.readTextFile(`${layouts[0].vault}/OnlyHere.md`),
      "first layout\n",
    );
    const foreign = await fetch(
      `${servers[1].value.baseUrl}/_/api/notes/OnlyHere`,
    );
    assertEquals(foreign.status, 404);
    await foreign.body?.cancel();
    await note(servers[1].value.baseUrl, "OnlyHere", "second layout\n");
    assertEquals(
      await Deno.readTextFile(`${layouts[1].vault}/OnlyHere.md`),
      "second layout\n",
    );
    for (const layout of layouts) {
      assert((await Deno.stat(`${layout.metadata}/config.json`)).isFile);
    }
  });
  for (const root of roots) {
    await absentRoot(root);
  }
});

Deno.test("layout owner: intentional same-instance restart retains exactly its scoped state", async () => {
  await fixtureScope(async (scope) => {
    const build = await fixtureBuild(scope),
      layout = await fixtureLayout(scope, {}, { build });
    const first = await scope.acquire(
      () => bootServer({ fixtureAuth: { auth_type: "none" } }, { layout }),
      (server) => server.close(),
    );
    await note(first.value.baseUrl, "Restarted", "same instance\n");
    await first.value.close();
    const second = await scope.acquire(
      () => bootServer({}, { layout }),
      (server) => server.close(),
    );
    assert(first.value.pid !== second.value.pid);
    assertStrictEquals(second.value.layout, layout);
    const response = await fetch(
      `${second.value.baseUrl}/_/api/notes/Restarted`,
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      path: "Restarted",
      title: "Restarted",
      content: "same instance\n",
      movedFiles: [],
      lastModified:
        (await Deno.stat(`${layout.vault}/Restarted.md`)).mtime!.getTime() /
        1000,
      version:
        "2c36d88df20eb5c4b272dd517804c576a879d2609fba818b3418e8c282550d34",
    });
    assertEquals(
      await Deno.readTextFile(`${layout.vault}/Restarted.md`),
      "same instance\n",
    );
  });
});

Deno.test("layout owner: retirement cancels borrowers, drains admitted effects, then releases roots", async () => {
  await fixtureScope(async (cleanup) => {
    const lifetime = createFixtureScope(), borrower = createFixtureScope();
    cleanup.defer(() => lifetime.close());
    cleanup.defer(() => borrower.close());
    const build = await fixtureBuild(lifetime.scope);
    const layout = await fixtureLayout(lifetime.scope, {}, { build });
    bindLayout(layout, borrower.scope);
    const entered = fixtureGate(cleanup),
      cancelled = fixtureGate(cleanup),
      draining = fixtureGate(cleanup),
      release = fixtureGate(cleanup);
    const events: string[] = [];
    borrower.scope.onCancel(() => {
      events.push("cancelled");
      cancelled.resolve();
    });
    const work = admitLayout(layout, borrower.scope, async (signal) => {
      events.push("admitted");
      entered.resolve();
      await cancelled.promise;
      assertEquals(signal.aborted, true);
      assertEquals((await Deno.stat(layout.cwd)).isDirectory, true);
      events.push("draining with root");
      draining.resolve();
      await release.promise;
      events.push("drained");
    });
    work.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await workMilestone(work, entered.promise, "layout effect admission");
      closing = lifetime.close();
      await workMilestone(
        work,
        draining.promise,
        "layout cancellation before drain",
      );
      assertEquals(events, ["admitted", "cancelled", "draining with root"]);
    } finally {
      release.resolve();
      await bounded(closing ?? lifetime.close(), "layout owner close");
    }
    await assertRejects(() => work, OwnershipError, "Owner is retired");
    await absentRoot(layout.cwd);
    events.push("released");
    assertEquals(events, [
      "admitted",
      "cancelled",
      "draining with root",
      "drained",
      "released",
    ]);
  });
});

Deno.test("layout owner: closing an explicit layout reaps its live server before root release", async () => {
  await fixtureScope(async (cleanup) => {
    const lifetime = createFixtureScope();
    cleanup.defer(() => lifetime.close());
    const build = await fixtureBuild(lifetime.scope);
    const layout = await fixtureLayout(lifetime.scope, {}, { build });
    const server = await bootServer({ fixtureAuth: { auth_type: "none" } }, {
      layout,
    });
    await note(server.baseUrl, "Owned", "persisted before retirement\n");
    const root = path.dirname(layout.instance), remove = Deno.remove;
    const removals: (Deno.CommandStatus | null)[] = [];
    try {
      Deno.remove = (file, options) => {
        if (String(file) === root) removals.push(server.status());
        return remove(file, options);
      };
      await bounded(lifetime.close(), "layout runtime reaping");
    } finally {
      Deno.remove = remove;
    }
    // Exactly one root removal, observed only after the child had exited.
    assertEquals(removals, [await server.exited]);
    assertEquals((await server.exited).signal, "SIGKILL");
    assertStrictEquals(server.status(), await server.exited);
    const outcomes = await Promise.all(
      [layout.instance, layout.cwd, layout.artifacts].map(async (root) => {
        await absentRoot(root);
        return "absent";
      }),
    );
    assertEquals(outcomes, ["absent", "absent", "absent"]);
    await server.close();
  });
});

Deno.test("layout owner: caller-relative paths are absolute before child launch and borrowed roots remain real", async () => {
  await fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "layout-relative-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const vault = `${root.value}/notes`,
      metadata = `${root.value}/state`,
      cwd = `${root.value}/app`,
      artifacts = `${root.value}/evidence`;
    for (const directory of [vault, metadata, cwd, artifacts]) {
      await Deno.mkdir(directory);
    }
    const relative = (value: string) => path.relative(Deno.cwd(), value);
    const layout = await fixtureLayout(scope, {
      GLOBNOTES__VAULTS_BASEPATH: relative(root.value),
      GLOBNOTES_GLOBNOTES_PATH: relative(vault),
      GLOBNOTES__METADATA_PATH: relative(metadata),
    }, { cwd: relative(cwd), artifacts: relative(artifacts) });
    assertEquals([
      layout.instance,
      layout.vault,
      layout.metadata,
      layout.cwd,
      layout.artifacts,
    ], [root.value, vault, `${metadata}/globnotes`, cwd, artifacts]);
    const server = await scope.acquire(
      () => bootServer({ fixtureAuth: { auth_type: "none" } }, { layout }),
      (server) => server.close(),
    );
    await note(server.value.baseUrl, "Relative", "resolved before spawn\n");
    await server.value.close();
    assertEquals(
      await Deno.readTextFile(`${vault}/Relative.md`),
      "resolved before spawn\n",
    );
    assert((await Deno.stat(`${metadata}/globnotes/config.json`)).isFile);
    await assertRejects(
      () =>
        bootServer({ GLOBNOTES__METADATA_PATH: `${root.value}/other` }, {
          layout,
        }),
      TypeError,
      "Boot cannot replace its owned layout binding: GLOBNOTES__METADATA_PATH",
    );
  });
});

Deno.test("completed build: held production cannot supply a copyable input before success", async () => {
  await fixtureScope(async (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate(scope);
    const work = completeBuild(scope, async (output) => {
      await Deno.mkdir(output);
      await Deno.writeTextFile(`${output}/index.html`, "partial");
      entered.resolve();
      await release.promise;
      await Deno.writeTextFile(`${output}/index.html`, html);
    });
    work.catch(() => undefined);
    const cwd = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "held-build-copy-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    try {
      await workMilestone(
        work,
        entered.promise,
        "build held before completion",
      );
      await assertRejects(
        () =>
          installCompletedBuild(
            scope,
            work as unknown as CompletedBuild,
            cwd.value,
          ),
        TypeError,
        "Boot requires an issued completed-build input",
      );
      assertEquals([...Deno.readDirSync(cwd.value)], []);
    } finally {
      release.resolve();
    }
    const build = await work;
    await installCompletedBuild(scope, build, cwd.value);
    assertEquals(
      await Deno.readTextFile(`${cwd.value}/client/dist/index.html`),
      html,
    );
  });
});

Deno.test("layout owner: borrowed missing metadata is left to real product preflight rather than silently created", async () => {
  await fixtureScope(async (scope) => {
    const root = await scope.acquire(
      () => Deno.makeTempDir({ prefix: "layout-borrowed-preflight-" }),
      (root) => Deno.remove(root, { recursive: true }),
    );
    const vault = `${root.value}/notes`,
      metadata = `${root.value}/missing-parent/metadata`;
    await Deno.mkdir(vault);
    const build = await fixtureBuild(scope);
    const layout = await fixtureLayout(scope, {
      GLOBNOTES_GLOBNOTES_PATH: vault,
      GLOBNOTES__METADATA_PATH: metadata,
    }, { build });
    assertEquals(layout.metadata, `${metadata}/globnotes`);
    await absentRoot(`${root.value}/missing-parent`);
    const server = await scope.acquire(
      () => bootServer({ fixtureAuth: { auth_type: "none" } }, { layout }),
      (server) => server.close(),
    );
    await note(
      server.value.baseUrl,
      "Seeded",
      "explicit seeding still works\n",
    );
    assert((await Deno.stat(`${metadata}/globnotes/config.json`)).isFile);
    assertEquals(
      await Deno.readTextFile(`${vault}/Seeded.md`),
      "explicit seeding still works\n",
    );
  });
});

Deno.test("completed build: accepted bytes survive later producer mutation and disposal", async () => {
  let build!: CompletedBuild, source = "";
  await fixtureScope(async (scope) => {
    build = await completeBuild(scope, async (output) => {
      source = output;
      await Deno.mkdir(output);
      await Deno.writeTextFile(`${output}/index.html`, html);
    });
    await Deno.writeTextFile(
      `${source}/index.html`,
      "replacement build in progress",
    );
  });
  await absentRoot(source);
  await fixtureScope(async (scope) => {
    const layout = await fixtureLayout(scope, {}, { build });
    assertEquals(
      await Deno.readTextFile(`${layout.cwd}/client/dist/index.html`),
      html,
    );
    assert(Object.isFrozen(build));
    assert(Object.isFrozen(build.assets));
    assert(Object.isFrozen(build.assets[0]));
    await assertRejects(
      () =>
        installCompletedBuild(
          scope,
          { ...build } as CompletedBuild,
          layout.cwd,
        ),
      TypeError,
      "Boot requires an issued completed-build input",
    );
  });
});

Deno.test("completed build: held producer failure cannot publish even a complete-looking output", async () => {
  await fixtureScope(async (scope) => {
    const entered = fixtureGate(scope),
      release = fixtureGate(scope);
    const failure = Error("held producer failed after writing assets");
    const work = completeBuild(scope, async (output) => {
      await Deno.mkdir(output);
      await Deno.writeTextFile(`${output}/index.html`, html);
      entered.resolve();
      await release.promise;
      throw failure;
    });
    work.catch(() => undefined);
    try {
      await workMilestone(
        work,
        entered.promise,
        "producer staged, not completed",
      );
    } finally {
      release.resolve();
    }
    assertStrictEquals(
      await assertRejects(() => work, Error, failure.message),
      failure,
    );
  });
});

fixtureTest(
  "completed build: retirement waits for held production before removing its root and cannot issue",
  async (coordination) => {
    const lifetime = createFixtureScope();
    const entered = fixtureGate(coordination),
      release = fixtureGate(coordination);
    let output = "";
    const work = completeBuild(lifetime.scope, async (directory) => {
      output = directory;
      await Deno.mkdir(output);
      await Deno.writeTextFile(`${output}/index.html`, html);
      entered.resolve();
      await release.promise;
    });
    work.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await workMilestone(work, entered.promise, "held production retirement");
      closing = lifetime.close();
      // The root and unfinished producer have independent reserved custody.
      // Filesystem scheduling alone cannot prove this: stat can beat removal.
      assertEquals(lifetime.scope.size, 2, "root and producer remain reserved");
      // The producer reservation still has custody while the owner is retired.
      assert((await Deno.stat(output)).isDirectory);
    } finally {
      release.resolve();
      await bounded(closing ?? lifetime.close(), "build retirement completion");
    }
    await assertRejects(() => work, OwnershipError, "Owner is retired");
    await absentRoot(output);
  },
);

Deno.test("completed build: failed producer and malformed or symlink outputs never issue an input", async () => {
  for (const failure of ["producer", "index", "symlink"]) {
    let output = "";
    await assertRejects(
      () =>
        fixtureScope((scope) =>
          completeBuild(scope, async (directory) => {
            output = directory;
            await Deno.mkdir(directory);
            if (failure === "producer") throw Error("build failed");
            if (failure === "symlink") {
              await Deno.symlink("missing", `${directory}/index.html`);
            }
          })
        ),
      failure === "producer" ? Error : TypeError,
      failure === "producer"
        ? "build failed"
        : failure === "symlink"
        ? "Completed build cannot follow symlinks"
        : "Completed build requires a nonempty index.html",
    );
    await absentRoot(output);
  }
});

Deno.test("layout owner: failed peer disposal after installation still releases every owned root and retains borrowed bytes", async () => {
  let instance = "", cwd = "", artifacts = "", borrowed = "";
  await fixtureScope(async (outer) => {
    const build = await fixtureBuild(outer);
    borrowed = (await outer.acquire(
      () => Deno.makeTempDir({ prefix: "layout-borrowed-" }),
      (root) => Deno.remove(root, { recursive: true }),
    )).value;
    await Deno.writeTextFile(`${borrowed}/Note.md`, "keep real bytes");
    const primary = Error("scenario failed after successful installation"),
      cleanup = Error("peer disposal failed");
    const error = await assertRejects(
      () =>
        fixtureScope(async (scope) => {
          const layout = await fixtureLayout(scope, {
            GLOBNOTES_GLOBNOTES_PATH: borrowed,
          }, { build });
          ({ instance, cwd, artifacts } = layout);
          scope.defer(() => {
            throw cleanup;
          });
          throw primary;
        }),
      AggregateError,
      "Owned resource release failed",
    );
    assertStrictEquals(error.cause, primary);
    assertEquals(error.errors, [primary, cleanup]);
    assertStrictEquals(error.errors[0], primary);
    assertStrictEquals(error.errors[1], cleanup);
    for (const root of [instance, cwd, artifacts]) {
      await absentRoot(root);
    }
    assertEquals(
      await Deno.readTextFile(`${borrowed}/Note.md`),
      "keep real bytes",
    );
    // A forged build is rejected before the layout reserves or allocates roots.
    const forged = createFixtureScope();
    outer.defer(() => forged.close());
    await assertRejects(
      () => fixtureLayout(forged.scope, {}, { build: {} as CompletedBuild }),
      TypeError,
      "Boot requires an issued completed-build input",
    );
    assertEquals(forged.scope.size, 0);
  });
});

for (const failed of ["stdout", "stderr"] as const) {
  Deno.test(`pr117: failed ${failed} log acquisition cancels its unread pipe and closes the sibling log`, async () => {
    await fixtureScope(async (scope) => {
      const input = await nativeLayout(scope);
      const file = `${input.directory}/server-${failed}.log`;
      const sibling = failed === "stdout" ? "stderr" : "stdout";
      await Deno.writeTextFile(file, "borrowed evidence");
      const open = Deno.open, cancel = ReadableStream.prototype.cancel;
      const cancelled: ReadableStream[] = [], closed: string[] = [];
      try {
        ReadableStream.prototype.cancel = function (reason) {
          cancelled.push(this);
          return cancel.call(this, reason);
        };
        Deno.open = async (...args: Parameters<typeof Deno.open>) => {
          const handle = await open(...args);
          if (String(args[0]) === `${input.directory}/server-${sibling}.log`) {
            const close = handle.close.bind(handle);
            handle.close = () => {
              closed.push(sibling);
              close();
            };
          }
          return handle;
        };
        await assertRejects(
          () =>
            bootPrefixAuthFixture({
              ...input,
              healthFetch: () => Promise.resolve(new Response(null)),
            }),
          Deno.errors.AlreadyExists,
          `File exists (os error 17): open '${file}'`,
        );
        assertEquals(cancelled.map((stream) => stream.locked), [false]);
        const reader = cancelled[0].getReader();
        try {
          assertEquals(
            await bounded(reader.closed, "unread native pipe closed"),
            undefined,
          );
        } finally {
          reader.releaseLock();
        }
        assertEquals(closed, [sibling]);
        assertEquals(await Deno.readTextFile(file), "borrowed evidence");
        const record = JSON.parse(
          await Deno.readTextFile(`${input.directory}/startup-ownership.json`),
        );
        await absentRoot(record.cwd);
        await absentRoot(record.instance);
      } finally {
        Deno.open = open;
        ReadableStream.prototype.cancel = cancel;
      }
    });
  });
}

Deno.test("pr117: installation fails after a real asset write and releases partial owned paths, not borrowed notes", async () => {
  await fixtureScope(async (outer) => {
    const borrowed = (await outer.acquire(
      () => Deno.makeTempDir({ prefix: "failed-install-borrowed-" }),
      (root) => Deno.remove(root, { recursive: true }),
    )).value;
    await Deno.writeTextFile(`${borrowed}/Note.md`, "keep borrowed bytes");
    const bytes: Record<string, string> = {
      "index.html": html,
      "later.js": "complete asset",
    };
    const build = await completeBuild(outer, async (output) => {
      await Deno.mkdir(output);
      for (const [name, value] of Object.entries(bytes)) {
        await Deno.writeTextFile(`${output}/${name}`, value);
      }
    });
    const write = Deno.writeFile,
      failure = Error("second installed asset failed");
    const events: string[] = [], names: string[] = [];
    let cwd = "";
    try {
      Deno.writeFile = async (target, data, options) => {
        const file = String(target);
        if (!file.includes("/client/dist/")) {
          return await write(target, data, options);
        }
        cwd = path.dirname(path.dirname(path.dirname(file)));
        names.push(path.basename(file));
        if (names.length === 2) {
          events.push("later write failed");
          throw failure;
        }
        await write(target, data, options);
        assertEquals(await Deno.readTextFile(file), bytes[path.basename(file)]);
        events.push("first asset persisted");
      };
      const error = await assertRejects(
        () =>
          fixtureScope((scope) =>
            fixtureLayout(scope, { GLOBNOTES_GLOBNOTES_PATH: borrowed }, {
              build,
            })
          ),
        Error,
        failure.message,
      );
      assertStrictEquals(error, failure);
    } finally {
      Deno.writeFile = write;
    }
    assertEquals(names.sort(), ["index.html", "later.js"]);
    assertEquals(events, ["first asset persisted", "later write failed"]);
    const root = path.dirname(cwd);
    for (const owned of [cwd, `${root}/instance`, `${root}/artifacts`, root]) {
      await absentRoot(owned);
    }
    assertEquals(
      await Deno.readTextFile(`${borrowed}/Note.md`),
      "keep borrowed bytes",
    );
  });
});

Deno.test("pr117: origin retirement at the successful boot handoff cannot return a server", async () => {
  await fixtureScope(async (outer) => {
    const lifetime = createFixtureScope();
    outer.defer(() => lifetime.close());
    const build = await fixtureBuild(lifetime.scope);
    const layout = await fixtureLayout(lifetime.scope, {}, { build });
    const events: string[] = [];
    let healthy = false, escaped = false, closing: Promise<void> | undefined;
    const work = bootServer({ fixtureAuth: { auth_type: "none" } }, {
      layout,
      async healthFetch(url, options) {
        const response = await fetch(url, options);
        assertEquals(response.status, 200);
        healthy = true;
        events.push("healthy");
        return response;
      },
      origin(port) {
        if (healthy) {
          events.push("retired at handoff");
          closing = lifetime.close();
        }
        return `http://127.0.0.1:${port}`;
      },
    }).then((server) => {
      escaped = true;
      outer.defer(() => server.close());
      return server;
    });
    try {
      await assertRejects(() => work, OwnershipError, "Owner is retired");
    } finally {
      await closing;
    }
    assertEquals([events, escaped], [["healthy", "retired at handoff"], false]);
    for (const owned of [layout.cwd, layout.instance, layout.artifacts]) {
      await absentRoot(owned);
    }
  });
});

for (const kind of ["symlink", "file"] as const) {
  Deno.test(`pr117: completed-build output root must be a real directory, not a ${kind}`, async () => {
    await fixtureScope(async (outer) => {
      const borrowed = (await outer.acquire(
        () => Deno.makeTempDir({ prefix: "build-root-target-" }),
        (root) => Deno.remove(root, { recursive: true }),
      )).value;
      await Deno.writeTextFile(`${borrowed}/index.html`, html);
      let output = "";
      await assertRejects(
        () =>
          fixtureScope((scope) =>
            completeBuild(scope, async (directory) => {
              output = directory;
              if (kind === "symlink") await Deno.symlink(borrowed, output);
              else await Deno.writeTextFile(output, html);
              assertEquals(
                (await Deno.lstat(output)).isSymlink,
                kind === "symlink",
              );
            })
          ),
        TypeError,
        "Completed build requires a real output directory",
      );
      await absentRoot(path.dirname(output));
      assertEquals(await Deno.readTextFile(`${borrowed}/index.html`), html);
    });
  });
}

Deno.test("pr117: borrowed cwd and completed build reject before allocation and each alone retains its one asset source", async () => {
  await fixtureScope(async (outer) => {
    const root = (await outer.acquire(
      () => Deno.makeTempDir({ prefix: "ambiguous-build-" }),
      (root) => Deno.remove(root, { recursive: true }),
    )).value;
    const cwd = `${root}/app`;
    await Deno.mkdir(`${cwd}/client/dist`, { recursive: true });
    await Deno.writeTextFile(
      `${cwd}/client/dist/index.html`,
      "borrowed index B",
    );
    const build = await fixtureBuild(outer);
    for (const suppliedCwd of [cwd, ""]) {
      const lifetime = createFixtureScope();
      outer.defer(() => lifetime.close());
      await assertRejects(
        () => fixtureLayout(lifetime.scope, {}, { cwd: suppliedCwd, build }),
        TypeError,
        "A borrowed cwd cannot be combined with a completed build",
      );
      assertEquals(lifetime.scope.size, 0);
    }
    const borrowed = await fixtureLayout(outer, {}, { cwd });
    assertEquals(borrowed.cwd, cwd);
    const installed = await fixtureLayout(outer, {}, { build });
    assertEquals([
      await Deno.readTextFile(`${borrowed.cwd}/client/dist/index.html`),
      await Deno.readTextFile(`${installed.cwd}/client/dist/index.html`),
    ], ["borrowed index B", html]);
  });
});
