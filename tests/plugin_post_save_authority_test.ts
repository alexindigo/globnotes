// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fixtureScope } from "./helpers/fixture_scope.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { bootServer } from "./helpers/boot.ts";
import { fixtureAdmin } from "./helpers/fixture_http.ts";
import { publicScenario } from "./helpers/fixture_scenarios.ts";
import { catalogPluginReady } from "./helpers/plugin_ready.ts";

Deno.test("post-save observer writes its private data after the original HTTP response", () =>
  fixtureScope(async (scope) => {
    const fixture = (await scope.acquire(() =>
      pluginFixture(), (fixture) =>
      fixture.dispose())).value;
    const gate = `${fixture.root}/release`,
      preload = `${fixture.root}/observer-preload.mjs`;
    await Deno.writeTextFile(
      preload,
      `
    import { PluginHost } from ${
        JSON.stringify(
          new URL("../server/plugins/host.ts", import.meta.url).href,
        )
      };
    const invoke = PluginHost.prototype.invoke;
    PluginHost.prototype.invoke = async function (...args) {
      if (args[1]?.[0]?.action === 'save') {
        const watch = Deno.watchFs(${JSON.stringify(fixture.root)});
        try {
          for (;;) {
            try { Deno.statSync(${JSON.stringify(gate)}); break; }
            catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
            if ((await watch.next()).done) throw new Error('fixture gate closed');
          }
        } finally { watch.close(); }
      }
      return await invoke.apply(this, args);
    };
  `,
    );
    await fixture.install("observer", {
      runtime: { server: "service.js" },
      hooks: ["on-save"],
    }, {
      "service.js": `export function activate(ctx) {
      const result = Promise.withResolvers();
      ctx.hooks.on('on-save', async (fact) => {
        try {
          await ctx.data.save({ saved: fact.action }, 0);
          result.resolve({ outcome: 'committed' });
        } catch (error) {
          result.resolve({ outcome: 'refused', reason: error.message });
          throw error;
        }
      });
      ctx.commands.register({id:'result',label:'Result',target:'server'}, () => result.promise);
    }`,
    });
    await Deno.writeTextFile(`${fixture.vault}/Seed.md`, "old");
    const server = (await scope.acquire(() =>
      bootServer({
        GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
        GLOBNOTES__METADATA_PATH: fixture.metadataBase,
        fixtureScenario: publicScenario(),
      }, { denoArgs: ["--preload", preload] }), (server) =>
      server.close())).value;
    const { headers, fetch: adminFetch } = await fixtureAdmin(server);
    await catalogPluginReady(server, "observer", { headers });
    const route = `${server.baseUrl}/_/api/notes/Seed`;
    const { version } = await (await fetch(route)).json();
    const saved = await fetch(route, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        newContent: "new",
        base: { kind: "version", version },
      }),
    });
    assertEquals([saved.status, (await saved.json()).content], [200, "new"]);
    const command = async (id: string) => {
      const response = await adminFetch(
        `${server.baseUrl}/_/api/plugin-host/observer/commands/${id}`,
        { method: "POST", body: "{}", signal: AbortSignal.timeout(5000) },
      );
      assertEquals(response.status, 200);
      return (await response.json()).result;
    };
    await Deno.writeTextFile(gate, "HTTP response consumed");
    try {
      assertEquals(await command("result"), { outcome: "committed" });
    } catch (error) {
      console.error(server.logs().stderr);
      throw error;
    }
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          `${fixture.statePath}/plugin-data/observer/data.json`,
        ),
      ).values,
      { saved: "save" },
    );
  }));
