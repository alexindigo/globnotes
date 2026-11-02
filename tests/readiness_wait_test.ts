// SPDX-License-Identifier: LGPL-3.0-only

/** The shared readiness wait (tests/helpers/wait.ts): one bound, terminal
 * states fail at once, and every failure reports its label and the last
 * observed state. */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { PLUGIN_LIMITS } from "../server/plugins/contracts.ts";
import {
  done,
  failed,
  pending,
  READINESS_MS,
  ReadinessError,
  waitUntil,
} from "./helpers/wait.ts";

Deno.test("readiness wait: returns the value once the probe is done", async () => {
  let polls = 0;
  const value = await waitUntil(
    () => ++polls < 3 ? pending({ polls }) : done("ready"),
    { label: "three polls", intervalMs: 1 },
  );
  assertEquals(value, "ready");
  assertEquals(polls, 3);
});

Deno.test("readiness wait: a terminal state fails at once with its full state", async () => {
  const error = await assertRejects(
    () =>
      waitUntil(
        () =>
          failed("plugin 'b' failed", {
            a: { status: "ready" },
            b: { status: "failed", diagnostics: ["worker failed"] },
          }),
        { label: "plugins a and b ready" },
      ),
    ReadinessError,
  );
  assert(error.elapsedMs < READINESS_MS / 2);
  assert(error.message.startsWith("plugins a and b ready: plugin 'b' failed"));
  assert(error.message.includes('"a":{"status":"ready"}'), error.message);
  assert(error.message.includes('"diagnostics":["worker failed"]'));
});

Deno.test("readiness wait: a throwing probe fails at once and keeps the cause", async () => {
  const cause = new Error("catalog rejected: 500");
  const error = await assertRejects(
    () =>
      waitUntil(() => {
        throw cause;
      }, { label: "catalog" }),
    ReadinessError,
  );
  assert(error.message.includes("probe failed: catalog rejected: 500"));
  assertEquals(error.cause, cause);
});

Deno.test("readiness wait: an exited child fails at once with its output", async () => {
  let polls = 0;
  const error = await assertRejects(
    () =>
      waitUntil(() => {
        polls++;
        return pending({ health: "connection refused" });
      }, {
        label: "server healthy",
        intervalMs: 1,
        children: [{
          pid: 42,
          status: () => polls >= 2 ? { code: 1, signal: null } : null,
          logs: () => ({ stdout: "", stderr: "database is locked" }),
        }],
      }),
    ReadinessError,
  );
  assert(error.message.includes("child exited (pid 42, exit code 1)"));
  assert(error.message.includes("database is locked"));
  assert(error.message.includes("connection refused"));
});

Deno.test("readiness wait: the single bound reports the last observed state", async () => {
  const realNow = Date.now;
  let polls = 0;
  try {
    const error = await assertRejects(
      () =>
        waitUntil(() => {
          // Simulate the bound elapsing after the second observation.
          if (++polls === 2) {
            const shifted = realNow() + READINESS_MS;
            Date.now = () => shifted;
          }
          return pending({ status: "starting", polls });
        }, { label: "plugin 'slow' ready", intervalMs: 1 }),
      ReadinessError,
    );
    assert(error.message.startsWith("plugin 'slow' ready: readiness bound"));
    assert(error.message.includes('{"status":"starting","polls":2}'));
    assertEquals(polls, 2);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("readiness wait: the bound outlasts the product's own activation deadline", () => {
  // The product, not the harness, decides whether a plugin activates.
  assert(READINESS_MS > PLUGIN_LIMITS.activationMs);
});
