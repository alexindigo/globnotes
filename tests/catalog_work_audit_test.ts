// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  auditInvocation,
  probeAudit,
  waitForAudit,
} from "./helpers/catalog_work_audit.ts";
import { finalizeNativeCase } from "../client/tests/e2e/native-case-finalization.mjs";
import { publishRecord } from "./helpers/process_records.ts";
// The existing JavaScript helper's empty-array default infers never[] in Deno.
const finalize = finalizeNativeCase as unknown as (options: {
  report: () => Promise<unknown>;
  cleanup: Array<() => void>;
}) => Promise<void>;

Deno.test("catalogue audit: a throwing completion audit records invocation error", async () => {
  const directory = await Deno.makeTempDir({ prefix: "audit-throw-" });
  const failure = Error("backup file unreadable");
  const original = Promise.resolve("original invocation result");
  try {
    await auditInvocation(original, () => {
      throw failure;
    }, async (error) => {
      await publishRecord(
        `${directory}/invocation-error.json`,
        JSON.stringify({ detail: String(error) }),
      );
    });
    assertEquals(await original, "original invocation result");
    await assertRejects(
      () => probeAudit(directory, "completed"),
      Error,
      failure.message,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("catalogue audit: every event uses the same terminal error probe", async () => {
  const directory = await Deno.makeTempDir({ prefix: "audit-event-" });
  const waiting = assertRejects(
    () => waitForAudit(directory, "completed"),
    Error,
    "event audit failure",
  );
  try {
    await publishRecord(
      `${directory}/invocation-error.json`,
      JSON.stringify({ detail: "event audit failure" }),
    );
    await waiting;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("catalogue audit: child exit closes the pending watcher and still runs every cleanup", async () => {
  const directory = await Deno.makeTempDir({ prefix: "audit-exit-" });
  const cleaned: string[] = [];
  try {
    await assertRejects(
      () =>
        finalize({
          report: () =>
            waitForAudit(directory, "completed", Promise.resolve({ code: 17 })),
          cleanup: [() => {
            cleaned.push("server");
            throw Error("server cleanup diagnostic");
          }, () => {
            cleaned.push("child");
          }],
        }),
      AggregateError,
      "Native diagnostics or cleanup failed",
    );
    assertEquals(cleaned, ["server", "child"]);
    await assertRejects(
      () =>
        waitForAudit(directory, "before-stop", Promise.resolve({ code: 23 })),
      Error,
      "Native child exited before before-stop: 23",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("catalogue audit: terminal files win the exit race and errors win over completed", async () => {
  const directory = await Deno.makeTempDir({ prefix: "audit-exit-terminal-" });
  try {
    await publishRecord(
      `${directory}/completed.json`,
      JSON.stringify({ audited: true }),
    );
    assertEquals(
      await waitForAudit(directory, "completed", Promise.resolve({ code: 0 })),
      { audited: true },
    );
    await publishRecord(
      `${directory}/invocation-error.json`,
      JSON.stringify({ detail: "terminal error wins" }),
    );
    await assertRejects(
      () => waitForAudit(directory, "completed", Promise.resolve({ code: 1 })),
      Error,
      "terminal error wins",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("catalogue audit: the initial terminal probe rejects an existing error file", async () => {
  const directory = await Deno.makeTempDir({ prefix: "audit-existing-error-" });
  try {
    await publishRecord(
      `${directory}/invocation-error.json`,
      JSON.stringify({ detail: "already failed audit" }),
    );
    await assertRejects(
      () => probeAudit(directory, "completed"),
      Error,
      "already failed audit",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
