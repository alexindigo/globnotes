// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  PluginHost,
  type RpcAuthority,
  type RpcHandler,
} from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import type { WorkerMessage } from "../server/plugins/contracts.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import {
  bounded,
  LivenessClock,
  until,
  WorkerDeliveryGate,
} from "./helpers/worker_liveness.ts";

// Baseline-compatible: unchanged HostOptions and real native activation/watchdog timers.
Deno.test("startup liveness: native ready-before-heartbeat beyond1000ms", async () => {
  const fixture = await pluginFixture();
  await Deno.writeTextFile(
    `${fixture.vault}/sentinel.txt`,
    "same-owner-file-consumer",
  );
  const dir = await fixture.install("native-liveness", {
    runtime: { server: "service.js" },
  }, {
    "service.js":
      `let initial;const nonce=crypto.randomUUID();export async function activate(ctx){initial=await ctx.settings.read();ctx.commands.register({id:'consume',label:'Consume',target:'server'},async()=>({nonce,initial,file:await ctx.readFile('sentinel.txt')}));}`,
  });
  const gate = new WorkerDeliveryGate();
  const failures: string[] = [];
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    async (method) => {
      if (method === "settings.read") return "real-initial-rpc";
      if (method === "readFile") {
        return await Deno.readTextFile(
          `${fixture.vault}/sentinel.txt`,
        );
      }
      throw Error(`unexpected RPC ${method}`);
    },
    1,
    {
      role: "service",
      failed: (detail) => {
        failures.push(detail);
      },
    },
  );
  let startState = "pending";
  const started = host.start().then(() => {
    startState = "ready";
  }, (error) => {
    startState = "failed";
    throw error;
  });
  started.catch(() => undefined);
  try {
    await bounded(gate.ready.promise, "actual initialized ready");
    const generation = host.generation;
    const origin = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await bounded(gate.heartbeat.promise, "real held heartbeat");
    console.log(JSON.stringify({
      nativeProtocolReady: true,
      heldHeartbeats: gate.workers[0].held.length,
      elapsedAfterReadyMs: performance.now() - origin,
      startState,
      available: host.available,
      failures,
      generation,
      retainedFixture: fixture.root,
    }));
    assertEquals(
      startState,
      "pending",
      "initialized ready must not publish readiness without an accepted heartbeat",
    );
    assertEquals(host.available, false);
    assertEquals(
      failures,
      [],
      "unqualified Worker must retain its original startup budget",
    );
    gate.holdHeartbeat = false;
    gate.releaseHeartbeat();
    await bounded(started, "combined readiness");
    assert(host.available);
    assertEquals(host.generation, generation);
    const handler = [...host.registrations.keys()][0];
    const consumed = await host.invoke(handler, []) as {
      nonce: string;
      initial: string;
      file: string;
    };
    assertEquals(consumed.initial, "real-initial-rpc");
    assertEquals(consumed.file, "same-owner-file-consumer");
    assert(consumed.nonce);
  } finally {
    host.stop();
    await started.catch(() => undefined);
    gate.restore();
    console.log(JSON.stringify({ retainedLivenessFixture: fixture.root }));
  }
});

const serviceConsumer =
  `let initial='initialized';const nonce=crypto.randomUUID();export async function activate(ctx){ctx.commands.register({id:'consume',label:'Consume',target:'server'},()=>({nonce,initial}));}`;
const renderConsumer =
  `const nonce=crypto.randomUUID();let sentinel;export function getSelectors(){return[{node:'fence',language:'liveness'}]}export async function onSync(ctx){sentinel=await ctx.readNote('initial')}export function parseNode(){return{nonce,sentinel}}`;
async function controlled(
  source = serviceConsumer,
  role: "render" | "service" = "service",
  count = 1,
  rpc: RpcHandler = () => Promise.resolve("synchronized-sentinel"),
) {
  const fixture = await pluginFixture();
  const dir = await fixture.install(
    "controlled-liveness",
    role === "service" ? { runtime: { server: "service.js" } } : {},
    { [role === "service" ? "service.js" : "main.js"]: source },
  );
  const clock = new LivenessClock(), gate = new WorkerDeliveryGate();
  const failures: string[] = [];
  const host = new PluginHost(readManifest(dir), fixture.vault, rpc, count, {
    role,
    liveness: clock,
    failed: (detail) => {
      failures.push(detail);
    },
  });
  let state = "pending";
  const started = host.start().then(() => {
    state = "ready";
  }, (error) => {
    state = "failed";
    throw error;
  });
  started.catch(() => undefined);
  return {
    fixture,
    clock,
    gate,
    host,
    failures,
    started,
    state: () => state,
    async initialized() {
      await until(
        () =>
          gate.workers.length === count &&
          gate.workers.every((item) =>
            item.ready && (role === "service" || item.received.some((message) =>
              message.type === "result"
            ))
          ),
        "all actual initializations",
      );
      await Promise.resolve();
      assertEquals(
        clock.installed.filter((row) => row.kind === "activation").map((row) =>
          row.milliseconds
        ),
        Array(count).fill(10000),
      );
    },
    async heartbeats() {
      await until(
        () => gate.workers.every((item) => item.held.length > 0),
        "actual heartbeat for every owner",
      );
    },
    async close() {
      host.stop();
      await started.catch(() => undefined);
      gate.restore();
      assertEquals(clock.timeouts.size, 0);
      assertEquals(clock.intervals.size, 0);
      console.log(
        JSON.stringify({
          retainedLivenessFixture: fixture.root,
          schedulerInstalled: clock.installed,
          failures,
        }),
      );
    },
  };
}
async function consume(host: PluginHost) {
  const value = await host.invoke([...host.registrations.keys()][0], []) as {
    nonce: string;
    initial: string;
  };
  assertEquals(value.initial, "initialized");
  assert(value.nonce);
  return value;
}

Deno.test("startup liveness: installed watchdog ready-before-heartbeat beyond1000ms", async () => {
  const c = await controlled();
  try {
    await c.initialized();
    await c.heartbeats();
    const generation = c.host.generation;
    c.clock.tick(1000);
    assertEquals(c.state(), "pending");
    assertEquals(c.host.available, false);
    assertEquals(c.failures, []);
    c.gate.releaseHeartbeat();
    await bounded(c.started, "combined service readiness");
    assertEquals(c.host.generation, generation);
    assert(c.host.available);
    await consume(c.host);
  } finally {
    await c.close();
  }
});

Deno.test("startup liveness: heartbeat-before-initialization silence>750ms", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const c = await controlled(
    serviceConsumer.replace(
      "export async function activate(ctx){",
      "export async function activate(ctx){await ctx.readNote('hold');",
    ),
    "service",
    1,
    async () => {
      entered.resolve();
      await release.promise;
      return null;
    },
  );
  try {
    await bounded(entered.promise, "real initial RPC");
    await c.heartbeats();
    c.gate.releaseHeartbeat();
    c.clock.tick(1500);
    assertEquals(c.failures, []);
    assertEquals(c.state(), "pending");
    assertEquals(c.host.available, false);
    release.resolve();
    await bounded(c.started, "early heartbeat plus completed initialization");
    await consume(c.host);
    c.clock.tick(2250);
    assert(c.host.available);
    c.clock.tick(2251);
    assertEquals(c.host.available, false);
    assertEquals(c.failures, [
      "worker heartbeat timeout; in-flight outcome unknown",
    ]);
  } finally {
    release.resolve();
    await c.close();
  }
});

Deno.test("startup liveness: continued heartbeats cannot extend uninitialized startup", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let authority: RpcAuthority | undefined;
  const c = await controlled(
    `export async function activate(ctx){await ctx.readNote('hold')}`,
    "service",
    1,
    async (_, __, actor) => {
      authority = actor;
      entered.resolve();
      await release.promise;
      return null;
    },
  );
  try {
    await bounded(entered.promise, "unsettled activate");
    await c.heartbeats();
    c.gate.releaseHeartbeat();
    c.clock.tick(9999);
    assertEquals(c.state(), "pending");
    assertEquals(c.failures, []);
    await c.heartbeats();
    c.gate.releaseHeartbeat();
    c.clock.tick(10000, true);
    await assertRejects(() => c.started, Error, "activation deadline exceeded");
    assertEquals(c.failures, ["plugin activation deadline exceeded"]);
    assertEquals(await authority!.readiness, { status: "aborted" });
    release.resolve();
    assertEquals(c.host.available, false);
  } finally {
    release.resolve();
    await c.close();
  }
});

Deno.test("startup liveness: initialized ready with heartbeat delivery held fails at startup bound", async () => {
  const c = await controlled();
  try {
    await c.initialized();
    await c.heartbeats();
    c.clock.tick(9999);
    assertEquals(c.failures, []);
    assertEquals(c.state(), "pending");
    c.clock.tick(10000, true);
    await assertRejects(() => c.started, Error, "activation deadline exceeded");
    assertEquals(c.failures, ["plugin activation deadline exceeded"]);
    c.gate.releaseHeartbeat();
    assertEquals(c.host.available, false);
  } finally {
    await c.close();
  }
});

for (const second of ["heartbeat", "initialization"] as const) {
  Deno.test(`startup liveness: late ${second} rejected before delayed timer callback`, async () => {
    const release = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const c = await controlled(
      second === "initialization"
        ? serviceConsumer.replace(
          "export async function activate(ctx){",
          "export async function activate(ctx){await ctx.readNote('hold');",
        )
        : serviceConsumer,
      "service",
      1,
      async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    );
    try {
      if (second === "initialization") {
        await bounded(entered.promise, "held initialization");
        await c.heartbeats();
        c.gate.releaseHeartbeat();
      } else {
        await c.initialized();
        await c.heartbeats();
      }
      c.clock.time = 10000; // Installed timer deliberately remains uncalled.
      if (second === "initialization") release.resolve();
      else c.gate.releaseHeartbeat();
      await assertRejects(
        () => bounded(c.started, "synchronous deadline fence"),
        Error,
        "activation deadline exceeded",
      );
      assertEquals(c.failures, ["plugin activation deadline exceeded"]);
      assertEquals(c.host.available, false);
    } finally {
      release.resolve();
      await c.close();
    }
  });
}

Deno.test("startup liveness: qualified boundary750/751 and genuine newer receipts", async () => {
  const c = await controlled();
  try {
    await c.initialized();
    await c.heartbeats();
    c.gate.releaseHeartbeat();
    await c.started;
    c.clock.tick(750);
    assert(c.host.available);
    await consume(c.host);
    await c.heartbeats();
    c.gate.releaseHeartbeat(); // genuine receipt at750, not ready replay
    c.gate.releaseReady();
    c.clock.tick(1500);
    assert(c.host.available);
    await consume(c.host);
    c.clock.tick(1501);
    assertEquals(c.host.available, false);
    assertEquals(c.host.registrations.size, 0);
    assertEquals(c.failures, [
      "worker heartbeat timeout; in-flight outcome unknown",
    ]);
  } finally {
    await c.close();
  }
});

Deno.test("startup liveness: wall-clock jumps do not change monotonic monitoring", async () => {
  const c = await controlled(), original = Date.now;
  try {
    await c.initialized();
    await c.heartbeats();
    Date.now = () => original() + 86400000;
    c.clock.tick(1000);
    assertEquals(c.failures, []);
    assertEquals(c.state(), "pending");
    c.gate.releaseHeartbeat();
    await c.started;
    await consume(c.host);
    Date.now = () => original() - 86400000;
    c.clock.tick(1750);
    assert(c.host.available);
    Date.now = () => original() + 86400000;
    c.clock.tick(1751);
    assertEquals(c.host.available, false);
  } finally {
    Date.now = original;
    await c.close();
  }
});

Deno.test("startup liveness: two render replicas wait for real initial sync RPCs and every heartbeat", async () => {
  const entered = new Set<string>(), release = Promise.withResolvers<void>();
  const c = await controlled(
    renderConsumer,
    "render",
    2,
    async (method, _, actor) => {
      assertEquals(method, "readNote");
      entered.add(actor!.generation);
      await release.promise;
      return "synchronized-sentinel";
    },
  );
  try {
    await until(() => entered.size === 2, "both real sync reads");
    await c.heartbeats();
    c.gate.releaseHeartbeat(0);
    c.clock.tick(1000);
    assertEquals(c.failures, []);
    assertEquals(c.host.available, false);
    assertEquals(c.state(), "pending");
    release.resolve();
    await c.initialized();
    assertEquals(c.host.available, false);
    assertEquals(c.state(), "pending");
    c.gate.releaseHeartbeat(1);
    await bounded(c.started, "every replica qualified");
    assert(c.host.available);
    const results = await Promise.all([
      c.host.call("parseNode", [{}]),
      c.host.call("parseNode", [{}]),
    ]) as { nonce: string; sentinel: string }[];
    assertEquals(results.map((item) => item.sentinel), [
      "synchronized-sentinel",
      "synchronized-sentinel",
    ]);
    assertEquals(new Set(results.map((item) => item.nonce)).size, 2);
  } finally {
    release.resolve();
    await c.close();
  }
});

for (const waiting of ["heartbeat", "initialization"] as const) {
  Deno.test(`startup liveness: stopping while ${waiting} pending cannot resurrect readiness`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let actor: RpcAuthority | undefined;
    const source = serviceConsumer.replace(
      "export async function activate(ctx){",
      "export async function activate(ctx){await ctx.readNote('hold');",
    );
    const c = await controlled(
      source,
      "service",
      1,
      async (_, __, authority) => {
        actor = authority;
        entered.resolve();
        await release.promise;
        return null;
      },
    );
    try {
      await bounded(entered.promise, "startup RPC");
      await c.heartbeats();
      if (waiting === "heartbeat") {
        release.resolve();
        await c.initialized();
      } else {
        c.gate.releaseHeartbeat();
        await c.heartbeats();
      }
      const disposal = c.host.dispose();
      c.gate.releaseHeartbeat();
      if (c.gate.workers[0].ready) c.gate.releaseReady();
      release.resolve();
      await bounded(disposal, "pending-slot disposal");
      await assertRejects(() => c.started, Error, "stopped");
      assertEquals(await actor!.readiness, { status: "aborted" });
      assertEquals(c.host.available, false);
      assertEquals(c.gate.workers[0].terminated, 1);
    } finally {
      release.resolve();
      await c.close();
    }
  });
}

Deno.test("startup liveness: duplicate ready during held sync runs initialization once", async () => {
  let syncs = 0;
  const release = Promise.withResolvers<void>();
  const c = await controlled(renderConsumer, "render", 1, async () => {
    syncs++;
    await release.promise;
    return "once";
  });
  try {
    await until(() => syncs === 1, "real sync admission");
    await c.heartbeats();
    c.gate.releaseReady();
    c.gate.releaseReady();
    c.gate.releaseHeartbeat();
    c.clock.tick(1000);
    assertEquals(c.state(), "pending");
    assertEquals(syncs, 1);
    release.resolve();
    await c.started;
    assertEquals(syncs, 1);
    assertEquals(
      (await c.host.call("parseNode", [{}]) as { sentinel: string }).sentinel,
      "once",
    );
    // A conflicting valid duplicate cannot remove the first admitted exports.
    const captured = c.gate.workers[0].ready!;
    c.gate.workers[0].deliver(
      new MessageEvent("message", { data: { ...captured.data, exports: [] } }),
    );
    assert(c.host.renderCapable);
    assertEquals(syncs, 1);
    const generation = c.host.generation;
    c.gate.workers[0].deliver(
      new MessageEvent("message", {
        data: { ...captured.data, exports: [7] } as unknown as WorkerMessage,
      }),
    );
    assertEquals(c.host.available, false);
    assert(!c.host.generations.includes(generation!));
    assertEquals(c.gate.workers[0].terminated, 1);
  } finally {
    release.resolve();
    await c.close();
  }
});

Deno.test("startup liveness: successful construction exhausting original budget is terminated before membership", async () => {
  const fixture = await pluginFixture();
  const dir = await fixture.install("constructor-budget", {
    runtime: { server: "service.js" },
  }, { "service.js": serviceConsumer });
  const gate = new WorkerDeliveryGate(), clock = new LivenessClock();
  gate.onConstruct = () => {
    clock.time = 10000;
  };
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    () => Promise.resolve(null),
    1,
    { role: "service", liveness: clock },
  );
  try {
    await assertRejects(
      () => bounded(host.start(), "constructed expired candidate"),
      Error,
      "activation deadline exceeded",
    );
    assertEquals(gate.workers.length, 1);
    assertEquals(gate.workers[0].terminated, 1);
    assertEquals(clock.timeouts.size, 0);
    assertEquals(clock.intervals.size, 0);
    assertEquals(host.available, false);
  } finally {
    host.stop();
    gate.restore();
    console.log(JSON.stringify({ retainedLivenessFixture: fixture.root }));
  }
});

for (
  const kind of [
    "silent-initialization",
    "synchronous-hang",
    "asynchronous-hang",
  ]
) {
  Deno.test(`startup liveness: real ${kind} preserves its independent failure bound`, async () => {
    const evidence = await Deno.makeTempDir({
      prefix: `liveness-child-${kind}-`,
    });
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        `--config=${new URL("../deno.json", import.meta.url).pathname}`,
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        new URL("./helpers/plugin_worker_liveness_child.ts", import.meta.url)
          .pathname,
        kind,
        evidence,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
    }, 10000);
    try {
      const output = await child.output();
      const stdout = new TextDecoder().decode(output.stdout),
        stderr = new TextDecoder().decode(output.stderr);
      await Deno.writeTextFile(`${evidence}/stdout.log`, stdout);
      await Deno.writeTextFile(`${evidence}/stderr.log`, stderr);
      await Deno.writeTextFile(
        `${evidence}/child-exit.json`,
        JSON.stringify({ kind, code: output.code, expired }),
      );
      console.log(
        JSON.stringify({
          kind,
          childExit: output.code,
          expired,
          evidence,
          stdout,
          stderr,
        }),
      );
      assertEquals(
        expired,
        false,
        "outer containment is not the product failure bound",
      );
      assertEquals(output.code, 0, stderr);
      const consumer = JSON.parse(
        await Deno.readTextFile(`${evidence}/consumer.json`),
      );
      assertEquals(consumer.kind, kind);
      assert(consumer.unavailable);
      assertEquals(consumer.registrations, 0);
      assertEquals(consumer.terminated, 1);
      if (kind === "silent-initialization") {
        assertEquals(consumer.receivedHeartbeats, 0);
      }
      if (kind === "asynchronous-hang") {
        assert(consumer.receivedHeartbeats >= 3);
      }
    } finally {
      clearTimeout(timer);
    }
  });
}

Deno.test("startup liveness: held render replacement qualifies independently and late A cannot mutate B", async () => {
  const replacementSync = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let syncs = 0;
  const source = renderConsumer.replace(
    "export function parseNode(){return{nonce,sentinel}}",
    `export async function parseNode(node,ctx){if(node.crash){await ctx.readNote('crash');setTimeout(()=>{throw Error('real owned recovery crash')},0);return new Promise(()=>{})}return{nonce,sentinel}}`,
  );
  const c = await controlled(source, "render", 2, async (_, args) => {
    if (args[0] === "initial" && ++syncs === 3) {
      replacementSync.resolve();
      await release.promise;
    }
    return "synchronized-sentinel";
  });
  try {
    await c.initialized();
    await c.heartbeats();
    c.gate.releaseHeartbeat(0);
    c.gate.releaseHeartbeat(1);
    await c.started;
    const original = [...c.host.generations];
    const before = await Promise.all([
      c.host.call("parseNode", [{}]),
      c.host.call("parseNode", [{}]),
    ]) as { nonce: string }[];
    const failed = c.host.call("parseNode", [{ crash: true }]).catch((error) =>
      error
    );
    await bounded(replacementSync.promise, "real replacement initial sync");
    assert(await failed instanceof Error);
    assertEquals(c.gate.workers.length, 3);
    assertEquals(c.host.available, false);
    const oldIndex = c.gate.workers.findIndex((item) => item.terminated > 0);
    const healthyIndex = oldIndex === 0 ? 1 : 0;
    await until(
      () =>
        c.gate.workers[2].held.length > 0 &&
        c.gate.workers[healthyIndex].held.length > 0,
      "actual current heartbeat deliveries",
    );
    c.gate.releaseHeartbeat(2); // heartbeat alone cannot finish a held replacement sync
    c.clock.time = 1000;
    c.gate.releaseHeartbeat(healthyIndex);
    c.clock.tick(1000);
    assertEquals(c.host.available, false);
    assertEquals(syncs, 3);
    c.gate.workers[oldIndex].deliver(c.gate.workers[oldIndex].heartbeatEvent!);
    c.gate.releaseReady(oldIndex);
    release.resolve();
    await until(
      () => c.host.available,
      "replacement completes combined transition",
    );
    const replacement = c.host.generations.find((generation) =>
      !original.includes(generation)
    );
    assert(replacement);
    const unaffected = original[healthyIndex];
    assert(c.host.generations.includes(unaffected));
    const after = await Promise.all([
      c.host.call("parseNode", [{}]),
      c.host.call("parseNode", [{}]),
    ]) as { nonce: string; sentinel: string }[];
    assertEquals(after.map((item) => item.sentinel), [
      "synchronized-sentinel",
      "synchronized-sentinel",
    ]);
    assertEquals(
      after.filter((item) => before.some((old) => old.nonce === item.nonce))
        .length,
      1,
    );
    c.gate.releaseReady(oldIndex);
    assertEquals(syncs, 3);
    assertEquals(c.host.available, true);
    console.log(
      JSON.stringify({
        original,
        replacement,
        unaffected,
        before,
        after,
        syncs,
      }),
    );
  } finally {
    release.resolve();
    await c.close();
  }
});

for (const failure of ["import", "initial-sync", "required-guard"] as const) {
  Deno.test(`startup liveness: real ${failure} failure cannot be qualified by a late heartbeat`, async () => {
    const release = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const source = failure === "import"
      ? `throw Error('actual module evaluation failure');export function activate(){}`
      : failure === "initial-sync"
      ? renderConsumer.replace(
        "sentinel=await ctx.readNote('initial')",
        "await ctx.readNote('initial');throw Error('actual initial sync failure')",
      )
      : serviceConsumer;
    const fixture = await pluginFixture();
    const role = failure === "initial-sync" ? "render" : "service";
    const dir = await fixture.install("startup-failure", {
      ...(role === "service" ? { runtime: { server: "service.js" } } : {}),
      ...(failure === "required-guard" ? { hooks: ["pre-save"] } : {}),
    }, { [role === "service" ? "service.js" : "main.js"]: source });
    const gate = new WorkerDeliveryGate(), clock = new LivenessClock();
    const host = new PluginHost(
      readManifest(dir),
      fixture.vault,
      async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
      1,
      { role, liveness: clock },
    );
    const start = host.start();
    start.catch(() => undefined);
    try {
      if (failure === "initial-sync") {
        await bounded(entered.promise, "real failing sync");
        await bounded(gate.heartbeat.promise, "real pre-failure heartbeat");
        release.resolve();
      }
      await assertRejects(
        () => bounded(start, "actual initialization failure"),
        Error,
        failure === "import"
          ? "failed to load"
          : failure === "initial-sync"
          ? "initial onSync failed"
          : "required pre-hook registration missing",
      );
      if (gate.workers[0].heartbeatEvent) {
        gate.workers[0].deliver(gate.workers[0].heartbeatEvent);
      }
      if (gate.workers[0].ready) gate.releaseReady();
      assertEquals(host.available, false);
      assertEquals(host.registrations.size, 0);
      assertEquals(gate.workers[0].terminated, 1);
      assertEquals(clock.timeouts.size, 0);
      assertEquals(clock.intervals.size, 0);
    } finally {
      release.resolve();
      host.stop();
      await start.catch(() => undefined);
      gate.restore();
      console.log(
        JSON.stringify({
          startupFailure: failure,
          retainedLivenessFixture: fixture.root,
        }),
      );
    }
  });
}

Deno.test("startup liveness: qualified disposal result remains deliverable while stopping", async () => {
  const c = await controlled(
    serviceConsumer.replace(
      "export async function activate(ctx){",
      "export async function activate(ctx){ctx.register(()=>{throw Error('actual disposal consumer')});",
    ),
  );
  try {
    await c.initialized();
    await c.heartbeats();
    c.gate.releaseHeartbeat();
    await c.started;
    const result = await bounded(
      c.host.dispose(),
      "actual disposal result delivery",
    );
    assertEquals(result, {
      unfinished: 0,
      errors: ["actual disposal consumer"],
    });
    assertEquals(c.host.available, false);
    assert(
      c.gate.workers[0].received.some((message) =>
        message.type === "result" && message.ok
      ),
    );
  } finally {
    await c.close();
  }
});
