// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PLUGIN_LIMITS } from "../server/plugins/contracts.ts";
import { processClock } from "../server/observed_time.ts";
import { pluginOperationsFixture } from "./helpers/plugin_operations_fixture.ts";
import { pluginSettled } from "./helpers/plugin_ready.ts";
import { PluginHost } from "../server/plugins/host.ts";
import { readManifest } from "../server/plugins/manifest.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import {
  duringWork,
  hostInitialized,
  ownerMilestone,
  workMilestone,
} from "./helpers/product_settlement.ts";
import { pending } from "./helpers/wait.ts";

async function fixture() {
  return await pluginOperationsFixture({
    id: "settlement",
    manifest: {
      runtime: { server: "service.js" },
      versioning: { extensions: [".md"] },
    },
    files: {
      "service.js": `let release, mode='hold';
      export function activate(ctx) {
        ctx.versioning.onOffer(async()=>{
          if(mode==='fail')throw Error('expected callback failure');
          await new Promise(resolve=>{release=resolve;});
        });
        ctx.commands.register({id:'release',label:'Release',target:'server'},()=>release?.());
        ctx.commands.register({id:'fail',label:'Fail',target:'server'},()=>{mode='fail';});
        ctx.commands.register({id:'ping',label:'Ping',target:'server'},()=>true);
      }`,
    },
  });
}

Deno.test("product settlement: a captured cohort excludes later admissions and keeps lanes independent", async () => {
  const f = await fixture();
  try {
    await f.create("Note", "v0");
    await f.save("Note", "v1");
    assertEquals(f.runtime.settlement(f.id, ["versioning"]).pending, 1);
    const cohort = f.runtime.settleWork(f.id, ["versioning"]);
    await f.save("Note", "v2");
    assertEquals(f.runtime.status(f.id)?.versioningPending, 2);
    await f.command("release");
    await cohort;
    assertEquals(f.runtime.status(f.id)?.versioningPending, 1);
    await f.command("release");
    await f.runtime.settleWork(f.id, ["versioning"]);
    assertEquals(f.runtime.status(f.id)?.versioningPending, 0);
    assertEquals(Deno.readTextFileSync(`${f.fixture.vault}/Note.md`), "v2");
    const catalog = await f.manager.catalog();
    const entry = catalog.plugins.find((plugin) => plugin.id === f.id)!;
    assert(
      !("settlement" in entry) && !("work" in entry),
      "internal accessor leaked into public catalogue",
    );
  } finally {
    await f.close();
  }
});

Deno.test("product settlement: ordinary callback rejection settles and retains owner diagnostics", async () => {
  const f = await fixture();
  try {
    await f.command("fail");
    await f.create("Note", "old");
    await f.save("Note", "new");
    await f.runtime.settleWork(f.id, ["versioning"]);
    const status = f.runtime.status(f.id)!;
    assertEquals(status.status, "ready");
    assertEquals(status.versioningPending, 0);
    assert(
      status.degraded &&
        status.diagnostics.some((row) => row.code === "versioning_failed"),
    );
  } finally {
    await f.close();
  }
});

Deno.test("product settlement: a genuinely hung invocation rejects through its unchanged product deadline", async () => {
  const f = await fixture();
  const deadline = processClock.deadline.bind(processClock);
  let expire: (() => void) | undefined;
  let requested: number | undefined;
  try {
    await f.create("Note", "old");
    processClock.deadline = (ms, callback) => {
      const cancel = deadline(ms, callback);
      if (ms === PLUGIN_LIMITS.serviceCallMs && !expire) {
        expire = callback;
        requested = ms;
      }
      return cancel;
    };
    await f.save("Note", "new");
    processClock.deadline = deadline;
    assertEquals(
      await f.command("ping"),
      true,
      "the Worker entered the held versioning callback",
    );
    assertEquals(requested, 30_000);
    assert(expire, "real invocation deadline was not installed");
    const work = f.runtime.settleWork(f.id, ["versioning"]);
    const rejected = assertRejects(
      () => work,
      Error,
      "plugin call deadline exceeded",
    );
    expire();
    await rejected;
    const status = f.runtime.status(f.id)!;
    assertEquals(status.status, "failed");
    assertEquals(status.versioningPending, 0);
    assert(
      status.diagnostics.some((row) =>
        row.detail.includes("deadline exceeded")
      ),
    );
    assertEquals(Deno.readTextFileSync(`${f.fixture.vault}/Note.md`), "new");
  } finally {
    processClock.deadline = deadline;
    await f.close();
  }
});

Deno.test("product settlement: retirement cannot be completed by a replacement generation", async () => {
  const f = await fixture();
  try {
    const original = f.runtime.status(f.id)!.generation;
    await f.create("Note", "old");
    await f.save("Note", "new");
    const work = f.runtime.settleWork(f.id, ["versioning"]);
    const rejected = assertRejects(() => work, Error, "plugin host stopped");
    await f.runtime.retireOwner(f.id, false, true);
    await rejected;
    assertEquals(f.runtime.status(f.id)?.status, "disabled");
    await f.runtime.reconcile();
    await pluginSettled(f.runtime, f.id, "ready");
    assert(f.runtime.status(f.id)!.generation !== original);
    assertEquals(await f.command("ping"), true);
  } finally {
    await f.close();
  }
});

Deno.test("product settlement: a queued deadline rejects its captured cohort without failing the active owner", async () => {
  const f = await fixture();
  const deadline = processClock.deadline.bind(processClock);
  let expire: (() => void) | undefined;
  try {
    await f.create("Note", "v0");
    await f.save("Note", "v1");
    // A command in the independent ordinary lane confirms the first offer has
    // entered before admitting a second versioning call behind it.
    assertEquals(await f.command("ping"), true);
    processClock.deadline = (ms, callback) => {
      const cancel = deadline(ms, callback);
      if (ms === PLUGIN_LIMITS.serviceCallMs) expire = callback;
      return cancel;
    };
    await f.save("Note", "v2");
    processClock.deadline = deadline;
    assert(expire);
    const rejected = assertRejects(
      () => f.runtime.settleWork(f.id, ["versioning"]),
      Error,
      "deadline exceeded while queued",
    );
    expire();
    await rejected;
    assertEquals(f.runtime.status(f.id)?.status, "ready");
    await f.command("release");
    await f.runtime.settleWork(f.id, ["versioning"]);
    assertEquals(f.runtime.status(f.id)?.versioningPending, 0);
    assertEquals(Deno.readTextFileSync(`${f.fixture.vault}/Note.md`), "v2");
  } finally {
    processClock.deadline = deadline;
    await f.close();
  }
});

Deno.test("product settlement: synchronous admission failure cannot leave phantom pending work", async () => {
  const f = await fixture();
  const deadline = processClock.deadline;
  try {
    processClock.deadline = () => {
      throw new Error("admission setup failed");
    };
    const result = f.command("release");
    const cohort = f.runtime.settleWork(f.id, ["ordinary"]);
    processClock.deadline = deadline;
    await assertRejects(() => result, Error, "admission setup failed");
    await cohort;
    assertEquals(f.runtime.settlement(f.id, ["ordinary"]).pending, 0);
    assertEquals(f.runtime.status(f.id)?.status, "ready");
  } finally {
    processClock.deadline = deadline;
    await f.close();
  }
});

Deno.test("product settlement: a surviving render pool cannot relabel retired replica work as successful idle", async () => {
  const fixture = await pluginFixture();
  const dir = await fixture.install("replica-settlement", {}, {
    "main.js": `export function getSelectors(){return []}
      export function parseNode(node){
        if(node.crash){setTimeout(()=>{throw Error('actual captured replica crash')},0);return new Promise(()=>{});}
        return {parts:['<b>replacement consumer</b>']};
      }`,
  });
  const host = new PluginHost(
    readManifest(dir),
    fixture.vault,
    () => Promise.resolve(null),
    1,
  );
  try {
    await host.start();
    const before = host.generation;
    const running = host.call("parseNode", [{ crash: true }]).catch((error) =>
      error
    );
    const cohort = host.settleWork(["ordinary"]).then(
      () => null,
      (error) => error,
    );
    assert(await running instanceof Error);
    await hostInitialized(host);
    assert(host.generation !== before);
    assertEquals(await host.call("parseNode", [{}]), {
      parts: ["<b>replacement consumer</b>"],
    });
    const outcome = await cohort;
    assert(
      outcome instanceof Error,
      "the original replica terminated, even though its pool recovered",
    );
    assert(outcome.message.includes("worker crashed"));
  } finally {
    host.stop();
    await fixture.dispose();
  }
});

Deno.test("product settlement: a missing intermediate outcome fails when its captured cohort settles", async () => {
  await assertRejects(
    () =>
      duringWork(
        Promise.resolve(),
        () => Promise.resolve(pending("missing marker")),
        "consumer marker",
      ),
    Error,
    "product work settled without the expected outcome",
  );
  const missing = new Promise<never>(() => undefined);
  await assertRejects(
    () => workMilestone(Promise.resolve(), missing, "consumer marker"),
    Error,
    "product work settled without the expected milestone",
  );
  await assertRejects(
    () =>
      ownerMilestone(
        () => ({
          owner: undefined,
          pending: 0,
          completion: Promise.resolve(),
          changed: missing,
          failure: "owner failed before marker",
        }),
        missing,
        "consumer marker",
      ),
    Error,
    "owner failed before marker",
  );
});
