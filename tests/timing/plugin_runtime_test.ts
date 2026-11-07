// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects } from "@std/assert";
import { processClock } from "../../server/observed_time.ts";
import type { RevisionedValues } from "../../server/plugins/contracts.ts";
import { PluginDataStore } from "../../server/plugins/data.ts";
import { readManifest } from "../../server/plugins/manifest.ts";
import {
  PluginRuntime,
  type RuntimeSource,
} from "../../server/plugins/runtime.ts";
import { pluginFixture } from "../helpers/plugin_fixture.ts";
import { pluginSettled } from "../helpers/plugin_ready.ts";
import { done, pending, waitUntil } from "../helpers/wait.ts";

Deno.test("plugin runtime: unknown post-side-effect timeout is not replayed during recovery", async (t) => {
  for (const boundary of ["before-effect", "after-effect"] as const) {
    await t.step(boundary, async () => {
      const fixture = await pluginFixture();
      const sources: RuntimeSource[] = [];
      const release = Promise.withResolvers<void>();
      const commitSettled = Promise.withResolvers<void>();
      let prepared = false, committed = false, commits = 0;
      let commitError: unknown;
      const runtime = new PluginRuntime(() => sources, {
        vaultPath: fixture.vault,
        statePath: fixture.statePath,
        operational: () => true,
        writable: () => true,
        commit: async (effect) => {
          commits++;
          prepared = true;
          try {
            if (boundary === "before-effect") await release.promise;
            const value = await effect();
            committed = true;
            // Keep the command in flight even after the actual rename.
            if (boundary === "after-effect") await release.promise;
            return value;
          } catch (error) {
            commitError = error;
            throw error;
          } finally {
            commitSettled.resolve();
          }
        },
      }, { serviceCallMs: 80 });

      // This checks timeout ordering, not filesystem speed. Capture just the
      // synchronously enqueued command's real expiry callback, restoring the
      // process clock before any worker I/O. Other deadlines remain real.
      function invoke(command: string) {
        const originalDeadline = processClock.deadline;
        let expire: (() => void) | undefined;
        let cancelled = false;
        processClock.deadline = (budget, callback) => {
          assertEquals(budget, 80);
          assertEquals(expire, undefined);
          expire = callback;
          return () => {
            cancelled = true;
          };
        };
        try {
          const result = runtime.invokeCommand("uncertain", command, {});
          assert(expire, "command must arm its deadline during admission");
          return {
            result,
            expire: () => {
              assert(!cancelled, "only an in-flight call may expire");
              expire!();
            },
            cancelled: () => cancelled,
          };
        } finally {
          processClock.deadline = originalDeadline;
        }
      }

      try {
        const dir = await fixture.install("uncertain", {
          runtime: { server: "service.js" },
        }, {
          "service.js": `export function activate(ctx) {
      ctx.commands.register({ id: 'partial', label: 'Partial', target: 'server' }, async () => { const data = await ctx.data.load(); await ctx.data.save({ n: (data.values.n || 0) + 1 }, data.revision); await new Promise(() => {}); });
      ctx.commands.register({ id: 'inspect', label: 'Inspect', target: 'server' }, async () => (await ctx.data.load()).values);
    }`,
        });
        const manifest = readManifest(dir);
        sources.push({ id: manifest.id, enabled: true, manifest, hooks: [] });
        await runtime.reconcile();
        await pluginSettled(runtime, "uncertain", "ready");
        const generation = runtime.status("uncertain")?.generation;
        const call = invoke("partial");
        const rejected = assertRejects(() => call.result, Error, "unknown");
        let callSettled = false;
        call.result.finally(() => callSettled = true).catch(() => {});
        await waitUntil(() => {
          assert(!callSettled, "command settled before the chosen boundary");
          return (boundary === "before-effect" ? prepared : committed)
            ? done()
            : pending({ prepared, committed });
        }, { label: `private data ${boundary} barrier` });
        const owner = new PluginDataStore(fixture.statePath, {
          commit: (effect) => effect(),
        }).forPlugin("uncertain");
        const expected: RevisionedValues = boundary === "after-effect"
          ? { schemaVersion: 1, revision: 1, values: { n: 1 } }
          : { schemaVersion: 1, revision: 0, values: {} };
        assertEquals(await owner.load(), expected);
        call.expire();
        await rejected;
        assert(call.cancelled());
        assertEquals(runtime.status("uncertain")?.status, "failed");
        release.resolve();
        await commitSettled.promise;
        if (boundary === "before-effect") {
          assert(commitError instanceof Error);
          assertEquals(commitError.message, "plugin write authority revoked");
        } else assertEquals(commitError, undefined);
        await runtime.reconcile();
        await pluginSettled(runtime, "uncertain", "ready");
        const inspection = invoke("inspect");
        assertEquals(await inspection.result, expected.values);
        assert(inspection.cancelled());
        assertEquals(await owner.load(), expected);
        assertEquals(commits, 1, "recovery must not replay the uncertain call");
        assert(runtime.status("uncertain")?.generation !== generation);
        assertEquals(runtime.commands().length, 2);
      } finally {
        release.resolve();
        if (prepared) await commitSettled.promise;
        await runtime.close();
        await fixture.dispose();
      }
    });
  }
});
