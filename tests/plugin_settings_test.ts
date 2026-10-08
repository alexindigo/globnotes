// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertThrows } from "@std/assert";
import { readManifest } from "../server/plugins/manifest.ts";
import { PluginManager } from "../server/plugins/manager.ts";
import {
  effectivePageValues,
  validateSettingsPages,
} from "../server/plugins/settings.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

Deno.test("plugin contributions: independent optional entries need no render stub", async (t) => {
  const fixture = await pluginFixture();
  try {
    const cases: {
      id: string;
      manifest: Record<string, unknown>;
      files: Record<string, string>;
    }[] = [
      {
        id: "service-only",
        manifest: { runtime: { server: "service.js" } },
        files: { "service.js": "export function activate() {}" },
      },
      {
        id: "browser-only",
        manifest: { runtime: { client: "application.js" } },
        files: { "application.js": "export function activate() {}" },
      },
      {
        id: "editor-only",
        manifest: { client: { entry: "editor.js" } },
        files: { "editor.js": "export default [];" },
      },
      { id: "settings-only", manifest: { settings: [fixturePage] }, files: {} },
      {
        id: "endpoint-only",
        manifest: {},
        files: { "endpoints/get.js": "export default () => ({ answer: 42 });" },
      },
    ];
    for (const item of cases) {
      await t.step(item.id, async () => {
        const dir = await fixture.install(item.id, item.manifest, item.files);
        assertEquals(readManifest(dir).entry, undefined);
      });
    }
    await t.step(
      "legacy rendering remains optional lifecycle-free",
      async () => {
        const dir = await fixture.install("legacy-render", {}, {
          "main.js": "export function getSelectors() { return []; }",
        });
        assertEquals(readManifest(dir).entry, "main.js");
      },
    );
    await t.step(
      "one plugin can combine all contribution entries",
      async () => {
        const dir = await fixture.install("combined", {
          runtime: { server: "service.js", client: "application.js" },
          hooks: ["on-save", "pre-delete"],
          settings: [fixturePage],
        }, {
          "main.js": "export function getSelectors() { return []; }",
          "client.js": "export default [];",
          "service.js":
            "export function activate(ctx) { ctx.hooks.on('on-save', () => {}); ctx.hooks.on('pre-delete', () => {}); }",
          "application.js": "export function activate() {}",
          "endpoints/get.js": "export default () => ({ answer: 42 });",
        });
        const manifest = readManifest(dir);
        assertEquals(manifest.entry, "main.js");
        assertEquals(manifest.hasClient, true);
        assertEquals(manifest.hasEndpoints, true);
        assertEquals(manifest.runtime, {
          server: "service.js",
          client: "application.js",
        });
        assertEquals(manifest.hooks, ["on-save", "pre-delete"]);
      },
    );
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin settings: supported controls, defaults, dependent visibility and bounded values", () => {
  const pages = validateSettingsPages([{
    id: "controls",
    label: "Controls",
    renderer: { kind: "declarative-v1", version: 1 },
    fields: [
      { key: "enabled", label: "Enabled", type: "toggle", default: false },
      ...["text", "textarea", "file", "folder"].map((type) => ({
        key: type,
        label: type,
        type,
        default: "",
        maxLength: 10,
      })),
      { key: "color", label: "Color", type: "color", default: "#112233" },
      {
        key: "number",
        label: "Number",
        type: "number",
        default: 3,
        min: 1,
        max: 5,
        step: 1,
      },
      {
        key: "slider",
        label: "Slider",
        type: "slider",
        default: 2,
        min: 0,
        max: 10,
      },
      {
        key: "choice",
        label: "Choice",
        type: "select",
        default: "first",
        options: [{ label: "First", value: "first" }, {
          label: "Second",
          value: "second",
        }],
        visibleWhen: { field: "enabled", equals: true },
      },
    ],
    groups: [{ id: "general", label: "General", fields: ["enabled", "text"] }],
  }]);
  assertEquals(effectivePageValues(pages[0]).number, 3);
  assertEquals(
    effectivePageValues(pages[0], { text: "operator" }).text,
    "operator",
  );
  assertThrows(() => effectivePageValues(pages[0], { number: 3.5 }));
  assertThrows(() => effectivePageValues(pages[0], { number: 6 }));
  assertThrows(() => effectivePageValues(pages[0], { choice: "invented" }));
  assertThrows(() =>
    effectivePageValues(pages[0], { text: "too many characters" })
  );
  assertThrows(() => effectivePageValues(pages[0], { color: "red" }));
  assertThrows(() => effectivePageValues(pages[0], { undeclared: "value" }));
  assertThrows(() =>
    validateSettingsPages([{ ...pages[0], html: "<script>" }])
  );
  assertThrows(() =>
    validateSettingsPages([{
      ...pages[0],
      fields: [{
        ...pages[0].fields[0],
        visibleWhen: { field: "missing", equals: true },
      }],
    }])
  );
});

Deno.test("plugin catalog: legacy directory identities retain v2 compatibility", async () => {
  const fixture = await pluginFixture();
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    0,
    fixture.statePath,
    { internalRoot: `${fixture.root}/internal` },
  );
  try {
    for (const id of ["legacy.plugin", "插件"]) {
      const dir = await fixture.install(id, {}, {
        "main.js": "export function getSelectors() { return []; }",
      });
      assertEquals(readManifest(dir).id, id);
    }
    await Deno.writeTextFile(
      `${fixture.statePath}/plugins.json`,
      JSON.stringify({ order: ["legacy.plugin"], disabled: ["插件"] }),
    );
    assertEquals(manager.listPlugins().map((plugin) => plugin.id), [
      "legacy.plugin",
    ]);
  } finally {
    manager.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin catalog: disabled/failed inventory, blocking metadata and optional contributions", async () => {
  const fixture = await pluginFixture();
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    0,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/internal`,
      persistence: { commit: (effect) => effect() },
    },
  );
  try {
    await fixture.install("page-only", { settings: [fixturePage] });
    await fixture.install("guard", {
      runtime: { server: "service.js" },
      hooks: ["pre-delete", "on-save"],
    }, { "service.js": "export function activate() {}" });
    await fixture.install("bad", { id: "wrong" });
    const initial = await manager.catalog();
    assertEquals(initial.plugins.length, 3);
    assertEquals(
      initial.plugins.find((p) => p.id === "guard")?.blocking.actions,
      ["delete"],
    );
    assertEquals(initial.plugins.find((p) => p.id === "bad")?.status, "failed");
    assert(
      initial.plugins.find((p) => p.id === "bad")?.diagnostics[0].detail
        .includes("does not match"),
    );
    const changed = await manager.policy.setEnabled(
      "guard",
      false,
      initial.policy,
    );
    const catalog = await manager.catalog();
    assertEquals(catalog.policy.signature, changed.metadata.signature);
    assertEquals(
      catalog.plugins.find((p) => p.id === "guard")?.status,
      "disabled",
    );
    assertEquals(catalog.plugins.find((p) => p.id === "guard")?.blocking, {
      active: false,
      actions: ["delete"],
    });
    assertEquals(manager.listPlugins().map((p) => p.id), ["page-only"]);
    await manager.start();
    assertEquals(
      manager.hosts.size,
      0,
      "settings-only plugins do not create rendering workers",
    );
    assert(!JSON.stringify(catalog).includes("data.json"));
  } finally {
    manager.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin contributions: malformed declarations and escape entries are rejected", async (t) => {
  const fixture = await pluginFixture();
  try {
    const cases: Record<string, Record<string, unknown>> = {
      "entry-path": { entry: "../outside.js" },
      "client-path": { client: { entry: "../client.js" } },
      "missing-service": { runtime: { server: "missing.js" } },
      "bad-capability": { capabilities: { read: true } },
      "unsupported-pre": {
        runtime: { server: "service.js" },
        hooks: ["pre-sync"],
      },
      "guard-without-runtime": { hooks: ["pre-delete"] },
      "duplicate-hook": {
        runtime: { server: "service.js" },
        hooks: ["on-save", "on-save"],
      },
      "custom-renderer": {
        settings: [{
          ...fixturePage,
          renderer: { kind: "custom-vue", version: 1 },
        }],
      },
      "duplicate-field": {
        settings: [{
          ...fixturePage,
          fields: [fixturePage.fields[0], fixturePage.fields[0]],
        }],
      },
      "bad-default": {
        settings: [{
          ...fixturePage,
          fields: [{ key: "x", label: "X", type: "toggle", default: "true" }],
        }],
      },
    };
    for (const [id, manifest] of Object.entries(cases)) {
      await t.step(id, async () => {
        const dir = await fixture.install(id, manifest, {
          "main.js": "export {};",
          "service.js": "export function activate() {}",
          "client.js": "export default [];",
        });
        assertThrows(() => readManifest(dir));
      });
    }
    await t.step(
      "entry symlink cannot escape the plugin code directory",
      async () => {
        const dir = await fixture.install("entry-symlink", {
          entry: "linked.js",
        });
        const target = `${fixture.root}/outside.js`;
        await Deno.writeTextFile(target, "export {};");
        await Deno.symlink(target, `${dir}/linked.js`);
        assertThrows(() => readManifest(dir));
      },
    );
  } finally {
    await fixture.dispose();
  }
});
