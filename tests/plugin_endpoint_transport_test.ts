// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { PLUGIN_LIMITS } from "../server/plugins/contracts.ts";
import {
  normalizeEndpointResult,
  PluginEndpoints,
} from "../server/plugins/endpoints.ts";
import { proxyPluginEndpoint, readBodyBytes } from "../server/plugins/proxy.ts";
import type { PluginRuntime } from "../server/plugins/runtime.ts";
import { state } from "../server/state.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { bootServer } from "./helpers/boot.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { AsyncLock } from "../server/plugins/lifecycle.ts";

Deno.test("review repairs: R04 crossing unfinished body is rejected and cancelled before EOF", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new Uint8Array(PLUGIN_LIMITS.httpBytes + 1));
    },
    cancel() {
      cancelled++;
    },
  }, { highWaterMark: 0 });
  const reading = readBodyBytes({ body: { stream } }).then(
    (value) => ({ status: 200, bytes: value.byteLength }),
    (error) => ({
      status: error instanceof HttpError ? error.status : 500,
      bytes: 0,
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await Promise.race([
      reading,
      new Promise<{ status: number; bytes: number }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 0, bytes: 0 }), 100);
      }),
    ]);
    console.log(
      JSON.stringify({ bodyStillUnfinished: true, observed, cancelled }),
    );
    assertEquals(observed.status, 413);
    assertEquals(cancelled, 1);
  } finally {
    clearTimeout(timer);
    if (!cancelled) controller.close();
    await reading;
  }
});

Deno.test("review repairs: R04 unavailable endpoint never acquires a body reader", async () => {
  const old = state.pluginEndpoints;
  let acquisitions = 0;
  const runtime = {
    isEnabled: () => false,
    status: () => null,
    version: 0,
  } as unknown as PluginRuntime;
  state.pluginEndpoints = new PluginEndpoints(() => runtime);
  const request = {
    method: "POST",
    params: { id: "not-running" },
    query: new URLSearchParams(),
    headers: new Headers(),
    _raw: new Request("http://fixture/_/api/plugins/not-running", {
      method: "POST",
    }),
    body: {
      get stream() {
        acquisitions++;
        return null;
      },
    },
    bodyBytes: () => {
      acquisitions++;
      return Promise.resolve(new Uint8Array());
    },
  };
  try {
    const error = await assertRejects(
      () => proxyPluginEndpoint(request, ""),
      HttpError,
    );
    assertEquals(error.status, 404);
    assertEquals(acquisitions, 0);
  } finally {
    state.pluginEndpoints = old;
  }
});

Deno.test("review repairs: R21 plain JSON results obey the same UTF-8 response bound", () => {
  const exact = "x".repeat(PLUGIN_LIMITS.httpBytes - 2);
  assertEquals(
    normalizeEndpointResult(exact).body.byteLength,
    PLUGIN_LIMITS.httpBytes,
  );
  assertThrows(
    () =>
      normalizeEndpointResult({
        text: "é".repeat(PLUGIN_LIMITS.httpBytes / 2),
      }),
    Error,
    "bound",
  );
});

Deno.test("review repairs: R21 shaped string JSON null and byte responses share one encoded limit", () => {
  const bound = PLUGIN_LIMITS.httpBytes;
  assertEquals(
    normalizeEndpointResult({ body: "x".repeat(bound) }).body.byteLength,
    bound,
  );
  assertEquals(
    normalizeEndpointResult({ body: new Uint8Array(bound) }).body.byteLength,
    bound,
  );
  assertEquals(
    normalizeEndpointResult({ status: 204, body: null }).body.byteLength,
    0,
  );
  assertEquals(
    new TextDecoder().decode(normalizeEndpointResult(null).body),
    "null",
  );
  for (
    const response of [
      { body: "é".repeat(bound / 2 + 1) },
      { body: new Uint8Array(bound + 1) },
      { body: { text: "x".repeat(bound) } },
      ["x".repeat(bound)],
    ]
  ) assertThrows(() => normalizeEndpointResult(response), Error, "bound");
});

Deno.test("review repairs: R04 transformed bytes rather than original byte count determine acquisition bound", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  }).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(_chunk, controller) {
        controller.enqueue(new Uint8Array(PLUGIN_LIMITS.httpBytes + 1));
      },
    }),
  );
  const error = await assertRejects(
    () => readBodyBytes({ body: { stream } }),
    HttpError,
  );
  assertEquals(error.status, 413);
  assertEquals(stream.locked, false);
});

Deno.test("review repairs: R04 exact null tiny zero and view-backed chunks use bounded owned bytes", async () => {
  assertEquals(
    await readBodyBytes({ body: { stream: null } }),
    new Uint8Array(),
  );
  const exact = new Uint8Array(PLUGIN_LIMITS.httpBytes);
  exact[0] = 65;
  exact[exact.length - 1] = 90;
  const value = await readBodyBytes({
    body: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(exact);
          controller.close();
        },
      }),
    },
  });
  assertEquals(value.byteLength, exact.byteLength);
  assertEquals(value[0], 65);
  assertEquals(value[value.length - 1], 90);
  const backing = new Uint8Array(256 * 1024);
  backing.set([65, 66], 1024);
  const small = await readBodyBytes({
    body: {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array());
          for (let i = 0; i < 128; i++) {
            controller.enqueue(backing.subarray(1024, 1026));
          }
          controller.close();
        },
      }),
    },
  });
  backing.fill(0);
  assertEquals(small.byteLength, 256);
  assertEquals(small[0], 65);
  assertEquals(small[255], 66);
  console.log(
    JSON.stringify({
      exactBytes: value.byteLength,
      tinyBytes: small.byteLength,
      sourceBackingMutationDidNotChangeConsumer: true,
    }),
  );
});

Deno.test("review repairs: R04 acquisition deadline returns 408 despite never-settling cancellation", async () => {
  const original = globalThis.setTimeout;
  let scheduled = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  globalThis.setTimeout = new Proxy(original, {
    apply(target, self, args) {
      if (args[1] === 30_000) {
        scheduled++;
        args[1] = 1;
      }
      return Reflect.apply(target, self, args);
    },
  });
  try {
    const error = await assertRejects(
      () => readBodyBytes({ body: { stream } }),
      HttpError,
    );
    assertEquals(error.status, 408);
    assertEquals(scheduled, 1);
    assertEquals(cancelled, 1);
    assertEquals(stream.locked, false);
    console.log(
      JSON.stringify({
        requestedDeadlineMs: 30_000,
        actualStatus: error.status,
        cancellationWasNotAwaited: true,
        readerReleased: !stream.locked,
      }),
    );
  } finally {
    globalThis.setTimeout = original;
  }
});

Deno.test("review repairs: R04 abort and stream failure release the reader and do not acquire replacement bytes", async () => {
  for (const ending of ["abort", "error"] as const) {
    const controller = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>, cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        source = value;
        value.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    const reading = assertRejects(
      () =>
        readBodyBytes({
          body: { stream },
          _raw: new Request("http://fixture/body", {
            method: "POST",
            signal: controller.signal,
          }),
        }),
      HttpError,
    );
    if (ending === "abort") controller.abort();
    else source.error(Error("owned body stream failure"));
    const error = await reading;
    assertEquals(error.status, 400);
    assertEquals(stream.locked, false);
    if (ending === "abort") assertEquals(cancelled, 1);
  }
});

Deno.test("review repairs: R04 body wait admitted to A cannot invoke B reused endpoint identity", async () => {
  const fixture = await pluginFixture();
  const gate = new AsyncLock();
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    1,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/empty-internal`,
      persistence: { commit: (effect) => gate.run(effect) },
    },
  );
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: (effect) => gate.run(effect),
  });
  const old = state.pluginEndpoints;
  const reached = Promise.withResolvers<void>();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(new Uint8Array([1]));
    },
  }, { highWaterMark: 0 });
  let pending: Promise<Response | HttpError> | undefined;
  const ready = async () => {
    const deadline = Date.now() + 3000;
    while (runtime.status("transport")?.status !== "ready") {
      if (
        runtime.status("transport")?.status === "failed" ||
        Date.now() > deadline
      ) {
        throw Error(
          `body-race fixture activation failed ${
            JSON.stringify(runtime.status("transport"))
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const code = (label: string) =>
      `export default async(req,ctx)=>{const data=await ctx.data.load();await ctx.data.save({owner:'${label}'},data.revision);return{owner:'${label}'}}`;
    const dir = await fixture.install("transport", {
      runtime: { server: "service.js" },
    }, {
      "service.js": "export function activate(){}",
      "endpoints/post.js": code("A"),
    });
    await runtime.reconcile();
    await ready();
    const a = runtime.status("transport")!.generation;
    state.pluginEndpoints = new PluginEndpoints(() => runtime);
    const request = {
      method: "POST",
      params: { id: "transport" },
      headers: new Headers(),
      query: new URLSearchParams(),
      _raw: new Request("http://fixture/_/api/plugins/transport", {
        method: "POST",
      }),
      body: {
        get stream() {
          reached.resolve();
          return stream;
        },
      },
      bodyBytes: (): Promise<Uint8Array> => readBodyBytes(request),
    };
    pending = proxyPluginEndpoint(request, "").catch((error) =>
      error as HttpError
    );
    await reached.promise;
    await manager.policy.setEnabled(
      "transport",
      false,
      (await manager.policy.read()).metadata,
    );
    await manager.reconcileOwners();
    await Deno.writeTextFile(`${dir}/endpoints/post.js`, code("B"));
    await manager.policy.setEnabled(
      "transport",
      true,
      (await manager.policy.read()).metadata,
    );
    await manager.reconcileOwners({ replaceId: "transport" });
    await ready();
    const b = runtime.status("transport")!.generation;
    assert(a !== b);
    source.close();
    const result = await pending;
    if (result instanceof Response) await result.body?.cancel();
    assert(result instanceof HttpError);
    assertEquals(result.status, 404);
    const data = new PluginDataStore(fixture.statePath, {
      commit: (effect) => gate.run(effect),
    }).forPlugin("transport");
    assertEquals((await data.load()).revision, 0);
    const fresh = await proxyPluginEndpoint({
      ...request,
      body: { stream: null },
    }, "");
    assertEquals(fresh.status, 200);
    assertEquals(await fresh.json(), { owner: "B" });
    assertEquals((await data.load()).values.owner, "B");
    console.log(
      JSON.stringify({ a, b, staleBodyInvokedB: false, freshBConsumer: "B" }),
    );
  } finally {
    if (stream.locked) {
      try {
        source.close();
      } catch { /* already closed */ }
    }
    if (pending) await pending.catch(() => undefined);
    state.pluginEndpoints = old;
    manager.stop();
    await runtime.close();
    console.log(
      JSON.stringify({ retainedEndpointBodyRaceFixture: fixture.root }),
    );
  }
});

async function endpointFixture(prefix = "", invalid?: "grammar" | "shape") {
  const fixture = await pluginFixture();
  const common = {
    "service.js":
      "export function activate(ctx){ctx.commands.register({id:'calls',label:'Calls',target:'server'},async()=>await ctx.data.load())}",
    "endpoints/item/#name/get.js":
      "export default req=>({value:req.params.name,path:req.path,query:req.query})",
    "endpoints/shared/get.js":
      "export default async(req,ctx)=>{const data=await ctx.data.load();await ctx.data.save({calls:(data.values.calls??0)+1},data.revision);return{method:'GET'}}",
    "endpoints/shared/post.js":
      "export default async(req,ctx)=>{const data=await ctx.data.load();await ctx.data.save({calls:(data.values.calls??0)+1},data.revision);return{method:'POST'}}",
    "endpoints/shared/put.js":
      "export default async(req,ctx)=>{const data=await ctx.data.load();await ctx.data.save({calls:(data.values.calls??0)+1},data.revision);return{method:'PUT'}}",
    "endpoints/post-only/post.js": "export default()=>({method:'POST'})",
    "endpoints/huge/get.js":
      "export default()=>({text:'é'.repeat(8*1024*1024)})",
    "endpoints/exact/get.js": "export default()=>('x'.repeat(16*1024*1024-2))",
  };
  await fixture.install(
    "transport",
    {
      runtime: { server: "service.js" },
      ...(invalid ? { hooks: ["pre-save"] } : {}),
      capabilities: { network: false, imports: false },
    },
    invalid
      ? {
        "service.js":
          "export function activate(ctx){ctx.hooks.on('pre-save',()=>{});ctx.commands.register({id:'calls',label:'Calls',target:'server'},async()=>await ctx.data.load())}",
        "endpoints/item/#name/get.js": common["endpoints/item/#name/get.js"],
        ...(invalid === "grammar"
          ? {
            "endpoints/bad/#(unknown)value/get.js":
              "export default()=>({bad:true})",
          }
          : {
            "endpoints/item/#other/get.js":
              "export default()=>({duplicate:true})",
          }),
      }
      : common,
  );
  await fixture.install("transport-unrelated", {
    runtime: { server: "service.js" },
  }, {
    "service.js":
      "export function activate(ctx){ctx.commands.register({id:'alive',label:'Alive',target:'server'},()=>({alive:true}))}",
    "endpoints/get.js": "export default()=>({alive:true})",
  });
  const server = await bootServer({
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_PATH_PREFIX: prefix,
  });
  const base = `${server.baseUrl}${prefix}`;
  let current: { status: string; diagnostics: unknown[] } | undefined;
  const until = Date.now() + 5000;
  for (;;) {
    const catalog = await (await fetch(`${base}/_/api/plugin-host`)).json();
    current = catalog.plugins.find((plugin: { id: string }) =>
      plugin.id === "transport"
    );
    const unrelated = catalog.plugins.find((plugin: { id: string }) =>
      plugin.id === "transport-unrelated"
    );
    if (
      ["ready", "failed"].includes(current?.status ?? "") &&
      unrelated?.status === "ready"
    ) break;
    if (Date.now() > until) {
      throw Error(
        `endpoint fixture did not settle: ${JSON.stringify(current)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    fixture,
    server,
    base,
    current: current!,
    async close() {
      await server.close();
      console.log(
        JSON.stringify({ retainedEndpointTransportFixture: fixture.root }),
      );
    },
  };
}

for (const prefix of ["", "/notes"]) {
  Deno.test(`review repairs: R20 encoded captures are decoded once under prefix '${prefix}'`, async () => {
    const b = await endpointFixture(prefix);
    try {
      assertEquals(b.current.status, "ready");
      for (
        const [encoded, decoded] of [
          ["literal%2525", "literal%25"],
          ["question%3Fmark", "question?mark"],
          ["fragment%23mark", "fragment#mark"],
          ["one%2Ftwo", "one/two"],
        ]
      ) {
        const response = await fetch(
          `${b.base}/_/api/plugins/transport/item/${encoded}?x=1&x=2`,
        );
        assertEquals(response.status, 200);
        const value = await response.json();
        console.log(
          JSON.stringify({
            prefix,
            encoded,
            expectedCapture: decoded,
            actualCapture: value.value,
          }),
        );
        assertEquals(value.value, decoded);
        assertEquals(value.query, [["x", "1"], ["x", "2"]]);
      }
    } finally {
      await b.close();
    }
  });
}

Deno.test("review repairs: R27 OPTIONS advertises full method union and synthetic HEAD only with GET", async () => {
  const b = await endpointFixture();
  try {
    const shared = await fetch(`${b.base}/_/api/plugins/transport/shared`, {
      method: "OPTIONS",
    });
    assertEquals(shared.status, 204);
    assertEquals(shared.headers.get("allow"), "GET, HEAD, OPTIONS, POST, PUT");
    await shared.body?.cancel();
    const only = await fetch(`${b.base}/_/api/plugins/transport/post-only`, {
      method: "OPTIONS",
    });
    assertEquals(only.status, 204);
    assertEquals(only.headers.get("allow"), "OPTIONS, POST");
    await only.body?.cancel();
    const wrong = await fetch(`${b.base}/_/api/plugins/transport/shared`, {
      method: "DELETE",
    });
    assertEquals(wrong.status, 405);
    assertEquals(wrong.headers.get("allow"), "GET, HEAD, OPTIONS, POST, PUT");
    await wrong.body?.cancel();
    const head = await fetch(`${b.base}/_/api/plugins/transport/shared`, {
      method: "HEAD",
    });
    assertEquals(head.status, 200);
    assertEquals((await head.arrayBuffer()).byteLength, 0);
    const calls = await fetch(
      `${b.base}/_/api/plugin-host/transport/commands/calls`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assertEquals(calls.status, 200);
    assertEquals((await calls.json()).result.values, {});
  } finally {
    await b.close();
  }
});

Deno.test("review repairs: R21 oversized plain HTTP JSON cannot produce success while exact response reaches consumer", async () => {
  const b = await endpointFixture();
  try {
    const oversized = await fetch(`${b.base}/_/api/plugins/transport/huge`);
    assertEquals(oversized.status, 404);
    await oversized.body?.cancel();
    const exact = await fetch(`${b.base}/_/api/plugins/transport/exact`);
    assertEquals(exact.status, 200);
    const bytes = new Uint8Array(await exact.arrayBuffer());
    assertEquals(bytes.byteLength, PLUGIN_LIMITS.httpBytes);
    assertEquals(bytes[0], 34);
    assertEquals(bytes[bytes.length - 1], 34);
    console.log(
      JSON.stringify({
        oversizedStatus: oversized.status,
        exactConsumerBytes: bytes.byteLength,
      }),
    );
  } finally {
    await b.close();
  }
});

for (const invalid of ["grammar", "shape"] as const) {
  Deno.test(`review repairs: R24 invalid ${invalid} endpoint table fails activation before ready`, async () => {
    const b = await endpointFixture("", invalid);
    try {
      console.log(JSON.stringify({ invalid, actualActivation: b.current }));
      assertEquals(b.current.status, "failed");
      const unrelated = await fetch(
        `${b.base}/_/api/plugins/transport-unrelated`,
      );
      assertEquals(unrelated.status, 200);
      assertEquals(await unrelated.json(), { alive: true });
      const route = await fetch(`${b.base}/_/api/plugins/transport/item/x`);
      assertEquals(route.status, 404);
      await route.body?.cancel();
      await Deno.writeTextFile(
        `${b.fixture.vault}/guarded.md`,
        "retained guard consumer",
      );
      const save = await fetch(`${b.base}/_/api/notes/guarded`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newContent: "must not pass failed required guard",
        }),
      });
      assertEquals(save.status, 503);
      assertEquals((await save.json()).code, "plugin_guard_failed");
      assertEquals(
        await Deno.readTextFile(`${b.fixture.vault}/guarded.md`),
        "retained guard consumer",
      );
    } finally {
      await b.close();
    }
  });
}
