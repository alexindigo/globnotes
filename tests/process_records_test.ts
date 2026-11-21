// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  nativeRecordIO,
  publishRecord,
  readRecord,
  waitForRecord,
  watchOwnerPipe,
} from "./helpers/process_records.ts";
import type { RecordIO } from "./helpers/record_publication.ts";
import { waitForAudit } from "./helpers/catalog_work_audit.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { command } from "./helpers/process.ts";
import { type FixtureScope, fixtureScope } from "./helpers/fixture_scope.ts";
import { fixtureGate, fixtureTest } from "./helpers/fixture_coordination.ts";

function withDirectory<T>(
  body: (directory: string, scope: FixtureScope) => T | Promise<T>,
) {
  return fixtureScope(async (scope) => {
    const directory = (await scope.acquire(() =>
      Deno.makeTempDir({ prefix: "process-records-" }), (directory) =>
      Deno.remove(directory, { recursive: true }))).value;
    return body(directory, scope);
  });
}

Deno.test("process records: copied publication module carries its complete protocol into an isolated child", async () => {
  await withDirectory(async (directory, scope) => {
    await Deno.copyFile(
      new URL("./helpers/record_publication.ts", import.meta.url),
      `${directory}/publication.ts`,
    );
    await Deno.writeTextFile(
      `${directory}/consumer.mjs`,
      `
      import { publishRecord } from "./publication.ts";
      const outcomes = [];
      for (const mode of ["sync", "promise", "thenable"]) {
        for (const createNew of [false, true]) {
          const files = new Map(), events = [];
          const complete = phase => {
            if (mode === "sync") return;
            const then = resolve => { events.push(phase + ":settled"); resolve(); };
            return mode === "promise" ? new Promise(then) : { then };
          };
          const io = {
            files,
            unique() { return "candidate"; },
            write(path, bytes) { events.push("write"); this.files.set(path, bytes); return complete("write"); },
            rename(from, to) { events.push("rename"); this.files.set(to, this.files.get(from)); this.files.delete(from); return complete("rename"); },
            link(from, to) { events.push("link"); this.files.set(to, this.files.get(from)); return complete("link"); },
            remove(path) { events.push("remove"); this.files.delete(path); return complete("remove"); },
          };
          const pending = publishRecord("record.json", '{"ready":true}', { createNew }, io);
          const synchronous = pending === undefined;
          await pending;
          outcomes.push({ mode, createNew, synchronous, events, files: [...files] });
        }
      }
      console.log(JSON.stringify(outcomes));
    `,
    );
    const child = (await scope.acquire(() =>
      command(Deno.execPath(), {
        args: ["run", "--no-config", `${directory}/consumer.mjs`],
        stdout: "piped",
        stderr: "piped",
      }).spawn(), async (child) => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      await child.status;
    })).value;
    const result = await child.output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(
      JSON.parse(new TextDecoder().decode(result.stdout)),
      ["sync", "promise", "thenable"].flatMap((mode) =>
        [false, true].map((createNew) => ({
          mode,
          createNew,
          synchronous: mode === "sync",
          events: ["write", createNew ? "link" : "rename", "remove"].flatMap(
            (phase) => mode === "sync" ? [phase] : [phase, `${phase}:settled`],
          ),
          files: [["record.json", '{"ready":true}']],
        }))
      ),
    );
  });
});

for (const phase of ["write", "rename", "link", "remove"] as const) {
  Deno.test(`record custody r3: ${phase} completion is captured once before the next effect`, async () => {
    await withDirectory(async (directory) => {
      const file = `${directory}/record.json`;
      const events: string[] = [];
      let thenReads = 0;
      const completion = {
        get then() {
          thenReads++;
          if (thenReads !== 1) throw new Error("IO completion resolved twice");
          return (resolve: () => void) => {
            events.push(`${phase}:settled`);
            resolve();
          };
        },
      };
      const io = Object.fromEntries(
        Object.entries(nativeRecordIO).map(([name, effect]) => [
          name,
          name === "unique" ? effect : (...args: unknown[]) => {
            events.push(name);
            (effect as (...args: unknown[]) => unknown)(...args);
            // JS protocol adapters can return a thenable without a native Promise.
            return name === phase ? completion : undefined;
          },
        ]),
      ) as unknown as RecordIO;
      await publishRecord(file, '{"complete":true}', {
        createNew: phase === "link",
      }, io);
      const commit = phase === "link" ? "link" : "rename";
      const expected = ["write", commit, "remove"];
      expected.splice(expected.indexOf(phase) + 1, 0, `${phase}:settled`);
      assertEquals(events, expected);
      assertEquals(thenReads, 1);
      assertEquals(readRecord(file), { complete: true });
      assertEquals(
        [...Deno.readDirSync(directory)].map((entry) => entry.name),
        [
          "record.json",
        ],
      );
    });
  });
}

fixtureTest(
  "record custody r3: publication retains exclusive options and IO capabilities across staging",
  async (testScope) => {
    await withDirectory(async (directory, scope) => {
      const file = `${directory}/record.json`;
      publishRecord(file, '{"winner":true}');
      const release = fixtureGate(testScope), entered = fixtureGate(testScope);
      scope.onCancel(() => release.resolve());
      const io: RecordIO = {
        ...nativeRecordIO,
        write(file, content) {
          nativeRecordIO.write(file, content);
          entered.resolve();
          return release.promise;
        },
      };
      const options = { createNew: true };
      const writing = Promise.resolve(
        publishRecord(file, '{"loser":true}', options, io),
      );
      const rejected = assertRejects(() => writing, Deno.errors.AlreadyExists);
      await entered.promise;
      options.createNew = false;
      io.link = nativeRecordIO.rename;
      io.remove = () => {
        throw new Error("mutable staging cleanup reread");
      };
      release.resolve();
      await rejected;
      assertEquals(readRecord(file), { winner: true });
      assertEquals(
        [...Deno.readDirSync(directory)].map((entry) => entry.name),
        ["record.json"],
      );
    });
  },
);

for (const asynchronous of [false, true]) {
  for (const phase of ["write", "rename", "link"] as const) {
    Deno.test(`record custody review: ${phase} and cleanup errors are both retained (${asynchronous ? "async" : "sync"})`, async () => {
      const primary = new Error("publication failed"),
        cleanup = new Error("staging cleanup failed");
      let removes = 0;
      const fail = (error: Error) => {
        if (asynchronous) return Promise.reject(error);
        throw error;
      };
      const io: RecordIO = {
        unique: () => "candidate",
        write: () => phase === "write" ? fail(primary) : undefined,
        rename: () => phase === "rename" ? fail(primary) : undefined,
        link: () => phase === "link" ? fail(primary) : undefined,
        remove: () => {
          removes++;
          return fail(cleanup);
        },
      };
      const error = await assertRejects(async () =>
        await publishRecord("record", "{}", { createNew: phase === "link" }, io)
      );
      assertInstanceOf(error, AggregateError);
      assertEquals(error.errors, [primary, cleanup]);
      assertStrictEquals(error.cause, primary);
      assertEquals(removes, 1);
    });
  }
  Deno.test(`record custody review: failed successful-publication cleanup is not retried (${asynchronous ? "async" : "sync"})`, async () => {
    const failure = new Error("successful publication cleanup failed");
    let removes = 0;
    const io: RecordIO = {
      unique: () => "candidate",
      write: () => undefined,
      rename: () => undefined,
      remove: () => {
        removes++;
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      },
    };
    const error = await assertRejects(async () =>
      await publishRecord("record", "{}", {}, io)
    );
    assertStrictEquals(error, failure);
    assertEquals(removes, 1);
  });
}

Deno.test("record custody review: observer owns its watcher before listener construction can fail", async () => {
  await withDirectory(async (directory, scope) => {
    const failure = new Error("observer listener setup failed");
    let closes = 0;
    const watch = (directory: string) => {
      const watcher = Deno.watchFs(directory),
        close = watcher.close.bind(watcher);
      scope.defer(() => {
        try {
          close();
        } catch (error) {
          if (!(error instanceof Deno.errors.BadResource)) throw error;
        }
      });
      watcher.close = () => {
        closes++;
        close();
      };
      return watcher;
    };
    const signal = new AbortController().signal;
    const add = signal.addEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      add(...args);
      throw failure;
    }) as typeof signal.addEventListener;
    const error = await assertRejects(() =>
      waitForRecord(directory, "setup", () => null, [], signal, watch)
    );
    assertStrictEquals(error, failure);
    assertEquals(closes, 1);
  });
});

fixtureTest(
  "process records: a slow partial write is invisible until publication",
  async (testScope) => {
    await withDirectory(async (directory, scope) => {
      const path = `${directory}/completed.json`;
      const release = fixtureGate(testScope);
      let staged = "";
      let writing: Promise<unknown> = Promise.resolve();
      scope.defer(() => writing);
      scope.onCancel(() => release.resolve());
      writing = Promise.resolve(
        publishRecord(path, '{"complete":true}', {}, {
          ...nativeRecordIO,
          write(file) {
            staged = file;
            Deno.writeTextFileSync(file, '{"complete":');
            return release.promise.then(() => {
              Deno.writeTextFileSync(file, '{"complete":true}');
            });
          },
        }),
      );
      assertEquals(
        readRecord(path),
        null,
        "a reader must not see the producer's partial file",
      );
      release.resolve();
      await writing;
      assertEquals(readRecord(path), { complete: true });
      assertEquals(staged === path, false);
    });
  },
);

Deno.test("process records: malformed final records reject and failed publication removes staging", async () => {
  await withDirectory(async (directory) => {
    for (const text of ['{"partial":', "null", "[]", "true"]) {
      Deno.writeTextFileSync(`${directory}/invalid.json`, text);
      assertThrows(() => readRecord(`${directory}/invalid.json`));
    }
    await assertRejects(
      () =>
        Promise.resolve(publishRecord(`${directory}/failed.json`, "{}", {}, {
          ...nativeRecordIO,
          async write(path) {
            await Deno.writeTextFile(path, "{");
            throw Error("injected partial write failure");
          },
        })),
      Error,
      "injected partial write failure",
    );
    assertEquals(readRecord(`${directory}/failed.json`), null);
    assertEquals([...Deno.readDirSync(directory)].map((entry) => entry.name), [
      "invalid.json",
    ]);
  });
});

Deno.test("process records: real server exit wakes audit before a live client exits and reaps both owners", async () => {
  await withDirectory(async (directory, scope) => {
    let waiting: Promise<unknown> = Promise.resolve();
    // Reap children before collecting the observation, and collect it before
    // deleting the directory, including failure before the first awaited result.
    scope.defer(() => waiting);
    const client = (await scope.acquire(() =>
      command(Deno.execPath(), {
        args: ["eval", "await Deno.stdin.readable.getReader().read();"],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn(), async (child) => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      await child.status;
    })).value;
    const server = (await scope.acquire(() =>
      command(Deno.execPath(), {
        args: [
          "eval",
          "await Deno.stdin.readable.getReader().read(); Deno.exit(17);",
        ],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn(), async (child) => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      await child.status;
    })).value;
    scope.defer(() => client.stdin.close().catch(() => {}));
    let clientExited = false;
    const clientExit = client.status.then((status) => {
      clientExited = true;
      return status;
    });
    waiting = assertRejects(
      () =>
        waitForAudit(directory, "completed", [{
          label: "live client",
          exit: clientExit,
        }, { label: "wrapped server", exit: server.status }]),
      Error,
      "wrapped server exited before completed: 17",
    );
    await server.stdin.close();
    await waiting;
    assertEquals(clientExited, false);
  });
});

Deno.test("process records: coordinator pipe EOF rejects record wait and disposal releases readers", async () => {
  await withDirectory(async (directory, scope) => {
    let waiting: Promise<unknown> = Promise.resolve();
    scope.defer(() => waiting);
    const pipe = new TransformStream<Uint8Array>();
    const writer = (await scope.acquire(() =>
      pipe.writable.getWriter(), (writer) =>
      writer.releaseLock())).value;
    const owner = (await scope.acquire(() =>
      watchOwnerPipe(pipe.readable, "coordinator"), (owner) =>
      owner.dispose())).value;
    waiting = assertRejects(
      () =>
        waitForAudit(directory, "completed", [owner]),
      Error,
      "coordinator exited before completed",
    );
    await writer.close();
    await waiting;
  });
});

Deno.test("process records: wrapped server exit breaks the live client's audit wait and reaches cleanup", async () => {
  await withDirectory(async (directory, scope) => {
    const client = Promise.withResolvers<{ code: number }>(),
      server = Promise.withResolvers<{ code: number }>();
    let failure: Error | undefined, cleaned = false;
    let waiting: Promise<unknown> = Promise.resolve();
    scope.defer(() => waiting);
    scope.onCancel(() => client.resolve({ code: 0 }));
    scope.onCancel(() => server.resolve({ code: 0 }));
    waiting = waitForAudit(directory, "completed", [{
      label: "client",
      exit: client.promise,
    }, { label: "wrapped server", exit: server.promise }])
      .catch((error) => {
        failure = error;
      }).finally(() => {
        cleaned = true;
      });
    server.resolve({ code: 17 });
    await waitUntil(
      () =>
        cleaned
          ? done()
          : pending("audit still waiting after wrapped server exit"),
      { label: "wrapped server exit control" },
    );
    assertEquals(failure?.message.includes("17"), true);
    assertEquals(cleaned, true);
  });
});
