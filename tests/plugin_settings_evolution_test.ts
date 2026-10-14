// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { RevisionedValues } from "../server/plugins/contracts.ts";
import {
  PLUGIN_LIMITS,
  PluginContractError,
} from "../server/plugins/contracts.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import { validateSettingsPages } from "../server/plugins/settings.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

const writable = { commit: <T>(effect: () => Promise<T>) => effect() };
const retiredPage = {
  id: "retired",
  label: "Retired page",
  renderer: { kind: "declarative-v1", version: 1 },
  fields: [{
    key: "former",
    label: "Former value",
    type: "text",
    default: "old-default",
  }],
};
const currentPage = {
  ...fixturePage,
  fields: [fixturePage.fields[2], {
    key: "added",
    label: "Added value",
    type: "text",
    default: "new-default",
  }],
};

async function seeded() {
  const fixture = await pluginFixture();
  const owner = new PluginDataStore(fixture.statePath, writable).forPlugin(
    "evolving",
  );
  const [original, removed] = validateSettingsPages([fixturePage, retiredPage]);
  const next = validateSettingsPages([currentPage])[0];
  await owner.savePage(original, {
    message: "retained old message",
    protect: true,
    limit: 7,
  }, 0);
  await owner.savePage(removed, { former: "retained old page" }, 1);
  const file = `${fixture.statePath}/plugin-data/evolving/settings.json`;
  const bytes = await Deno.readTextFile(file);
  await Deno.writeTextFile(`${fixture.root}/schema-before.json`, bytes);
  console.log(JSON.stringify({ retainedSchemaEvolutionFixture: fixture.root }));
  return { fixture, owner, original, removed, next, file, bytes };
}

Deno.test("review repairs: R18 schema evolution page read projects current fields without modifying orphan data", async () => {
  const b = await seeded();
  const page = await b.owner.page(b.next);
  assertEquals(page.values, { limit: 7, added: "new-default" });
  assertEquals(page.revision, 2);
  assert(!JSON.stringify(page).includes("retained old"));
  assertEquals(await Deno.readTextFile(b.file), b.bytes);
});

Deno.test("review repairs: R18 schema evolution activation read projects current pages and an empty schema without deleting them", async () => {
  const b = await seeded();
  const active = await b.owner.settings([b.original]);
  assertEquals(Object.keys(active.values), ["preferences"]);
  assertEquals(
    (active.values.preferences as Record<string, unknown>).message,
    "retained old message",
  );
  assert(!JSON.stringify(active).includes("retained old page"));
  assertEquals((await b.owner.settings([])).values, {});
  assertEquals(await Deno.readTextFile(b.file), b.bytes);
});

Deno.test("review repairs: R18 schema evolution writes preserve removed fields and pages through restart and reintroduction", async () => {
  const b = await seeded();
  const saved = await b.owner.savePage(b.next, {
    limit: 8,
    added: "current explicit choice",
  }, 2);
  assertEquals(saved.values, { limit: 8, added: "current explicit choice" });
  assertEquals(saved.revision, 3);
  const raw = JSON.parse(await Deno.readTextFile(b.file));
  assertEquals(raw.values, {
    preferences: {
      message: "retained old message",
      protect: true,
      limit: 8,
      added: "current explicit choice",
    },
    retired: { former: "retained old page" },
  });
  const restarted = new PluginDataStore(b.fixture.statePath, writable)
    .forPlugin("evolving");
  assertEquals((await restarted.page(b.next)).values, saved.values);
  assertEquals((await restarted.page(b.original)).values, {
    message: "retained old message",
    protect: true,
    limit: 8,
  });
  assertEquals((await restarted.page(b.removed)).values, {
    former: "retained old page",
  });
  assertEquals((await restarted.settings([b.original, b.removed])).revision, 3);
  const script = `${b.fixture.root}/settings-restart-consumer.ts`;
  await Deno.writeTextFile(
    script,
    `import { PluginDataStore } from ${
      JSON.stringify(new URL("../server/plugins/data.ts", import.meta.url).href)
    };const owner=new PluginDataStore(${
      JSON.stringify(b.fixture.statePath)
    },{commit:(effect)=>effect()}).forPlugin('evolving');console.log(JSON.stringify({current:await owner.page(${
      JSON.stringify(b.next)
    }),restored:await owner.settings(${
      JSON.stringify([b.original, b.removed])
    })}));`,
  );
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--frozen",
      `--config=${new URL("../deno.json", import.meta.url).pathname}`,
      "--allow-read",
      script,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(child.code, 0, new TextDecoder().decode(child.stderr));
  const observed = JSON.parse(new TextDecoder().decode(child.stdout));
  assertEquals(observed.current.values, saved.values);
  assertEquals(observed.restored.values.retired, {
    former: "retained old page",
  });
  assertEquals(
    observed.restored.values.preferences.message,
    "retained old message",
  );
  assertEquals(observed.current.revision, 3);
});

Deno.test("review repairs: R18 schema evolution keeps invalid current values and incoming controls strict", async () => {
  const b = await seeded();
  const raw = JSON.parse(b.bytes);
  raw.values.preferences.limit = "seven";
  const invalidBytes = JSON.stringify(raw);
  await Deno.writeTextFile(b.file, invalidBytes);
  await assertRejects(
    () => b.owner.page(b.next),
    PluginContractError,
    "finite number",
  );
  await assertRejects(
    () => b.owner.settings([b.next]),
    PluginContractError,
    "finite number",
  );
  assertEquals(await Deno.readTextFile(b.file), invalidBytes);
  await Deno.writeTextFile(b.file, b.bytes);
  for (
    const values of [
      { limit: 8, added: "valid", message: "forged old value" },
      { limit: "8", added: "valid" },
      { limit: 11, added: "valid" },
    ]
  ) {
    await assertRejects(
      () => b.owner.savePage(b.next, values, 2),
      PluginContractError,
    );
    assertEquals(await Deno.readTextFile(b.file), b.bytes);
  }
  await assertRejects(
    () => b.owner.savePage(b.next, { limit: 8, added: "stale" }, 1),
    PluginContractError,
    "changed",
  );
  assertEquals(await Deno.readTextFile(b.file), b.bytes);
  const denied = new PluginDataStore(b.fixture.statePath, writable).forPlugin(
    "evolving",
    () => {
      throw Error("current settings guard denied");
    },
  );
  await assertRejects(
    () => denied.savePage(b.next, { limit: 8, added: "denied" }, 2),
    Error,
    "settings guard denied",
  );
  assertEquals(await Deno.readTextFile(b.file), b.bytes);
  assertEquals(
    [...Deno.readDirSync(`${b.fixture.statePath}/plugin-data/evolving`)].filter(
      (entry) => entry.name.startsWith(".plugin-"),
    ).length,
    0,
  );
});

Deno.test("review repairs: R18 schema evolution retained orphan data still counts toward the storage limit", async () => {
  const b = await seeded();
  const raw = JSON.parse(b.bytes);
  raw.values.preferences.orphan = "x".repeat(PLUGIN_LIMITS.controlBytes - 1024);
  const before = JSON.stringify(raw);
  assert(new TextEncoder().encode(before).length < PLUGIN_LIMITS.controlBytes);
  await Deno.writeTextFile(
    `${b.fixture.root}/schema-limit-before.json`,
    before,
  );
  await Deno.writeTextFile(b.file, before);
  const error = await assertRejects(
    () => b.owner.savePage(b.next, { limit: 8, added: "y".repeat(2048) }, 2),
    PluginContractError,
    "1 MiB",
  );
  assertEquals(error.status, 413);
  assertEquals(await Deno.readTextFile(b.file), before);
});

Deno.test("review repairs: R18 schema evolution actual Worker activation and later read consume the same projected namespace", async () => {
  const b = await seeded();
  await b.fixture.install("evolving", {
    runtime: { server: "service.js" },
    settings: [currentPage],
    capabilities: { read: [], write: [], network: false, imports: false },
  }, {
    "service.js":
      "export async function activate(ctx){const initial=await ctx.settings.read();ctx.commands.register({id:'inspect',label:'Inspect evolved settings',target:'server'},async()=>({initial,current:await ctx.settings.read()}));}",
  });
  const manager = new PluginManager(
    b.fixture.vault,
    () => Promise.resolve(null),
    0,
    b.fixture.statePath,
    { internalRoot: `${b.fixture.root}/empty-internal`, persistence: writable },
  );
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: writable.commit,
  });
  try {
    await runtime.reconcile();
    const deadline = Date.now() + 5000;
    while (runtime.status("evolving")?.status === "starting") {
      assert(Date.now() < deadline, "Worker activation deadline");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(runtime.status("evolving")?.status, "ready");
    const initial = await runtime.invokeCommand("evolving", "inspect", {}) as {
      initial: RevisionedValues;
      current: RevisionedValues;
    };
    assertEquals(initial.initial.values, {
      preferences: { limit: 7, added: "new-default" },
    });
    assertEquals(initial.current.values, initial.initial.values);
    await b.owner.savePage(b.next, {
      limit: 8,
      added: "worker current consumer",
    }, 2);
    const after = await runtime.invokeCommand("evolving", "inspect", {}) as {
      initial: RevisionedValues;
      current: RevisionedValues;
    };
    assertEquals(after.current.values, {
      preferences: { limit: 8, added: "worker current consumer" },
    });
    assertEquals(after.current.revision, 3);
    const raw = JSON.parse(await Deno.readTextFile(b.file));
    assertEquals(raw.values.retired, { former: "retained old page" });
    assertEquals(raw.values.preferences.message, "retained old message");
    console.log(
      JSON.stringify({
        actualProjectedWorkerInitial: initial,
        actualProjectedWorkerAfter: after,
      }),
    );
  } finally {
    manager.stop();
    await runtime.close();
  }
});
