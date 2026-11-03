// SPDX-License-Identifier: LGPL-3.0-only
/**
 * Owned child for tests/timing/plugin_stall_test.ts: real Workers on the
 * process clock, in a process the parent can stop and resume.
 *   stall EVIDENCE: start a healthy service host and a two-replica render
 *     pool, write ready.json, wait for EVIDENCE/resumed (the parent stops
 *     this process meanwhile), run one second on time, then use both hosts
 *     and write result.json.
 *   hang EVIDENCE: hang a ready service worker's handler synchronously and
 *     write the time until the host failed it to result.json.
 */
import { PluginHost } from "../../server/plugins/host.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import { processClock } from "../../server/observed_time.ts";
import { pluginFixture } from "./plugin_fixture.ts";

const [mode, evidence] = Deno.args;
if (mode !== "stall" && mode !== "hang") throw new Error(`mode ${mode}`);
const fixture = await pluginFixture();
const failures: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const outcome = (value: Promise<unknown>) =>
  value.then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  );

const serviceDir = await fixture.install("stall-service", {
  runtime: { server: "service.js" },
}, {
  "service.js":
    `export function activate(ctx){ctx.commands.register({id:'echo',label:'Echo',target:'server'},(value)=>value);ctx.commands.register({id:'spin',label:'Spin',target:'server'},()=>{for(;;){}});}`,
});
const service = new PluginHost(
  readManifest(serviceDir),
  fixture.vault,
  () => Promise.resolve(null),
  1,
  { role: "service", failed: (detail) => failures.push(detail) },
);
await service.start();
const handler = (id: string) =>
  [...service.registrations].find(([, entry]) => entry.id === id)![0];
const echo = handler("echo"), spin = handler("spin");

if (mode === "stall") {
  const renderDir = await fixture.install("stall-render", {}, {
    "main.js":
      `export function getSelectors(){return[{node:'fence'}]}export function parseNode(){return 'alive'}`,
  });
  const render = new PluginHost(
    readManifest(renderDir),
    fixture.vault,
    () => Promise.resolve(null),
    2,
    { role: "render", failed: (detail) => failures.push(detail) },
  );
  await render.start();
  const generations = {
    service: service.generation,
    render: [...render.generations],
  };
  await Deno.writeTextFile(`${evidence}/ready.json`, JSON.stringify({}));
  for (;;) {
    try {
      await Deno.stat(`${evidence}/resumed`);
      break;
    } catch {
      await sleep(20);
    }
  }
  await sleep(1000);
  const calls = await Promise.all([
    outcome(service.invoke(echo, ["after-stall"])),
    outcome(render.call("parseNode", [{}])),
    outcome(render.call("parseNode", [{}])),
  ]);
  await Deno.writeTextFile(
    `${evidence}/result.json`,
    JSON.stringify({
      failures,
      calls,
      serviceAvailable: service.available,
      renderAvailable: render.available,
      sameGenerations: service.generation === generations.service &&
        JSON.stringify(render.generations) ===
          JSON.stringify(generations.render),
      stalls: processClock.stalls,
    }),
  );
  render.stop();
} else {
  await sleep(500);
  const stallsBefore = processClock.stalls.count;
  const began = performance.now();
  const result = await outcome(service.invoke(spin, []));
  await Deno.writeTextFile(
    `${evidence}/result.json`,
    JSON.stringify({
      failures,
      result,
      detectedAfterMs: performance.now() - began,
      stallsDuring: processClock.stalls.count - stallsBefore,
      serviceAvailable: service.available,
      stalls: processClock.stalls,
    }),
  );
}
service.stop();
await fixture.dispose().catch(() => undefined);
// A spinning Worker thread can retain the process after terminate().
Deno.exit(0);
