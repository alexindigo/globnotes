// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  nativeRecordIO,
  publishRecord,
  readRecord,
  watchOwnerPipe,
} from "./helpers/process_records.ts";
import { waitForAudit } from "./helpers/catalog_work_audit.ts";
import { done, pending, waitUntil } from "./helpers/wait.ts";
import { command } from "./helpers/process.ts";

Deno.test("process records: a slow partial write is invisible until publication", async () => {
  const directory = await Deno.makeTempDir({ prefix: "record-partial-" }),
    path = `${directory}/completed.json`;
  const release = Promise.withResolvers<void>();
  let staged = "";
  const writing = Promise.resolve(
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
  try {
    assertEquals(
      readRecord(path),
      null,
      "a reader must not see the producer's partial file",
    );
  } finally {
    release.resolve();
    await writing;
  }
  try {
    assertEquals(readRecord(path), { complete: true });
    assertEquals(staged === path, false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("process records: malformed final records reject and failed publication removes staging", async () => {
  const directory = await Deno.makeTempDir({ prefix: "record-invalid-" });
  try {
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
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("process records: real server exit wakes audit before a live client exits and reaps both owners", async () => {
  const directory = await Deno.makeTempDir({ prefix: "record-real-exit-" });
  const client = command(Deno.execPath(), {
    args: ["eval", "await Deno.stdin.readable.getReader().read();"],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const server = command(Deno.execPath(), {
    args: [
      "eval",
      "await Deno.stdin.readable.getReader().read(); Deno.exit(17);",
    ],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  let clientExited = false;
  const clientExit = client.status.then((status) => {
    clientExited = true;
    return status;
  });
  try {
    const waiting = assertRejects(
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
  } finally {
    try {
      client.kill("SIGKILL");
    } catch { /* already exited */ }
    await Promise.all([client.status, server.status]);
    try {
      await client.stdin.close();
    } catch { /* already closed */ }
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("process records: coordinator pipe EOF rejects record wait and disposal releases readers", async () => {
  const directory = await Deno.makeTempDir({ prefix: "record-owner-pipe-" });
  const pipe = new TransformStream<Uint8Array>(),
    writer = pipe.writable.getWriter();
  const owner = watchOwnerPipe(pipe.readable, "coordinator");
  try {
    const waiting = assertRejects(
      () => waitForAudit(directory, "completed", [owner]),
      Error,
      "coordinator exited before completed",
    );
    await writer.close();
    await waiting;
  } finally {
    await owner.dispose();
    writer.releaseLock();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("process records: wrapped server exit breaks the live client's audit wait and reaches cleanup", async () => {
  const directory = await Deno.makeTempDir({ prefix: "record-server-exit-" });
  const client = Promise.withResolvers<{ code: number }>(),
    server = Promise.withResolvers<{ code: number }>();
  let failure: Error | undefined, cleaned = false;
  const waiting = waitForAudit(directory, "completed", [{
    label: "client",
    exit: client.promise,
  }, { label: "wrapped server", exit: server.promise }])
    .catch((error) => {
      failure = error;
    }).finally(() => {
      cleaned = true;
    });
  try {
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
  } finally {
    // Release the old implementation after the red control, without leaving a watcher.
    publishRecord(
      `${directory}/completed.json`,
      JSON.stringify({ rescued: true }),
    );
    client.resolve({ code: 0 });
    await waiting;
    await Deno.remove(directory, { recursive: true });
  }
});
