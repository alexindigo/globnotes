// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import {
  captureSettledWork,
  captureWork,
  type CatalogPlugin,
  catalogPluginReady,
  CatalogWorkFailure,
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

Deno.test("catalogue work: a settled fence cannot supply a baseline while newer selected work is pending", () => {
  const current = plugin();
  const fence = captureWork(current, ["versioning"]);
  Object.assign(current.work!.versioning, { admitted: 3, settled: 2 });
  assertEquals(workFenceSettled(current, fence), true);
  assertThrows(
    () => captureSettledWork(current, ["versioning"]),
    Error,
    "plugin 'test' versioning work still pending at baseline",
  );
  Object.assign(current.work!.versioning, { settled: 3, pending: 0 });
  assertEquals(captureSettledWork(current, ["versioning"]), {
    generation: "original",
    deliveryFailures: 0,
    lanes: { versioning: { admitted: 3, failures: 0 } },
  });
});

Deno.test("catalogue work: a versioning failure waits for the captured ordinary cohort", () => {
  const current = plugin(),
    baseline = captureWork(current, ["ordinary", "versioning"]),
    fence = captureWork(current, ["ordinary", "versioning"]);
  current.work!.versioning.settled = 2;
  current.work!.versioning.pending = 0;
  current.work!.versioning.failures = 1;
  current.deliveryFailures = 1;
  assertEquals(workFenceSettled(current, fence, baseline), false);
  current.work!.ordinary.settled = 2;
  current.work!.ordinary.pending = 0;
  assertThrows(
    () => workFenceSettled(current, fence, baseline),
    Error,
    "work failed",
  );
});

Deno.test("catalogue work: withheld event headers observe the admission signal", async () => {
  const entered = Promise.withResolvers<void>(),
    headers = Promise.withResolvers<void>();
  const controller = new AbortController();
  const server = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen() {} },
    async () => {
      entered.resolve();
      await headers.promise;
      return new Response("event: hello\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const result = observeCatalog({
    baseUrl: `http://${
      Deno.env.get("GLOBNOTES_TEST_HOST")
    }:${server.addr.port}`,
  }, { signal: controller.signal } as Parameters<typeof observeCatalog>[1])
    .then(async (observer) => {
      await observer.close();
      return false;
    }, () => true);
  try {
    await entered.promise;
    controller.abort(Error("admission expired with headers withheld"));
    headers.resolve();
    assertEquals(
      await result,
      true,
      "withheld event establishment must reject on the admission signal",
    );
  } finally {
    headers.resolve();
    await result;
    await server.shutdown();
  }
});

Deno.test("catalogue work: owner exit aborts withheld event headers without waiting for admission expiry", async () => {
  const entered = Promise.withResolvers<void>(),
    headers = Promise.withResolvers<void>();
  const owner = Promise.withResolvers<{ code: number }>();
  const server = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen() {} },
    async () => {
      entered.resolve();
      await headers.promise;
      return new Response("event: hello\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const result = assertRejects(
    () =>
      observeCatalog({
        baseUrl: `http://${
          Deno.env.get("GLOBNOTES_TEST_HOST")
        }:${server.addr.port}`,
        exited: owner.promise,
      }),
    Error,
    "catalog server exited: 17",
  );
  try {
    await entered.promise;
    owner.resolve({ code: 17 });
    await result;
  } finally {
    headers.resolve();
    await result;
    await server.shutdown();
  }
});

Deno.test("catalogue work: admission itself bounds withheld event headers and closes the request", async () => {
  const headers = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen() {} },
    async () => {
      await headers.promise;
      return new Response("event: hello\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  try {
    await assertRejects(
      () =>
        catalogPluginReady({
          baseUrl: `http://${
            Deno.env.get("GLOBNOTES_TEST_HOST")
          }:${server.addr.port}`,
        }, "withheld"),
      Error,
      "plugin 'withheld' catalogue admission: readiness bound exceeded",
    );
  } finally {
    headers.resolve();
    await server.shutdown();
  }
});

Deno.test("catalogue work: HTTP reports the failure from the terminal selected snapshot", async () => {
  const current = plugin(),
    baseline = captureWork(current, ["ordinary", "versioning"]);
  current.work!.versioning.settled = 2;
  current.work!.versioning.pending = 0;
  current.work!.versioning.failures = 1;
  current.work!.versioning.lastFailure = {
    sequence: 2,
    code: "plugin_work_failed",
  };
  current.deliveryFailures = 1;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const server = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen() {} },
    (request) => {
      if (new URL(request.url).pathname.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: hello\ndata: {}\n\n"));
            },
            cancel() {
              stream = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const snapshot = structuredClone(current);
      if (current.work!.ordinary.pending) {
        current.work!.ordinary.settled = 2;
        current.work!.ordinary.pending = 0;
        stream?.enqueue(encoder.encode("event: invalidate\ndata: {}\n\n"));
      }
      return Response.json({ plugins: [snapshot] });
    },
  );
  try {
    const error = await assertRejects(
      () =>
        catalogWorkSettled(
          {
            baseUrl: `http://${
              Deno.env.get("GLOBNOTES_TEST_HOST")
            }:${server.addr.port}`,
          },
          "test",
          { lanes: ["ordinary", "versioning"], baseline },
        ),
      CatalogWorkFailure,
    );
    assertEquals(error.plugin.work!.generation, baseline.generation);
    assertEquals(error.plugin.work!.ordinary.pending, 0);
    assertEquals(error.plugin.work!.ordinary.settled, 2);
    assertEquals(
      error.plugin.work!.versioning.lastFailure?.code,
      "plugin_work_failed",
    );
  } finally {
    await server.shutdown();
  }
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
