// SPDX-License-Identifier: LGPL-3.0-only
import { stringify } from "@std/toml";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { pluginSettings } from "../server/config/consumers.ts";
import { loadInstanceConfig } from "../server/config/loader.ts";
import { PluginContractError } from "../server/plugins/contracts.ts";
import { PluginSettingsEnvironment } from "../server/plugins/settings_environment.ts";
import { createPluginManager } from "./helpers/plugin_manager.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";

function resolved(
  root: string,
  overlay: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const file = `${root}/config.toml`;
  Deno.writeTextFileSync(file, stringify(overlay));
  const result = loadInstanceConfig({
    overlayPath: null,
    env,
    vaults: { family: { path: root, overlayPath: file } },
  });
  return pluginSettings(result.config, result.vaults.family);
}
const persistence = {
  commit: async <T>(effect: () => T | Promise<T>) => await effect(),
};

Deno.test("plugin config: saved policy wins over baseline; explicit false TOML/env pins win without flattening", async () => {
  const fixture = await pluginFixture();
  const file = `${fixture.statePath}/plugins.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({
      autoEnable: false,
      revision: 3,
      order: ["chosen"],
      enabled: ["chosen"],
      operator: "retain",
    }),
  );
  const before = await Deno.readTextFile(file);
  try {
    for (
      const scenario of ([
        { overlay: {}, env: {}, value: false, source: "vault" },
        {
          overlay: { plugins: { autoenable: true } },
          env: {},
          value: true,
          source: "toml",
        },
        {
          overlay: { plugins: { autoenable: false } },
          env: {},
          value: false,
          source: "toml",
        },
        {
          overlay: { plugins: { autoenable: true } },
          env: { GLOBNOTES_FAMILY_PLUGINS_AUTOENABLE: "false" },
          value: false,
          source: "environment",
        },
      ] as {
        overlay: Record<string, unknown>;
        env: Record<string, string>;
        value: boolean;
        source: string;
      }[])
    ) {
      const settings = resolved(fixture.root, scenario.overlay, scenario.env);
      const manager = createPluginManager(
        fixture.vault,
        undefined,
        0,
        fixture.statePath,
        { settings, persistence },
      );
      try {
        const current = await manager.policy.read();
        assertEquals(current.metadata.effectiveAutoEnable, scenario.value);
        assertEquals(current.metadata.autoEnableSource, scenario.source);
        assertEquals(manager.policy.selection().automatic, scenario.value);
        assertEquals(current.policy.order, ["chosen"]);
        if (scenario.source !== "vault") {
          await assertRejects(
            () =>
              manager.policy.setAutoEnable(
                scenario.value,
                [],
                current.metadata,
              ),
            PluginContractError,
            "pinned",
          );
          assertEquals(await Deno.readTextFile(file), before);
        } else {
          assertFalse(Object.hasOwn(settings, "autoEnablePin"));
        }
      } finally {
        manager.stop();
      }
    }
    const manager = createPluginManager(
      fixture.vault,
      undefined,
      0,
      fixture.statePath,
      {
        settings: resolved(fixture.root, { plugins: { autoenable: false } }),
        persistence,
      },
    );
    try {
      // Pins only control discovery baseline; explicit per-plugin choices keep their owner.
      await manager.policy.setEnabled(
        "other",
        true,
        (await manager.policy.read()).metadata,
      );
      assertEquals(manager.policy.selection().policy.enabled, [
        "chosen",
        "other",
      ]);
      assertEquals(manager.policy.selection().policy.autoEnable, false);
    } finally {
      manager.stop();
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin config: shipped baseline is not a policy pin, including absent saved policy", async () => {
  const fixture = await pluginFixture();
  const manager = createPluginManager(
    fixture.vault,
    undefined,
    0,
    fixture.statePath,
    { settings: resolved(fixture.root), persistence },
  );
  try {
    const initial = await manager.policy.read();
    assertEquals(initial.metadata.autoEnableSource, "default");
    assertEquals(initial.metadata.effectiveAutoEnable, true);
    await manager.policy.setAutoEnable(false, [], initial.metadata);
    assertEquals(
      (await manager.policy.read()).metadata.autoEnableSource,
      "vault",
    );
    assertEquals(manager.policy.selection().automatic, false);
  } finally {
    manager.stop();
    await fixture.dispose();
  }
});

Deno.test("plugin config: addressed TOML/env use the same validator and canonical source fingerprint", async () => {
  const fixture = await pluginFixture();
  try {
    const raw = JSON.stringify({
      configured: { preferences: { message: "", limit: 7 } },
    });
    const toml = resolved(fixture.root, { plugins: { settings: raw } });
    const env = resolved(fixture.root, { plugins: { settings: "{}" } }, {
      GLOBNOTES_FAMILY_PLUGINS_SETTINGS: raw,
    });
    const a = new PluginSettingsEnvironment(
      toml.addressed.raw,
      toml.addressed.source,
    );
    const b = new PluginSettingsEnvironment(
      env.addressed.raw,
      env.addressed.source,
    );
    assertEquals(a.fingerprint("configured"), b.fingerprint("configured"));
    const page = {
      ...fixturePage,
      renderer: { kind: "declarative-v1" as const, version: 1 as const },
      fields: [{
        key: "message",
        label: "Message",
        type: "text" as const,
        default: "fallback",
      }],
    };
    const onlyMessage = JSON.stringify({
      configured: { preferences: { message: "" } },
    });
    for (const source of ["toml", "environment"] as const) {
      const owner = new PluginSettingsEnvironment(onlyMessage, source);
      const projected = owner.project("configured", page, { message: "saved" });
      assertEquals(projected.values.message, "");
      assertEquals(projected.fields.message, { source, readonly: true });
    }
    const cleared = resolved(fixture.root, { plugins: { settings: raw } }, {
      GLOBNOTES_FAMILY_PLUGINS_SETTINGS: "{}",
    });
    assertEquals(
      new PluginSettingsEnvironment(
        cleared.addressed.raw,
        cleared.addressed.source,
      ).fingerprint("configured"),
      undefined,
    );
    assert(Object.isFrozen(cleared.addressed));
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin config: instance render count reaches real replicas; explicit scheduling override wins", async () => {
  const fixture = await pluginFixture();
  await fixture.install("configured", {
    name: "Configured",
    version: "1",
    capabilities: { network: false, imports: false, read: [], write: [] },
  }, { "main.js": "export function getSelectors(){return []}" });
  const settings = resolved(fixture.root, {}, {
    GLOBNOTES__PLUGINS_RENDERWORKERS: "3",
  });
  for (const override of [undefined, 1]) {
    const manager = createPluginManager(
      fixture.vault,
      undefined,
      override,
      fixture.statePath,
      {
        internalRoot: `${fixture.root}/empty`,
        settings,
        persistence,
        env: {
          values: {},
          get() {
            throw new Error("typed settings must not consult env");
          },
        },
      },
    );
    try {
      await manager.start();
      assertEquals(
        manager.hosts.get("configured")!.generations.length,
        override ?? 3,
      );
    } finally {
      manager.stop();
    }
  }
  await fixture.dispose();
});

Deno.test("plugin config: explicit worker scheduling does not consult a displaced environment count", async () => {
  const fixture = await pluginFixture();
  const manager = createPluginManager(
    fixture.vault,
    undefined,
    0,
    fixture.statePath,
    {
      env: {
        values: {},
        get(key) {
          if (key === "GLOBNOTES__PLUGINS_RENDERWORKERS") {
            throw new Error("explicit override owns scheduling");
          }
          return undefined;
        },
      },
    },
  );
  try {
    manager.validateConfiguration();
  } finally {
    manager.stop();
    await fixture.dispose();
  }
});

for (const source of ["toml", "environment"] as const) {
  for (
    const [index, invalid] of [
      "not-json-SECRET",
      "[]",
      JSON.stringify({ absent: {} }),
      JSON.stringify({ inactive: { missing: { message: "SECRET" } } }),
      JSON.stringify({ inactive: { preferences: { missing: "SECRET" } } }),
      JSON.stringify({ inactive: { preferences: { limit: 999 } } }),
    ].entries()
  ) {
    Deno.test(`plugin config: invalid ${source} addressed case ${index + 1} fails before workers, even inactive`, async () => {
      const fixture = await pluginFixture();
      const WorkerConstructor = globalThis.Worker;
      let starts = 0;
      let manager: ReturnType<typeof createPluginManager> | undefined;
      let runtime:
        | ReturnType<NonNullable<typeof manager>["configureRuntime"]>
        | undefined;
      try {
        for (const id of ["active", "inactive"]) {
          await fixture.install(id, {
            name: id,
            version: "1",
            runtime: { server: "service.js" },
            settings: [fixturePage],
            capabilities: {
              network: false,
              imports: false,
              read: [],
              write: [],
            },
          }, {
            "main.js": "export function getSelectors(){return []}",
            "service.js": "export function activate(){}",
          });
        }
        await Deno.writeTextFile(
          `${fixture.statePath}/plugins.json`,
          JSON.stringify({ disabled: ["inactive"] }),
        );
        const before = [...Deno.readDirSync(fixture.statePath)].map((entry) =>
          entry.name
        ).sort();
        globalThis.Worker = new Proxy(WorkerConstructor, {
          construct(target, args) {
            starts++;
            return Reflect.construct(target, args);
          },
        });
        const settings = source === "toml"
          ? resolved(fixture.root, { plugins: { settings: invalid } })
          : resolved(fixture.root, {}, {
            GLOBNOTES_FAMILY_PLUGINS_SETTINGS: invalid,
          });
        try {
          manager = createPluginManager(
            fixture.vault,
            undefined,
            undefined,
            fixture.statePath,
            { internalRoot: `${fixture.root}/empty`, settings, persistence },
          );
        } catch (error) {
          assert(error instanceof PluginContractError);
          assertFalse(error.message.includes("SECRET"));
        }
        if (manager) {
          const error = assertThrows(
            () => manager!.validateConfiguration(),
            PluginContractError,
          );
          assertFalse(error.message.includes("SECRET"));
          assertThrows(() => manager!.start(), PluginContractError);
          runtime = manager.configureRuntime({
            operational: () => true,
            writable: () => true,
            commit: persistence.commit,
          });
          await assertRejects(() => runtime!.reconcile(), PluginContractError);
        }
        assertEquals(starts, 0);
        assertEquals(
          [...Deno.readDirSync(fixture.statePath)].map((entry) => entry.name)
            .sort(),
          before,
        );
        assertFalse(
          await Deno.stat(`${fixture.statePath}/plugin-data`).then(() => true)
            .catch(() => false),
        );
        assertFalse(
          await Deno.stat(`${fixture.statePath}/plugin-network`).then(() =>
            true
          )
            .catch(() => false),
        );
      } finally {
        globalThis.Worker = WorkerConstructor;
        manager?.stop();
        await runtime?.close();
        await fixture.dispose();
      }
    });
  }
}
