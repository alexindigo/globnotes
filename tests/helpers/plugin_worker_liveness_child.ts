// SPDX-License-Identifier: LGPL-3.0-only
/** Native hung Workers are contained in an owned process with independent receipts. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PluginHost } from "../../server/plugins/host.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import { pluginFixture } from "./plugin_fixture.ts";
import {
  bounded,
  LivenessClock,
  until,
  WorkerDeliveryGate,
} from "./worker_liveness.ts";

const [kind, evidence] = Deno.args;
assert(
  ["silent-initialization", "synchronous-hang", "asynchronous-hang"].includes(
    kind,
  ),
);
const fixture = await pluginFixture();
const entered = Promise.withResolvers<void>();
const startup = kind === "silent-initialization";
const source = startup
  ? `export async function activate(ctx){await ctx.readNote('entered');while(true){}}`
  : `export function activate(ctx){ctx.commands.register({id:'hang',label:'Hang',target:'server'},async()=>{await ctx.readNote('entered');${
    kind === "synchronous-hang" ? "while(true){}" : "await new Promise(()=>{});"
  }});}`;
const dir = await fixture.install("native-hang", {
  runtime: { server: "service.js" },
}, { "service.js": source });
const gate = new WorkerDeliveryGate(), clock = new LivenessClock();
gate.holdHeartbeat = false;
const failures: string[] = [];
const host = new PluginHost(
  readManifest(dir),
  fixture.vault,
  () => {
    entered.resolve();
    return Promise.resolve(null);
  },
  1,
  {
    role: "service",
    ...(startup ? { liveness: clock } : {}),
    limits: { serviceCallMs: kind === "asynchronous-hang" ? 1200 : 5000 },
    failed: (detail) => {
      failures.push(detail);
    },
  },
);
let pending: Promise<unknown> | undefined;
try {
  if (startup) {
    pending = host.start();
    pending.catch(() => undefined);
    await bounded(entered.promise, "real initialization enters silent loop");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertEquals(gate.workers[0].ready, undefined);
    assertEquals(
      gate.workers[0].received.filter((message) => message.type === "heartbeat")
        .length,
      0,
    );
    clock.tick(1000);
    assertEquals(failures, []);
    clock.tick(10000, true);
    await assertRejects(() => pending!, Error, "activation deadline exceeded");
  } else {
    await bounded(host.start(), "real established Worker");
    const initialCount = gate.workers[0].received.filter((message) =>
      message.type === "heartbeat"
    ).length;
    assert(initialCount > 0);
    pending = host.invoke([...host.registrations.keys()][0], []);
    pending.catch(() => undefined);
    await bounded(entered.promise, "actual hung invocation");
    if (kind === "asynchronous-hang") {
      await until(
        () =>
          gate.workers[0].received.filter((message) =>
            message.type === "heartbeat"
          ).length >= initialCount + 2,
        "live asynchronous handler heartbeats",
      );
    }
    await assertRejects(
      () => bounded(pending!, "native hang rejected", 6000),
      Error,
      kind === "synchronous-hang"
        ? "heartbeat timeout"
        : "call deadline exceeded",
    );
  }
  assertEquals(host.available, false);
  assertEquals(host.registrations.size, 0);
  assertEquals(failures.length, 1);
  const result = {
    kind,
    failures,
    receivedHeartbeats: gate.workers[0].received.filter((message) =>
      message.type === "heartbeat"
    ).length,
    terminated: gate.workers[0].terminated,
    unavailable: !host.available,
    registrations: host.registrations.size,
    fixture: fixture.root,
  };
  await Deno.writeTextFile(
    `${evidence}/consumer.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  host.stop();
  await pending?.catch(() => undefined);
  gate.restore();
}
// A native synchronous loop can retain the Deno process after terminate() returns.
// Exit this owned containment child only after all product outcomes/assertions and
// evidence writes above; this is not proof of natural Worker thread teardown.
Deno.exit(0);
