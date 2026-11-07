// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { hubOperationsFixture } from "../helpers/hub_fixture.ts";
import { done, pending, waitUntil } from "../helpers/wait.ts";

Deno.test("conflict latency: outside deletion publishes closed metadata within 3 seconds", async () => {
  const f = hubOperationsFixture();
  let release = () => {};
  try {
    Deno.writeTextFileSync(`${f.vault}/original.md`, "original");
    Deno.writeTextFileSync(`${f.vault}/copy.md`, "copy");
    f.hub.recordConflict({
      id: "latency",
      path: "original.md",
      copyPath: "copy.md",
      peer: "globnotes",
      reason: "overlapping-edits",
      state: "open",
      createdAt: "2026-11-07T00:00:00Z",
      resolvedAt: null,
    });
    f.hub.start();
    const revision = f.hub.conflictRevision();
    let elapsedMs: number | null = null;
    const started = performance.now();
    release = f.hub.subscribeConflicts((next) => {
      if (next > revision && f.hub.conflict("latency")?.state === "resolved") {
        elapsedMs = performance.now() - started;
      }
    });
    Deno.removeSync(`${f.vault}/copy.md`);
    await waitUntil(
      () => elapsedMs === null ? pending({ revision }) : done(),
      { label: "watcher deletion reaches conflict metadata subscriber" },
    );
    console.log(
      JSON.stringify({ case: "outside-conflict-deletion", elapsedMs }),
    );
    assert(elapsedMs !== null && elapsedMs < 3000);
    assertEquals(f.hub.conflict("latency")?.state, "resolved");
    assertEquals(Deno.readTextFileSync(`${f.vault}/original.md`), "original");
  } finally {
    release();
    f.close();
  }
});
