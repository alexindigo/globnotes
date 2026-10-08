// SPDX-License-Identifier: LGPL-3.0-only

/** Owned child: a thrown host callback must be observed as a real process exit. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PluginManager } from "../../server/plugins/manager.ts";
import { pluginFixture } from "./plugin_fixture.ts";

const [kind, evidence] = Deno.args;
assert(["missing-source", "constructor"].includes(kind));
assert(evidence && Deno.statSync(evidence).isDirectory);
const fixture = await pluginFixture();
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const manager = new PluginManager(
  fixture.vault,
  async (method, args) => {
    if (method === "readNote" && args[0] === "crash-after-source-barrier") {
      entered.resolve();
      await release.promise;
    }
    return null;
  },
  2,
  fixture.statePath,
  {
    internalRoot: `${fixture.root}/empty-internal`,
    persistence: { commit: (effect) => effect() },
  },
);
const NativeWorker = globalThis.Worker;
let refuse = false, attempts = 0;
let pending: Promise<unknown> | undefined;
try {
  const dir = await fixture.install("victim", {}, {
    "main.js":
      `export function getSelectors(){return[{node:'fence',language:'victim'}]};export async function parseNode(node,ctx){if(node.crash){await ctx.readNote('crash-after-source-barrier');setTimeout(()=>{throw Error('owned actual R03 Worker crash')},0);return new Promise(()=>{})}return{parts:['<b>victim</b>']}}`,
  });
  await fixture.install("unrelated", {}, {
    "main.js":
      "const nonce=crypto.randomUUID();export function getSelectors(){return[]};export function parseNode(){return{parts:['<b>unrelated consumer</b>'],nonce}}",
  });
  await manager.ensureStarted();
  const victim = manager.hosts.get("victim")!,
    unrelated = manager.hosts.get("unrelated")!;
  assert(victim.available && unrelated.available);
  const unaffectedGenerations = [...unrelated.generations];
  const before = {
    kind,
    fixture: fixture.root,
    victimGenerations: [...victim.generations],
    unaffectedGenerations,
  };
  await Deno.writeTextFile(
    `${evidence}/before-fault.json`,
    JSON.stringify(before, null, 2),
  );
  console.log(JSON.stringify({ beforeFault: before }));
  pending = victim.call("parseNode", [{ crash: true }]).catch((error) => error);
  await entered.promise;
  if (kind === "missing-source") {
    // Preserve the original entry bytes while making the actual entry absent.
    await Deno.rename(`${dir}/main.js`, `${dir}/retained-original-main.js`);
  } else {
    assert(
      Deno.permissions.querySync({ name: "sys", kind: "hostname" }).state !==
        "granted",
    );
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        if (!refuse) return Reflect.construct(target, args, newTarget);
        attempts++;
        const options = args[1] as WorkerOptions & {
          deno: { permissions: Deno.PermissionOptions };
        };
        const permissions = typeof options.deno.permissions === "object"
          ? options.deno.permissions
          : {};
        // Native constructor refusal, not a synthetic thrown test Error.
        return Reflect.construct(target, [args[0], {
          ...options,
          deno: { permissions: { ...permissions, sys: ["hostname"] } },
        }], newTarget);
      },
    });
    refuse = true;
  }
  release.resolve();
  const failed = await pending;
  assert(failed instanceof Error);
  const until = Date.now() + 3000;
  while (victim.generations.length && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(
    victim.generations.length,
    0,
    "terminal failure must stop only the affected pool",
  );
  // This independent command executes in the still-running same host process.
  const output = await unrelated.call("parseNode", [{}]);
  assertEquals(unrelated.generations, unaffectedGenerations);
  assertEquals((output as { parts: string[] }).parts, [
    "<b>unrelated consumer</b>",
  ]);
  assertEquals(victim.available, false);
  assertEquals(
    manager.readyRenderOwners().some((owner) => owner.pluginId === "victim"),
    false,
  );
  await assertRejects(() => victim.call("parseNode", [{}]), Error);
  const result = {
    kind,
    hostProcessAlive: true,
    failedWorkSettled: true,
    affectedUnavailable: !victim.available,
    unaffectedGenerations,
    unrelatedOutput: output,
    actualConstructorRefusals: attempts,
    fixture: fixture.root,
  };
  await Deno.writeTextFile(
    `${evidence}/after-fault.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ afterFault: result }));
} finally {
  release.resolve();
  globalThis.Worker = NativeWorker;
  if (pending) await pending.catch(() => undefined);
  manager.stop();
  console.log(JSON.stringify({ retainedRenderRecoveryFixture: fixture.root }));
}
