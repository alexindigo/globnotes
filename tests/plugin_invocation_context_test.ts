// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { PluginHost, type RpcAuthority } from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";

function deferred<T>() {
  return Promise.withResolvers<T>();
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("context consumer deadline")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

Deno.test("plugin context: independent managed timer cannot borrow an active pre invocation", async () => {
  const fixture = await pluginFixture();
  const guardEntered = deferred<void>(),
    backgroundEntered = deferred<void>(),
    releaseGuard = deferred<void>();
  const observations: { method: string; pre: boolean; parent?: string }[] = [];
  const dir = await fixture.install("context", {
    runtime: { server: "service.js" },
    hooks: ["pre-save"],
  }, {
    "service.js": `export function activate(ctx) {
      ctx.commands.register({id:'arm',label:'Arm',target:'server'},()=>{ctx.timers.setTimeout(async()=>{await ctx.readNote('background-gate'); await ctx.actions.request('create',{path:'timer',content:'x'});},0);});
      ctx.hooks.on('pre-save', async()=>{await ctx.readNote('guard-gate'); await Promise.resolve(); try{ctx.actions.request('create',{path:'forbidden'});return 'incorrect';}catch{return 'pre-rejected';}});
    }`,
  });
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    async (method, args, authority) => {
      observations.push({
        method: method === "readNote" ? String(args[0]) : method,
        pre: authority!.pre,
        parent: authority!.causal?.parentId,
      });
      if (args[0] === "background-gate") {
        await guardEntered.promise;
        return null;
      }
      if (args[0] === "guard-gate") {
        guardEntered.resolve();
        await releaseGuard.promise;
        return null;
      }
      if (method === "actions.request") {
        backgroundEntered.resolve();
        return { requestId: "timer" };
      }
      return null;
    },
    1,
    { role: "service" },
  );
  try {
    await host.start();
    const arm = [...host.registrations].find(([, value]) =>
      value.id === "arm"
    )![0];
    const guard = [...host.registrations].find(([, value]) =>
      value.id === "pre-save"
    )![0];
    await host.invoke(arm, [{}]);
    const guarded = host.invoke(
      guard,
      [{
        operationId: "guard-op",
        causalDepth: 4,
      }],
      true,
      host.limits.preHookMs,
      { causal: { parentId: "guard-op", depth: 4 } },
    );
    guarded.catch(() => undefined);
    await bounded(guardEntered.promise);
    await bounded(backgroundEntered.promise);
    const request = observations.find((value) =>
      value.method === "actions.request"
    );
    assertEquals(request, {
      method: "actions.request",
      pre: false,
      parent: undefined,
    });
    assertEquals(observations.find((value) => value.method === "guard-gate"), {
      method: "guard-gate",
      pre: true,
      parent: "guard-op",
    });
    releaseGuard.resolve();
    assertEquals(await guarded, "pre-rejected");
  } finally {
    releaseGuard.resolve();
    host.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin context: command arguments cannot inject causal metadata and release waits for actual settlement", async () => {
  const fixture = await pluginFixture(),
    accepted = deferred<RpcAuthority>(),
    finish = deferred<void>();
  const dir = await fixture.install("context", {
    runtime: { server: "service.js" },
  }, {
    "service.js":
      `export function activate(ctx){ctx.commands.register({id:'hold',label:'Hold',target:'server'},async()=>{await ctx.actions.request('create',{path:'created'});await ctx.readNote('finish');});}`,
  });
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    async (method, _, authority) => {
      if (method === "actions.request") {
        accepted.resolve(authority!);
        return { requestId: "accepted" };
      }
      await finish.promise;
      return null;
    },
    1,
    { role: "service" },
  );
  try {
    await host.start();
    const handler = [...host.registrations.keys()][0];
    const running = host.invoke(handler, [{
      operationId: "forged",
      causalDepth: 900,
    }]);
    running.catch(() => undefined);
    const authority = await bounded(accepted.promise);
    assertEquals(authority.causal, { parentId: undefined, depth: 0 });
    const release =
      (authority as RpcAuthority & { release?: Promise<{ status: string }> })
        .release;
    assert(release, "originating invocation release barrier is missing");
    let released = false;
    release.then(() => {
      released = true;
    });
    await Promise.resolve();
    assertEquals(released, false);
    finish.resolve();
    await running;
    assertEquals(await release, { status: "settled" });
  } finally {
    finish.resolve();
    host.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin context: ordinary error releases admitted work but timeout aborts its release", async () => {
  for (const ending of ["error", "timeout"] as const) {
    const fixture = await pluginFixture(), accepted = deferred<RpcAuthority>();
    const dir = await fixture.install("ending", {
      runtime: { server: "service.js" },
    }, {
      "service.js":
        `export function activate(ctx){ctx.commands.register({id:'ending',label:'Ending',target:'server'},async()=>{await ctx.actions.request('create',{path:'admitted'});${
          ending === "error"
            ? "throw Error('ordinary');"
            : "await new Promise(()=>{});"
        }});}`,
    });
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      (_, __, authority) => {
        accepted.resolve(authority!);
        return Promise.resolve({ requestId: "admitted" });
      },
      1,
      { role: "service", limits: { serviceCallMs: 100 } },
    );
    try {
      await host.start();
      const running = host.invoke([...host.registrations.keys()][0], []).catch(
        (error) => error,
      );
      const authority = await bounded(accepted.promise);
      assert(await running instanceof Error);
      assertEquals(await authority.release, {
        status: ending === "error" ? "settled" : "aborted",
      });
      assertEquals(authority.current(), false);
      assertEquals(authority.generationCurrent(), ending === "error");
    } finally {
      host.stop();
      await fixture.dispose();
    }
  }
});

Deno.test("plugin context: detached native timer cannot borrow generation after its invocation closes", async () => {
  const fixture = await pluginFixture(), failure = deferred<void>();
  let accepted = 0;
  const dir = await fixture.install("detached", {
    runtime: { server: "service.js" },
  }, {
    "service.js": `let outcome='pending'; export function activate(ctx){
      ctx.commands.register({id:'detach',label:'Detach',target:'server'},()=>{setTimeout(async()=>{try{await ctx.actions.request('create',{path:'forbidden'});outcome='accepted';}catch{outcome='closed';}},0);});
      ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>outcome);
    }`,
  });
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    () => {
      accepted++;
      failure.resolve();
      return Promise.resolve(null);
    },
    1,
    { role: "service" },
  );
  try {
    await host.start();
    const handler = (id: string) =>
      [...host.registrations].find(([, value]) => value.id === id)![0];
    await host.invoke(handler("detach"), []);
    let outcome;
    const end = Date.now() + 2000;
    do {
      outcome = await host.invoke(handler("inspect"), []);
      if (Date.now() > end) throw new Error("detached continuation deadline");
    } while (outcome === "pending");
    assertEquals(outcome, "closed");
    assertEquals(accepted, 0);
  } finally {
    host.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin context: missing unknown closed cross-slot and old-generation references never reach the host consumer", async () => {
  const fixture = await pluginFixture();
  const entered = deferred<{ contextId: string; generation: string }>();
  const finish = deferred<void>();
  const calls: { owner: string; generation: string; pre: boolean }[] = [];
  // Raw envelopes are deliberate protocol tests, not a public SDK or a claim
  // of cryptographic call-stack isolation inside a shared Worker.
  const service = `let incoming,sequence=100000,pending=new Map();
    addEventListener('message',({data})=>{if(data.type==='invoke')incoming=data;if(data.type==='rpcResponse'&&pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}});
    export function activate(ctx){
      ctx.commands.register({id:'context',label:'Context',target:'server'},async()=>{await Promise.resolve();return {contextId:incoming.context.id,generation:incoming.generation};});
      ctx.commands.register({id:'hold',label:'Hold',target:'server'},async()=>{await Promise.resolve();return ctx.readNote(JSON.stringify({contextId:incoming.context.id,generation:incoming.generation}));});
      ctx.commands.register({id:'forge',label:'Forge',target:'server'},async args=>{await Promise.resolve();const current=incoming;
        if(args.oldGeneration)postMessage({type:'rpc',id:++sequence,generation:args.oldGeneration,contextId:current.context.id,method:'probe',args:[],pre:false});
        const id=++sequence,result=new Promise(resolve=>pending.set(id,resolve));
        const envelope={type:'rpc',id,generation:current.generation,contextId:args.mode==='missing'?undefined:args.contextId??current.context.id,method:'probe',args:[],pre:false};
        postMessage(envelope);return result;
      });
    }`;
  const hosts: PluginHost[] = [];
  try {
    for (const owner of ["a", "b"]) {
      const dir = await fixture.install(owner, {
        runtime: { server: "service.js" },
      }, { "service.js": service });
      const host = new PluginHost(
        readManifest(dir),
        fixture.vault,
        async (method, args, authority) => {
          if (method === "readNote") {
            entered.resolve(JSON.parse(String(args[0])));
            await finish.promise;
            return "released";
          }
          calls.push({
            owner,
            generation: authority!.generation,
            pre: authority!.pre,
          });
          return `${owner}-owner-consumer`;
        },
        1,
        { role: "service" },
      );
      hosts.push(host);
      await host.start();
    }
    const handler = (host: PluginHost, id: string) =>
      [...host.registrations].find(([, item]) => item.id === id)![0];
    const [a, b] = hosts;
    const holding = a.invoke(handler(a, "hold"), []);
    holding.catch(() => undefined);
    const foreign = await bounded(entered.promise);
    const closed = await b.invoke(handler(b, "context"), []) as {
      contextId: string;
      generation: string;
    };
    for (
      const input of [{ mode: "missing" }, { contextId: "unknown-context" }, {
        contextId: closed.contextId,
      }, { contextId: foreign.contextId }]
    ) {
      const result = await b.invoke(handler(b, "forge"), [input]) as {
        ok: boolean;
        value: string;
      };
      assertEquals(result.ok, false);
      assert(result.value.includes("context"));
      assertEquals(calls, []);
    }
    const originalGeneration = b.generation!;
    await b.respawnAll();
    assert(b.generation !== originalGeneration);
    const stale = await b.invoke(handler(b, "forge"), [{
      oldGeneration: originalGeneration,
      contextId: "unknown-context",
    }]) as { ok: boolean };
    assertEquals(stale.ok, false);
    assertEquals(calls, []);
    const allowed = await b.invoke(handler(b, "forge"), [{}]) as {
      ok: boolean;
      value: string;
      generation: string;
    };
    assertEquals({
      ok: allowed.ok,
      value: allowed.value,
      generation: allowed.generation,
    }, { ok: true, value: "b-owner-consumer", generation: b.generation });
    assertEquals(calls, [{
      owner: "b",
      generation: b.generation!,
      pre: false,
    }]);
    finish.resolve();
    assertEquals(await holding, "released");
    console.log(
      JSON.stringify({
        invalidReferences: 5,
        hostConsumerCalls: calls,
        foreignSlotRejected: true,
        closedScopeRejected: true,
      }),
    );
  } finally {
    finish.resolve();
    hosts.forEach((host) => host.stop());
    await fixture.dispose();
  }
});
