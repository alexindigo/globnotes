// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import {
  createFixtureClock,
  fixtureClockReader,
} from "./helpers/fixture_clock.ts";
import {
  nativeRecordChannelIO,
  type RecordChannelIO,
} from "./helpers/owned_record_channel.ts";
import { createNativeTotpClock } from "../client/tests/e2e/native-totp-fixture.mjs";
import { bootServer } from "./helpers/boot.ts";
import {
  fixtureGate,
  waitForCancellation,
} from "./helpers/fixture_coordination.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { OwnershipError } from "../shared/ownership.js";
import { workMilestone } from "./helpers/product_settlement.ts";
import { DENO } from "./helpers/process_values.ts";
import { spawnOwnedChild } from "./helpers/owned_child.ts";
import { fromFileUrl } from "@std/path";
import { storageServerFixture } from "./helpers/driver_fixture.ts";
import { memoryRemote } from "./helpers/memory_remote.ts";
import { authenticatorCode, TOTP_STEP_MS } from "./helpers/totp.ts";

async function root(scope: FixtureScope) {
  return (await scope.acquire(
    () => Deno.makeTempDir({ prefix: "fixture-clock-" }),
    (directory) => Deno.remove(directory, { recursive: true }),
  )).value;
}

for (const first of ["clock", "root"] as const) {
  Deno.test(`fixture clock: ${first} close cancels and drains publication before root release`, () =>
    fixtureScope(async (scope) => {
      const fixture = (await scope.acquire(pluginFixture, (fixture) =>
        fixture.dispose())).value;
      const staged = fixtureGate(scope), events: string[] = [];
      let held = false;
      const io: RecordChannelIO = {
        ...nativeRecordChannelIO,
        publication: {
          ...nativeRecordChannelIO.publication,
          async write(file, bytes, signal) {
            await nativeRecordChannelIO.publication.write(file, bytes, signal);
            if (held) {
              events.push("staged");
              staged.resolve();
              try {
                await waitForCancellation(signal!);
              } catch (error) {
                assertEquals(Deno.statSync(fixture.root).isDirectory, true);
                events.push("cancelled");
                throw error;
              }
            }
          },
          remove(file) {
            if (held) {
              events.push("stage-removed");
            }
            return nativeRecordChannelIO.publication.remove(file);
          },
        },
      };
      const clock = (await scope.acquire(
        () =>
          createFixtureClock(fixture, "clock", 100, { io }),
        (clock) => clock.close(),
      )).value;
      held = true;
      const advancing = clock.advance(25);
      await bounded(
        workMilestone(advancing, staged.promise, "held clock publication"),
        "held clock publication",
      );
      const queued = clock.advance(50);
      const rejected = assertRejects(
        () => advancing,
        OwnershipError,
        "Fixture scope retired",
      );
      const queuedRejected = assertRejects(
        () => queued,
        OwnershipError,
        "Owner is retired",
      );
      await bounded(
        first === "clock" ? clock.close() : fixture.dispose(),
        "clock publication close",
      );
      await bounded(rejected, "cancelled clock advance");
      await bounded(queuedRejected, "cancelled queued advance");
      assertEquals(events, ["staged", "cancelled", "stage-removed"]);
      assertEquals(clock.now(), 100);
      await fixture.dispose();
      assertThrows(
        () => Deno.statSync(fixture.root),
        Deno.errors.NotFound,
        "No such file or directory",
      );
    }));
}

Deno.test("fixture clock: native preload collision preserves existing bytes and closes only its new clock", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    const preload = `${directory}/authenticator-time.mjs`;
    await Deno.writeTextFile(preload, "existing preload\n", {
      createNew: true,
    });
    await assertRejects(
      () => createNativeTotpClock(directory, 1234567890_000),
      Deno.errors.AlreadyExists,
      "File exists",
    );
    assertEquals(await Deno.readTextFile(preload), "existing preload\n");
    assertEquals([...Deno.readDirSync(directory)].map((entry) => entry.name), [
      "authenticator-time.mjs",
    ]);
  }));

Deno.test("fixture clock: native login selection and explicit advances share one publication sequence", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope),
      entered = fixtureGate(scope),
      release = fixtureGate(scope);
    const clock = (await scope.acquire(
      () => createNativeTotpClock(directory, 1234567890_000),
      (clock) => clock.close(),
    )).value;
    const initial = clock.now(),
      secret = "JBSWY3DPEHPK3PXP",
      generate = clock.code;
    const admissions: number[] = [];
    clock.code = async (key: string, offset = 0) => {
      admissions.push(clock.now());
      const code = await generate(key, offset);
      if (admissions.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return code;
    };
    const first = clock.loginCode(secret, []);
    await bounded(
      workMilestone(first, entered.promise, "native code selection"),
      "native code selection",
    );
    const second = clock.loginCode(secret, []), advanced = clock.advanceStep();
    try {
      assertEquals(admissions, [initial]);
    } finally {
      release.resolve();
    }
    const codes: string[] = await Promise.all([first, second]);
    await advanced;
    assertEquals(admissions, [initial, initial + TOTP_STEP_MS]);
    assertEquals(
      codes,
      await Promise.all(
        [1, 2].map((step) =>
          authenticatorCode(secret, initial + step * TOTP_STEP_MS)
        ),
      ),
    );
    assertEquals([
      clock.now(),
      fixtureClockReader(`${directory}/authenticator-clock`)(),
    ], [initial + 3 * TOTP_STEP_MS, initial + 3 * TOTP_STEP_MS]);
    const cause = new Error("consumed codes unavailable");
    assertStrictEquals(
      await assertRejects(
        () =>
          clock.loginCode(secret, {
            [Symbol.iterator]() {
              throw cause;
            },
          }),
        Error,
        cause.message,
      ),
      cause,
    );
    assertEquals(clock.now(), initial + 3 * TOTP_STEP_MS);
  }));

Deno.test("fixture clock: failed driver composition has no escaped plugin root", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope), scratch = `${directory}/scratch`;
    await Deno.mkdir(scratch);
    const probe = `${directory}/driver-construction.mjs`;
    await Deno.writeTextFile(
      probe,
      `
      import { assertStrictEquals, assertRejects } from "@std/assert";
      import { driverFixture, storageServerFixture } from ${
        JSON.stringify(
          new URL("./helpers/driver_fixture.ts", import.meta.url).href,
        )
      };
      const clock = await assertRejects(() => storageServerFixture([], { observedTime: NaN }), TypeError, "Invalid fixture clock time");
      const cause = new Error("driver declaration failed");
      const driver = await assertRejects(() => driverFixture("", { toJSON() { throw cause; } }), Error, cause.message);
      assertStrictEquals(driver, cause);
      console.log(JSON.stringify([clock.message, driver.message]));
    `,
    );
    const child = (await spawnOwnedChild(scope, DENO, {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        probe,
      ],
      env: { TMPDIR: scratch },
      stdout: "piped",
      stderr: "piped",
    })).value;
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assertEquals(status.success, true, stderr);
    assertEquals(JSON.parse(stdout), [
      "Invalid fixture clock time",
      "driver declaration failed",
    ]);
    assertEquals([...Deno.readDirSync(scratch)], []);
  }));

Deno.test("fixture clock: native retirement fences held selection and queued advances before publication", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope),
      entered = fixtureGate(scope),
      release = fixtureGate(scope);
    let writes = 0;
    const io: RecordChannelIO = {
      ...nativeRecordChannelIO,
      publication: {
        ...nativeRecordChannelIO.publication,
        write(file, bytes, signal) {
          writes++;
          return nativeRecordChannelIO.publication.write(file, bytes, signal);
        },
      },
    };
    const clock = (await scope.acquire(
      () => createNativeTotpClock(directory, 1234567890_000, { io }),
      (clock) => clock.close(),
    )).value;
    const initial = clock.now(), generate = clock.code;
    clock.code = async (secret: string, offset = 0) => {
      const code = await generate(secret, offset);
      entered.resolve();
      await release.promise;
      return code;
    };
    const selecting = clock.loginCode("JBSWY3DPEHPK3PXP", []);
    await bounded(
      workMilestone(selecting, entered.promise, "retired native selection"),
      "retired native selection",
    );
    const advanced = clock.advanceStep();
    const rejectedSelection = assertRejects(
      () => selecting,
      OwnershipError,
      "Owner is retired",
    );
    const rejectedAdvance = assertRejects(
      () => advanced,
      OwnershipError,
      "Owner is retired",
    );
    const closing = clock.close();
    release.resolve();
    await bounded(closing, "native selection retirement drain");
    await Promise.all([rejectedSelection, rejectedAdvance]);
    assertEquals([writes, clock.now()], [1, initial]);
    assertEquals([...Deno.readDirSync(directory)].map((entry) => entry.name), [
      "authenticator-time.mjs",
    ]);
  }));

Deno.test("fixture clock: held publication leaves both local and reader time unchanged until commit", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    const staged = fixtureGate(scope), commit = fixtureGate(scope);
    let held = false;
    const io: RecordChannelIO = {
      ...nativeRecordChannelIO,
      publication: {
        ...nativeRecordChannelIO.publication,
        async write(file, bytes) {
          await nativeRecordChannelIO.publication.write(file, bytes);
          if (held) {
            staged.resolve();
            await commit.promise;
          }
        },
      },
    };
    const clock = (await scope.acquire(
      () => createFixtureClock(directory, "clock", 100, { io }),
      (clock) => clock.close(),
    )).value;
    const read = fixtureClockReader(clock.directory);
    held = true;
    const advancing = clock.advance(25);
    try {
      await bounded(
        workMilestone(advancing, staged.promise, "clock staging"),
        "clock staging",
      );
      assertEquals(clock.now(), 100);
      assertEquals(read(), 100);
    } finally {
      commit.resolve();
      await advancing;
    }
    assertEquals(clock.now(), 125);
    assertEquals(read(), 125);
  }));

for (const outcome of ["rejected", "completed"] as const) {
  Deno.test(`fixture clock: ${outcome} publication cannot strand an unopened entry gate`, () =>
    fixtureScope(async (scope) => {
      const directory = await root(scope), entered = fixtureGate(scope);
      const cause = new Error("clock staging rejected before entry");
      let failing = false;
      const io: RecordChannelIO = {
        ...nativeRecordChannelIO,
        publication: {
          ...nativeRecordChannelIO.publication,
          write(file, bytes, signal) {
            if (failing && outcome === "rejected") throw cause;
            return nativeRecordChannelIO.publication.write(file, bytes, signal);
          },
        },
      };
      const clock = (await scope.acquire(
        () => createFixtureClock(directory, "clock", 100, { io }),
        (clock) => clock.close(),
      )).value;
      failing = true;
      const operation = clock.advance(25);
      const failure = await assertRejects(
        () =>
          bounded(
            workMilestone(operation, entered.promise, "clock entry"),
            "clock entry",
          ),
        Error,
        outcome === "rejected"
          ? cause.message
          : "clock entry: product work settled without the expected milestone",
      );
      if (outcome === "rejected") assertStrictEquals(failure, cause);
      const expected = outcome === "rejected" ? 100 : 125;
      assertEquals([clock.now(), fixtureClockReader(clock.directory)()], [
        expected,
        expected,
      ]);
      assertEquals(
        [...Deno.readDirSync(clock.directory)].map((entry) => entry.name),
        ["time.json"],
      );
    }));
}

for (const boundary of ["write", "rename"] as const) {
  Deno.test(`fixture clock: ${boundary} failure preserves published/local time and next advance recovers`, () =>
    fixtureScope(async (scope) => {
      const directory = await root(scope);
      const cause = new Error(`injected clock ${boundary}`);
      let failing = false;
      const io: RecordChannelIO = {
        ...nativeRecordChannelIO,
        publication: {
          ...nativeRecordChannelIO.publication,
          write(file, bytes) {
            if (failing && boundary === "write") throw cause;
            return nativeRecordChannelIO.publication.write(file, bytes);
          },
          rename(from, to) {
            if (failing && boundary === "rename") throw cause;
            return nativeRecordChannelIO.publication.rename(from, to);
          },
        },
      };
      const clock = (await scope.acquire(
        () => createFixtureClock(directory, "clock", 100, { io }),
        (clock) => clock.close(),
      )).value;
      const read = fixtureClockReader(clock.directory);
      failing = true;
      assertStrictEquals(
        await assertRejects(() => clock.advance(50), Error, cause.message),
        cause,
      );
      assertEquals(clock.now(), 100);
      assertEquals(read(), 100);
      assertEquals(
        [...Deno.readDirSync(clock.directory)].map((entry) => entry.name),
        ["time.json"],
      );
      failing = false;
      await clock.advance(25);
      assertEquals(clock.now(), 125);
      assertEquals(read(), 125);
    }));
}

Deno.test("fixture clock: serialized advances derive from the last committed value", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    const clock = (await scope.acquire(
      () => createFixtureClock(directory, "clock", 100),
      (clock) => clock.close(),
    )).value;
    await Promise.all([clock.advance(10), clock.advance(20)]);
    assertEquals(clock.now(), 130);
    assertEquals(fixtureClockReader(clock.directory)(), 130);
  }));

Deno.test("fixture clock: serialized driver replacements retain startup custody and the published clock consumer", () =>
  fixtureScope(async (scope) => {
    const remote = (await scope.acquire(memoryRemote, (remote) =>
      remote.close())).value;
    remote.put("clock.md", "clock across server replacements\n");
    const fixture = (await scope.acquire(
      () => storageServerFixture([remote.authority], { observedTime: 50000 }),
      (fixture) => fixture.close(),
    )).value;
    const clock = fixture.clock;
    assert(clock);
    const id = await fixture.add(remote.baseUrl, remote.token);
    await clock.advance(1500);
    const first = fixture.restart(), second = fixture.restart();
    first.catch(() => {});
    second.catch(() => {});
    const a = await bounded(first, "first clock replacement");
    const b = await bounded(second, "second clock replacement");
    assertEquals([a.server.status()?.success, b.server.status()], [true, null]);
    assertStrictEquals(fixture.server(), b.server);
    assertEquals(await b.initialDriver(id, "active"), {
      pid: b.server.pid,
      owner: `${b.server.pid}:1`,
      state: "active",
    });
    await assertRejects(
      () => a.initialDriver(id, "active"),
      Error,
      `driver '${id}' initial cycle: server owner replaced`,
    );
    assertEquals(
      Deno.readTextFileSync(`${fixture.vault}/clock.md`),
      "clock across server replacements\n",
    );
    remote.faults.push({ path: "/list", status: 429, retryAfterMs: 23000 });
    const failed = await fixture.sync(id);
    assertEquals([failed.status, failed.error.code, failed.nextRetry], [
      "failed",
      "rate_limited",
      23000,
    ]);
    await clock.advance(1500);
    const later = await fixture.one(id);
    assertEquals([
      clock.now(),
      fixtureClockReader(clock.directory)(),
      later.nextRetry,
    ], [53000, 53000, 21500]);
    await fixture.close();
    await assertRejects(
      () => clock.advance(1),
      OwnershipError,
      "Owner is retired",
    );
    assertThrows(
      () => Deno.statSync(fixture.root),
      Deno.errors.NotFound,
      "No such file or directory",
    );
  }));

Deno.test("fixture clock: construction captures IO options before directory acquisition yields", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    let captures = 0, writes = 0;
    const options = {
      get io(): RecordChannelIO {
        captures++;
        if (captures !== 1) throw new Error("clock options read twice");
        return {
          ...nativeRecordChannelIO,
          publication: {
            ...nativeRecordChannelIO.publication,
            write(file, bytes, signal) {
              writes++;
              return nativeRecordChannelIO.publication.write(
                file,
                bytes,
                signal,
              );
            },
          },
        };
      },
    };
    const constructing = scope.acquire(
      () => createFixtureClock(directory, "clock", 100, options),
      (clock) => clock.close(),
    );
    const beforeYield = captures;
    const clock = (await constructing).value;
    assertEquals(beforeYield, 1);
    await clock.advance(25);
    assertEquals([
      captures,
      writes,
      clock.now(),
      fixtureClockReader(clock.directory)(),
    ], [1, 2, 125, 125]);
  }));

Deno.test("fixture clock: concurrent close joins held publication cleanup", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope),
      staged = fixtureGate(scope),
      releasing = fixtureGate(scope),
      release = fixtureGate(scope);
    let failing = false;
    const io: RecordChannelIO = {
      ...nativeRecordChannelIO,
      publication: {
        ...nativeRecordChannelIO.publication,
        async write(file, bytes, signal) {
          await nativeRecordChannelIO.publication.write(file, bytes, signal);
          if (failing) {
            staged.resolve();
            await waitForCancellation(signal!);
          }
        },
        async remove(file) {
          if (failing) {
            releasing.resolve();
            await release.promise;
          }
          await nativeRecordChannelIO.publication.remove(file);
        },
      },
    };
    const clock = (await scope.acquire(() =>
      createFixtureClock(directory, "clock", 100, { io }), (clock) =>
      clock.close())).value;
    failing = true;
    const advancing = clock.advance(25);
    await bounded(
      workMilestone(advancing, staged.promise, "close staging"),
      "close staging",
    );
    const rejected = assertRejects(
      () =>
        advancing,
      OwnershipError,
      "Fixture scope retired",
    );
    const first = clock.close(), second = clock.close();
    const events: string[] = [];
    const settled = [first, second].map((closing, index) =>
      closing.then(() =>
        events.push(`closed-${index}`)
      )
    );
    try {
      await bounded(
        workMilestone(first, releasing.promise, "cleanup entry"),
        "cleanup entry",
      );
      assertEquals(events, []);
    } finally {
      release.resolve();
    }
    await Promise.all(settled);
    await rejected;
    assertEquals(events, ["closed-0", "closed-1"]);
    assertEquals(clock.now(), 100);
  }));

Deno.test("fixture clock: invalid initial publication releases its owned root", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    await assertRejects(
      () => createFixtureClock(directory, "clock", NaN),
      TypeError,
      "Invalid fixture clock time",
    );
    assertEquals([...Deno.readDirSync(directory)], []);
  }));

for (const boundary of ["write", "link"] as const) {
  Deno.test(`fixture clock: initial ${boundary} failure releases its partial clock directory`, () =>
    fixtureScope(async (scope) => {
      const directory = await root(scope);
      const cause = new Error(`initial ${boundary} failed`);
      const io: RecordChannelIO = {
        ...nativeRecordChannelIO,
        publication: {
          ...nativeRecordChannelIO.publication,
          [boundary]: () => {
            throw cause;
          },
        },
      };
      assertStrictEquals(
        await assertRejects(
          () => createFixtureClock(directory, "clock", 100, { io }),
          Error,
          cause.message,
        ),
        cause,
      );
      assertEquals([...Deno.readDirSync(directory)], []);
    }));
}

Deno.test("fixture clock: retirement forbids further publication, missing records never use live time", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    const clock = (await scope.acquire(
      () => createFixtureClock(directory, "clock", 100),
      (clock) => clock.close(),
    )).value;
    const read = fixtureClockReader(clock.directory);
    await Deno.writeTextFile(
      `${clock.directory}/time.json`,
      JSON.stringify({ now: "not time" }),
    );
    assertThrows(read, TypeError, "Invalid fixture clock time");
    await Deno.remove(`${clock.directory}/time.json`);
    assertThrows(read, Error, "Fixture clock record is missing");
    await clock.close();
    await assertRejects(
      () => clock.advance(1),
      OwnershipError,
      "Owner is retired",
    );
  }));

Deno.test("fixture clock: real child verifier rejects expired input and serves an authenticated note with fresh reference input", () =>
  fixtureScope(async (scope) => {
    const directory = await root(scope);
    const clock = (await scope.acquire(
      () => createNativeTotpClock(directory),
      (clock) => clock.close(),
    )).value;
    const server = (await scope.acquire(
      () => bootServer({}, { denoArgs: clock.denoArgs }),
      (server) => server.close(),
    )).value;
    await Deno.writeTextFile(
      `${server.vault}/Clock.md`,
      "authenticated fixture clock consumer\n",
    );
    const post = (route: string, body: unknown) =>
      fetch(`${server.baseUrl}/_/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const enrollment = await post("setup/totp-enrolment", {
      username: "alice",
    });
    assertEquals(enrollment.status, 200);
    const bundle = await enrollment.json();
    let old = await clock.code(bundle.secret, -1);
    const confirmed = await clock.code(bundle.secret);
    const setup = await post("setup", {
      mode: "password",
      username: "alice",
      password: "secret",
      totpKey: bundle.key,
      totpCode: confirmed,
    });
    assertEquals(setup.status, 200);
    await setup.arrayBuffer();
    const beforeLogin = clock.now();
    const code = await clock.loginCode(bundle.secret, [confirmed]);
    assert(
      clock.now() > beforeLogin,
      "Verifier time must be published before login input",
    );
    const valid = new Set(
      await Promise.all(
        [-1, 0, 1].map((offset) => clock.code(bundle.secret, offset)),
      ),
    );
    // An expired step can coincidentally have the same six digits as a live
    // step. Select an actually expired input, not a probabilistic negative.
    for (let offset = -3; valid.has(old); offset--) {
      old = await clock.code(bundle.secret, offset);
    }
    const expired = await post("token", {
      username: "alice",
      password: `secret${old}`,
    });
    assertEquals(expired.status, 401);
    await expired.arrayBuffer();
    const login = await post("token", {
      username: "alice",
      password: `secret${code}`,
    });
    assertEquals(login.status, 200);
    const { access_token: token } = await login.json();
    assert(typeof token === "string");
    const note = await fetch(`${server.baseUrl}/_/api/notes/Clock`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assertEquals(note.status, 200);
    assertEquals(
      (await note.json()).content,
      "authenticated fixture clock consumer\n",
    );
  }));
