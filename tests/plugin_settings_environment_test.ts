// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { PluginManager } from "../server/plugins/manager.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { auxiliaryFixture } from "./helpers/auxiliary_fixture.ts";
import { PluginDataStore } from "../server/plugins/data.ts";
import { PluginContractError } from "../server/plugins/contracts.ts";
import {
  effectiveSourceKey,
  PluginSettingsEnvironment,
} from "../server/plugins/settings_environment.ts";
import { state } from "../server/state.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import settingsGet from "../server/api/endpoints/_/api/plugin-host/%23id/settings/%23page/get.ts";

Deno.test("backup settings: environment reaches the actual service settings consumer", async () => {
  const fixture = await pluginFixture();
  const previousState = { ...state };
  const original = Deno.env.get("GLOBNOTES_PLUGIN_SETTINGS");
  Deno.env.set(
    "GLOBNOTES_PLUGIN_SETTINGS",
    JSON.stringify({
      configured: { preferences: { location: "operator-selected" } },
    }),
  );
  await fixture.install("configured", {
    runtime: { server: "service.js" },
    capabilities: { read: [], write: [], network: false, imports: false },
    settings: [{
      id: "preferences",
      label: "Preferences",
      renderer: { kind: "declarative-v1", version: 1 },
      fields: [{
        key: "location",
        label: "Location",
        type: "folder",
        default: "",
      }],
    }],
  }, {
    "service.js":
      "export function activate(ctx){ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>ctx.settings.read());}",
    "main.js":
      "export function getSelectors(){return []} export async function parseNode(node,ctx){return ctx.settings.read()}",
  });
  const ready = Promise.withResolvers<void>();
  const manager = new PluginManager(
    fixture.vault,
    undefined,
    1,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/empty-internal`,
      persistence: { commit: (effect) => effect() },
    },
  );
  const runtime = manager.configureRuntime({
    operational: () => true,
    writable: () => true,
    commit: (effect) => effect(),
    changed: () => {
      if (runtime.status("configured")?.status === "ready") ready.resolve();
    },
  });
  const timer = setTimeout(
    () => ready.reject(new Error("fixture did not become ready")),
    5000,
  );
  try {
    await runtime.reconcile();
    await ready.promise;
    const result = await runtime.invokeCommand("configured", "inspect", {}) as {
      values: { preferences: { location: string } };
      sourceKey: string;
    };
    assertEquals(
      result.values.preferences.location,
      "operator-selected",
      "effective environment setting must reach the actual Worker",
    );
    const data = new PluginDataStore(fixture.statePath, {
      commit: (effect) => effect(),
      settingsSchema: (id) => manager.network.settingsSchema(id),
      settingsContext: (id) => manager.network.settingsContext(id),
      settingsEnvironment: manager.settingsEnvironment,
    });
    Object.assign(state, { plugins: manager, pluginData: data });
    const http = await settingsGet(
      {
        params: { id: "configured", page: "preferences" },
      } as unknown as PathfinderRequest,
    );
    assert(!(http instanceof Response));
    assertEquals(http.values.location, "operator-selected");
    assertEquals(http.sourceKey, result.sourceKey);
    const permission = await manager.network.view("configured");
    assertEquals(permission.source.key, result.sourceKey);
    await manager.start();
    const renderer = await manager.hosts.get("configured")!.call("parseNode", [
      {},
    ]) as { values: unknown; sourceKey: string };
    assertEquals(renderer.values, result.values);
    assertEquals(renderer.sourceKey, result.sourceKey);
  } finally {
    clearTimeout(timer);
    manager.stop();
    await runtime.close();
    Object.assign(state, previousState);
    if (original === undefined) Deno.env.delete("GLOBNOTES_PLUGIN_SETTINGS");
    else Deno.env.set("GLOBNOTES_PLUGIN_SETTINGS", original);
    console.log(JSON.stringify({ retainedEnvironmentFixture: fixture.root }));
  }
});

Deno.test("backup settings: pins preserve exact stored fallback and siblings; unpin restores values", async () => {
  const b = await auxiliaryFixture({
    environment: JSON.stringify({ auxiliary: { preferences: { base: "" } } }),
  });
  const file = `${b.statePath}/plugin-data/auxiliary/settings.json`;
  try {
    await Deno.mkdir(`${b.statePath}/plugin-data/auxiliary`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        values: {
          preferences: { base: "stored-base", count: 4, orphan: "retained" },
          oldPage: { value: "retained" },
        },
      }),
    );
    const current = await b.data.forPlugin(b.id).page(b.page);
    assertEquals(current.values, { base: "", count: 4 });
    assertEquals(current.fields.base, {
      source: "environment",
      readonly: true,
    });
    const accepted = await b.data.forPlugin(b.id).savePage(
      b.page,
      { base: "", count: 7 },
      1,
      current.sourceKey,
    );
    assertEquals(accepted.values, { base: "", count: 7 });
    const raw = JSON.parse(await Deno.readTextFile(file));
    assertEquals(raw.values.preferences, {
      base: "stored-base",
      count: 7,
      orphan: "retained",
    });
    assertEquals(raw.values.oldPage, { value: "retained" });
    await assertRejects(
      () =>
        b.data.forPlugin(b.id).savePage(
          b.page,
          { base: "replacement", count: 8 },
          2,
          accepted.sourceKey,
        ),
      PluginContractError,
      "pinned",
    );
    const unpinned = new PluginDataStore(b.statePath, {
      commit: (effect) => effect(),
      settingsEnvironment: new PluginSettingsEnvironment(),
    });
    assertEquals((await unpinned.forPlugin(b.id).page(b.page)).values, {
      base: "stored-base",
      count: 7,
    });
    const previous = await Deno.readTextFile(file);
    await assertRejects(
      () =>
        b.data.forPlugin(b.id).savePage(
          b.page,
          { base: "", count: 8 },
          2,
          current.sourceKey,
        ),
      PluginContractError,
      "source changed",
    );
    assertEquals(await Deno.readTextFile(file), previous);
    const worker = await b.settings();
    assertEquals(worker.values.preferences, accepted.values);
  } finally {
    await b.close();
  }
});

Deno.test("backup settings: corrupted pinned fallbacks are visible and retained", async () => {
  const b = await auxiliaryFixture({
    environment: JSON.stringify({
      auxiliary: { preferences: { base: "pinned" } },
    }),
  });
  const file = `${b.statePath}/plugin-data/auxiliary/settings.json`;
  try {
    await Deno.mkdir(`${b.statePath}/plugin-data/auxiliary`, {
      recursive: true,
    });
    for (
      const raw of [
        "malformed-json",
        JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          values: { preferences: { base: 23 } },
        }),
      ]
    ) {
      await Deno.writeTextFile(file, raw);
      await assertRejects(
        () => b.data.forPlugin(b.id).page(b.page),
        PluginContractError,
      );
      assertEquals(await Deno.readTextFile(file), raw);
    }
  } finally {
    await b.close();
  }
});

Deno.test("backup settings: bounded strict overlays and per-plugin canonical presence fingerprints", () => {
  assertThrows(() => new PluginSettingsEnvironment(""), PluginContractError);
  assertThrows(() => new PluginSettingsEnvironment("[]"), PluginContractError);
  assertThrows(
    () => new PluginSettingsEnvironment(" ".repeat(1024 * 1024 + 1)),
    PluginContractError,
  );
  const a = new PluginSettingsEnvironment('{"a":{"p":{"x":"", "y":2}},"b":{}}'),
    b = new PluginSettingsEnvironment(
      '{"b":{"other":{}},"a":{"p":{"y":2,"x":""}}}',
    );
  assertEquals(a.fingerprint("a"), b.fingerprint("a"));
  assert(a.fingerprint("b") !== b.fingerprint("b"));
  assertEquals(a.fingerprint("unrelated"), undefined);
  assertThrows(() => a.validateInventory(["a"]), PluginContractError);
  const plain = effectiveSourceKey("a", "code", 0);
  assert(plain !== effectiveSourceKey("a", "code", 0, a.fingerprint("a")));
});

Deno.test("backup settings: restart pin changes retire only their source requests before service readiness and retain approvals", async () => {
  const fixture = await pluginFixture();
  for (const id of ["one", "other"]) {
    await fixture.install(id, {
      runtime: { server: "service.js" },
      capabilities: { network: false, imports: false, read: [], write: [] },
      settings: [{
        id: "p",
        label: "P",
        renderer: { kind: "declarative-v1", version: 1 },
        fields: [{ key: "base", label: "Base", type: "folder", default: "" }],
      }],
    }, {
      "service.js":
        "export function activate(ctx){ctx.commands.register({id:'request',label:'Request',target:'server'},()=>ctx.permissions.requestAccess({kind:'network',hosts:['example.test:443'],reason:'owned fixture'}));ctx.commands.register({id:'inspect',label:'Inspect',target:'server'},()=>ctx.permissions.status());}",
    });
  }
  async function start(raw?: string) {
    const ready = Promise.withResolvers<void>();
    const manager = new PluginManager(
      fixture.vault,
      undefined,
      0,
      fixture.statePath,
      {
        internalRoot: `${fixture.root}/empty`,
        settingsEnvironment: new PluginSettingsEnvironment(raw),
        persistence: { commit: (effect) => effect() },
      },
    );
    const runtime = manager.configureRuntime({
      operational: () => true,
      writable: () => true,
      commit: (effect) => effect(),
      changed: () => {
        if (
          ["one", "other"].every((id) => runtime.status(id)?.status === "ready")
        ) ready.resolve();
      },
    });
    const timer = setTimeout(
      () => ready.reject(new Error("environment restart did not become ready")),
      5000,
    );
    await runtime.reconcile();
    try {
      await ready.promise;
    } finally {
      clearTimeout(timer);
    }
    return {
      manager,
      runtime,
      async close() {
        manager.stop();
        await runtime.close();
      },
    };
  }
  let current = await start('{"one":{"p":{"base":"operator"}}}');
  try {
    for (const id of ["one", "other"]) {
      await current.runtime.invokeCommand(id, "request", {});
    }
    const oldOne = await current.manager.network.view("one"),
      oldOther = await current.manager.network.view("other");
    await current.manager.network.controls("one", {
      revision: oldOne.revision,
      signature: oldOne.signature,
      requestSourceKey: oldOne.requestSourceKey,
      requestSourceRevision: oldOne.requestSourceRevision,
      allowNetwork: false,
      approvedNetwork: [{ type: "host", authority: "example.test:443" }],
      approvedImports: [],
    });
    await current.close();
    current = await start();
    const one = await current.manager.network.view("one"),
      other = await current.manager.network.view("other");
    assert(one.source.key !== oldOne.source.key);
    assertEquals(other.source.key, oldOther.source.key);
    assertEquals(one.pendingRequests.length, 0);
    assertEquals(other.pendingRequests.length, 1);
    assertEquals(one.approvedNetwork, [{
      type: "host",
      authority: "example.test:443",
    }]);
    const raw = JSON.parse(
      await Deno.readTextFile(`${fixture.statePath}/plugin-network/one.json`),
    );
    assert(
      raw.requests.some((request: { state: string }) =>
        request.state === "obsolete"
      ),
    );
    const sdk = await current.runtime.invokeCommand("one", "inspect", {}) as {
      source: { key: string };
    };
    assertEquals(sdk.source.key, one.source.key);
  } finally {
    await current.close();
    console.log(
      JSON.stringify({ retainedEnvironmentRestartFixture: fixture.root }),
    );
  }
});
