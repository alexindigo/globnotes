// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import {
  captureWork,
  type CatalogPlugin,
  catalogPluginReady,
  catalogWorkSettled,
  observeCatalog,
  workFenceSettled,
} from "./helpers/catalog_work.ts";

function plugin(): CatalogPlugin {
  const lane = () => ({
    admitted: 2,
    settled: 1,
    pending: 1,
    failures: 0,
    lastFailure: null,
  });
  return {
    id: "test",
    status: "ready",
    deliveryFailures: 0,
    work: {
      generation: "original",
      startup: { state: "succeeded" },
      ordinary: lane(),
      versioning: lane(),
      guard: lane(),
    },
  };
}
Deno.test("catalogue work: a replacement never completes an old fence, even with equal counters", () => {
  const current = plugin(), fence = captureWork(current);
  current.work!.generation = "replacement";
  for (const lane of ["ordinary", "versioning", "guard"] as const) {
    current.work![lane].settled = 2;
  }
  assertThrows(
    () => workFenceSettled(current, fence),
    Error,
    "owner replaced or retired",
  );
  assertThrows(
    () => workFenceSettled(undefined, fence),
    Error,
    "owner replaced or retired",
  );
});
Deno.test("catalogue work: later admissions cannot extend a fence or hide intervening failures", () => {
  const current = plugin(),
    baseline = captureWork(current),
    fence = captureWork(current, ["versioning"]);
  current.work!.versioning.admitted = 3;
  current.work!.versioning.settled = 2;
  assert(workFenceSettled(current, fence, baseline));
  current.work!.versioning.failures = 1;
  assertThrows(
    () => workFenceSettled(current, fence, baseline),
    Error,
    "work failed",
  );
  current.work!.versioning.failures = 0;
  current.deliveryFailures++;
  assertThrows(
    () => workFenceSettled(current, fence, baseline),
    Error,
    "work failed",
  );
});

Deno.test("catalogue work: real HTTP invalidation settles admitted work without polling private status", async () => {
  const fixture = await pluginFixture();
  await fixture.install("http-work", {
    runtime: { server: "service.js" },
    versioning: { extensions: [".md"] },
  }, {
    "service.js": `let release;
      export function activate(ctx){
        ctx.versioning.onOffer(()=>new Promise(resolve=>release=resolve));
        ctx.commands.register({id:'release',label:'Release',target:'server'},()=>release?.());
      }`,
  });
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES__METADATA_PATH: fixture.metadataBase,
    fixtureAuth: { auth_type: "none" },
  });
  let observer: Awaited<ReturnType<typeof observeCatalog>> | undefined;
  try {
    const initial = await catalogPluginReady(server, "http-work"),
      baseline = captureWork(initial);
    await Deno.writeTextFile(`${fixture.vault}/Note.md`, "old");
    const read = await (await fetch(`${server.baseUrl}/_/api/notes/Note`))
      .json();
    const save = await fetch(`${server.baseUrl}/_/api/notes/Note`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        newContent: "new",
        base: { kind: "version", version: read.version },
      }),
    });
    assertEquals(save.status, 200);
    await save.body?.cancel();
    observer = await observeCatalog(server);
    const before = (await observer.read()).find((item) =>
      item.id === "http-work"
    )!;
    assertEquals(before.work!.versioning.pending, 1);
    const changed = observer.changed;
    const waiting = catalogWorkSettled(server, "http-work", {
      lanes: ["versioning"],
      baseline,
    });
    const release = await fetch(
      `${server.baseUrl}/_/api/plugin-host/http-work/commands/release`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assertEquals(release.status, 200);
    await release.body?.cancel();
    await changed;
    const settled = await waiting;
    assertEquals(settled.work!.versioning.settled, 1);
    assertEquals(await Deno.readTextFile(`${fixture.vault}/Note.md`), "new");
    const heldNote = await (await fetch(`${server.baseUrl}/_/api/notes/Note`))
      .json();
    const heldSave = await fetch(`${server.baseUrl}/_/api/notes/Note`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        newContent: "retired work",
        base: { kind: "version", version: heldNote.version },
      }),
    });
    assertEquals(heldSave.status, 200);
    await heldSave.body?.cancel();
    const held = (await observer.read()).find((item) =>
      item.id === "http-work"
    )!;
    const old = captureWork(held, ["versioning"]);
    assertEquals(held.work!.versioning.pending, 1);
    assertEquals(workFenceSettled(held, old), false);
    for (const enabled of [false, true]) {
      const catalog = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
      const response = await fetch(
        `${server.baseUrl}/_/api/plugin-host/http-work/enabled`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled,
            revision: catalog.policy.revision,
            signature: catalog.policy.signature,
          }),
        },
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
      if (!enabled) {
        assertEquals(
          (await observer.read()).find((item) => item.id === "http-work")!.work,
          null,
        );
      }
    }
    const fresh = await catalogPluginReady(server, "http-work");
    assert(fresh.work!.generation !== old.generation);
    assertEquals(fresh.work!.versioning.admitted, 0);
    let replacement = fresh;
    for (const value of ["replacement one", "replacement two"]) {
      const current = await (await fetch(`${server.baseUrl}/_/api/notes/Note`))
        .json();
      const replacingSave = await fetch(`${server.baseUrl}/_/api/notes/Note`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newContent: value,
          base: { kind: "version", version: current.version },
        }),
      });
      assertEquals(replacingSave.status, 200);
      await replacingSave.body?.cancel();
      const replacingRelease = await fetch(
        `${server.baseUrl}/_/api/plugin-host/http-work/commands/release`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      assertEquals(replacingRelease.status, 200);
      await replacingRelease.body?.cancel();
      replacement = await catalogWorkSettled(server, "http-work", {
        baseline: captureWork(fresh),
      });
    }
    assertEquals(
      replacement.work!.versioning.settled,
      old.lanes.versioning!.admitted,
    );
    assertThrows(
      () => workFenceSettled(replacement, old),
      Error,
      "owner replaced or retired",
    );
    await assertRejects(
      () =>
        catalogWorkSettled(server, "http-work", {
          baseline: old,
        }),
      Error,
      "owner replaced or retired",
    );
    assertEquals(old.generation, before.work!.generation);
  } finally {
    await observer?.close();
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("catalogue work: a hung service job fails through its real product deadline diagnostic", async () => {
  const fixture = await pluginFixture();
  await fixture.install("http-hung", { runtime: { server: "service.js" } }, {
    "service.js":
      `export function activate(ctx){ctx.jobs.afterActivation({id:'hang'},()=>new Promise(()=>{}));}`,
  });
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES__METADATA_PATH: fixture.metadataBase,
    fixtureAuth: { auth_type: "none" },
  });
  try {
    const initial = await catalogPluginReady(server, "http-hung");
    assertEquals(initial.work!.startup.state, "succeeded");
    assertEquals(initial.work!.ordinary.pending, 1);
    await assertRejects(
      () =>
        catalogWorkSettled(server, "http-hung", {
          baseline: captureWork(initial),
        }),
      Error,
      "plugin_work_deadline",
    );
  } finally {
    await server.close();
    await fixture.dispose();
  }
});
