// SPDX-License-Identifier: LGPL-3.0-only
import { publicScenario } from "./helpers/fixture_scenarios.ts";

/** Sandbox endpoint + host control API tests over real HTTP: plugin code
 * executes only in its worker, envelopes stay structured, 404/405/Allow
 * semantics hold, enablement gates availability, and the control API
 * persists against revision/signature checks. */

import { assert, assertEquals } from "@std/assert";
import { bootServer } from "./helpers/boot.ts";
import { ENDPOINT_PLUGIN } from "./helpers/endpoint_plugin.ts";
import { pluginFixture, withPluginFixture } from "./helpers/plugin_fixture.ts";
import { createIdentityPluginEvents } from "../server/plugins/identity_events.ts";
import { fixtureAdmin } from "./helpers/fixture_http.ts";
import { accountRouteFixture } from "./helpers/account_route_fixture.ts";
import { createUuid } from "../shared/uuid.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";
import { catalogPluginReady } from "./helpers/plugin_ready.ts";
import { done, pending as waitPending, waitUntil } from "./helpers/wait.ts";

async function pluginApiServer(opts: Record<string, string> = {}) {
  const fixture = await pluginFixture();
  await fixture.install("ep", ENDPOINT_PLUGIN.manifest, ENDPOINT_PLUGIN.files);
  const server = await bootServer({
    GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES__METADATA_PATH: fixture.metadataBase,
    fixtureScenario: publicScenario(),
    GLOBNOTES__SERVER_PATHPREFIX: "",
    ...opts,
  });
  // Wait until the service runtime reports ready through the catalog.
  const admin = await fixtureAdmin(server);
  await catalogPluginReady(server, "ep", { headers: admin.headers });
  const catalog =
    await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
      .json();
  return { fixture, server, catalog, admin };
}

for (const prefix of ["", "/notes"]) {
  Deno.test(`plugin api: View refuses host mutations before dispatch (${prefix || "no prefix"})`, () =>
    withPluginFixture(async (fixture, scope) => {
      await fixture.install("ep", ENDPOINT_PLUGIN.manifest, {
        ...ENDPOINT_PLUGIN.files,
        "service.js": `import { enter } from './count.js';
          export function activate(ctx) {
            ctx.commands.register({ id: 'mutate', label: 'Mutate', target: 'server' }, async () => {
              enter();
              await ctx.data.save({ committed: true }, 0);
              return 'committed';
            });
            ctx.commands.register({ id: 'fail', label: 'Fail', target: 'server' }, () => {
              throw new Error('operation_not_permitted');
            });
          }`,
        "count.js": `let count = 0; export const enter = () => count++;
          export const read = () => count;`,
        "endpoints/count/get.js": `import { read } from '../../count.js';
          export default () => ({ count: read() });`,
      });
      const server = await bootServer({
        GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
        GLOBNOTES__METADATA_PATH: fixture.metadataBase,
        fixtureScenario: publicScenario("view"),
        GLOBNOTES__SERVER_PATHPREFIX: prefix,
      });
      scope.defer(() => server.close());
      const admin = await fixtureAdmin(server, prefix);
      await catalogPluginReady(server, "ep", {
        prefix,
        headers: admin.headers,
      });
      const api = `${server.baseUrl}${prefix}/_/api`;
      const host = `${api}/plugin-host`;
      const request = (method: "POST" | "PUT") => ({
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const readCount = async () => {
        const response = await fetch(`${api}/plugins/ep/count`);
        assertEquals(response.status, 200);
        return await response.json();
      };
      assertEquals(await readCount(), { count: 0 });
      const denied = [];
      for (
        const [route, method] of [
          ["ep/commands/mutate", "POST"],
          ["ep/settings/page", "PUT"],
          ["ep/enabled", "PUT"],
          ["ep/permissions", "PUT"],
          ["ep/permission-requests/request/decision", "POST"],
          ["policy", "PUT"],
        ] as const
      ) {
        const response = await fetch(`${host}/${route}`, request(method));
        denied.push([route, response.status, await response.json()]);
      }
      const unchanged = await readCount();
      const adminCommand = await admin.fetch(
        `${host}/ep/commands/mutate`,
        request("POST"),
      );
      const failure = await admin.fetch(
        `${host}/ep/commands/fail`,
        request("POST"),
      );
      const refusal = {
        detail: "This account cannot perform that operation.",
        code: "operation_not_permitted",
      };
      assertEquals(denied, [
        ["ep/commands/mutate", 403, refusal],
        ["ep/settings/page", 403, refusal],
        ["ep/enabled", 403, refusal],
        ["ep/permissions", 403, refusal],
        ["ep/permission-requests/request/decision", 403, refusal],
        ["policy", 403, refusal],
      ]);
      assertEquals(unchanged, { count: 0 });
      assertEquals([adminCommand.status, await adminCommand.json()], [200, {
        result: "committed",
      }]);
      assertEquals([failure.status, await failure.json()], [500, {
        detail: "plugin command failed",
      }]);
      assertEquals(await readCount(), { count: 1 });
    }));
}

Deno.test("plugin api: root/rest routes, decoded params, query data and actual results", async () => {
  const { fixture, server, admin } = await pluginApiServer();
  try {
    const root = await fetch(`${server.baseUrl}/_/api/plugins/ep`);
    assertEquals(root.status, 200);
    const rootBody = await root.json();
    assertEquals(rootBody.route, "root");
    // Credentials never cross the boundary.
    const withCreds = await admin.fetch(`${server.baseUrl}/_/api/plugins/ep`, {
      headers: { cookie: "other-cookie=not-forwarded" },
    });
    const echo = await withCreds.json();
    const headerNames = echo.headers.map((h: string[]) => h[0].toLowerCase());
    assert(!headerNames.includes("cookie"));
    assert(!headerNames.includes("authorization"));

    const item = await fetch(
      `${server.baseUrl}/_/api/plugins/ep/item/hello%20world?x=1&x=2`,
    );
    assertEquals(item.status, 200);
    const itemBody = await item.json();
    assertEquals(itemBody.name, "hello world");
    assertEquals(itemBody.query, [["x", "1"], ["x", "2"]]);

    const tree = await fetch(`${server.baseUrl}/_/api/plugins/ep/tree/a/b%20c`);
    assertEquals((await tree.json()).rest, "a/b c");

    const post = await fetch(`${server.baseUrl}/_/api/plugins/ep`, {
      method: "POST",
      body: "raw-bytes",
    });
    assertEquals((await post.json()).bytes, 9);

    const shaped = await fetch(`${server.baseUrl}/_/api/plugins/ep/echo`, {
      method: "POST",
      body: "payload",
    });
    assertEquals(shaped.status, 201);
    assertEquals(shaped.headers.get("x-plugin"), "yes");
    assertEquals(shaped.headers.get("set-cookie"), null);
    assertEquals(await shaped.text(), "payload");
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("plugin api: 404/405/Allow semantics and disabled-plugin unavailability", async () => {
  const { fixture, server, admin } = await pluginApiServer();
  try {
    assertEquals(
      (await fetch(`${server.baseUrl}/_/api/plugins/ep/unknown`)).status,
      404,
    );
    assertEquals(
      (await fetch(`${server.baseUrl}/_/api/plugins/ghost`)).status,
      404,
    );
    const wrong = await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`, {
      method: "DELETE",
    });
    assertEquals(wrong.status, 405);
    assertEquals(wrong.headers.get("allow"), "GET, HEAD, OPTIONS");
    await wrong.body?.cancel();

    const options = await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`, {
      method: "OPTIONS",
    });
    assertEquals(options.status, 204);
    assertEquals(options.headers.get("allow"), "GET, HEAD, OPTIONS");
    await options.body?.cancel();

    const head = await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`, {
      method: "HEAD",
    });
    assertEquals(head.status, 200);
    assertEquals((await head.arrayBuffer()).byteLength, 0);

    // Disable through the control API: unavailable even though files remain.
    const catalog =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const disable = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: false,
          revision: catalog.policy.revision,
          signature: catalog.policy.signature,
        }),
      },
    );
    assertEquals(disable.status, 200);
    await disable.body?.cancel();
    assertEquals(
      (await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`)).status,
      404,
    );
    // Re-enable with a STALE signature → 409, still unavailable.
    const stale = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          revision: catalog.policy.revision,
          signature: catalog.policy.signature,
        }),
      },
    );
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, "plugin_policy_conflict");
    assertEquals(
      (await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`)).status,
      404,
    );
    // Fresh signature: available again, no duplicate registrations.
    const freshCatalog =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const enable = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          revision: freshCatalog.policy.revision,
          signature: freshCatalog.policy.signature,
        }),
      },
    );
    assertEquals(enable.status, 200);
    await enable.body?.cancel();
    await waitUntil(async (signal) => {
      const res = await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`, {
        signal,
      });
      await res.body?.cancel();
      return res.status === 200 ? done() : waitPending({ status: res.status });
    }, {
      label: "plugin endpoint back after re-enable",
      intervalMs: 100,
      children: [server],
    });
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("plugin api: body bound returns 413 before plugin code runs", async () => {
  const { fixture, server } = await pluginApiServer();
  try {
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    const res = await fetch(`${server.baseUrl}/_/api/plugins/ep`, {
      method: "POST",
      body: big,
    });
    assertEquals(res.status, 413);
    await res.body?.cancel();
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("plugin api: host catalog, settings round-trip, commands and blocking badges", async () => {
  const { fixture, server, admin } = await pluginApiServer();
  try {
    const catalog =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const ep = catalog.plugins.find((p: { id: string }) => p.id === "ep");
    assertEquals(ep.status, "ready");
    assertEquals(ep.commands.map((c: { fullId: string }) => c.fullId), [
      "plugin:ep:echo",
    ]);
    assertEquals(ep.blocking, { active: false, actions: [] });
    // Private data never appears in the catalog payload.
    assert(!JSON.stringify(catalog).includes("data.json"));

    // Settings: defaults → commit → persistence revision increments.
    const before = await (await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/settings/preferences`,
    )).json();
    assertEquals(before.values.message, "fixture");
    assertEquals(before.revision, 0);
    const saved = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/settings/preferences`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { message: "operator", protect: true, limit: 8 },
          revision: 0,
        }),
      },
    );
    assertEquals(saved.status, 200);
    const savedBody = await saved.json();
    assertEquals(savedBody.revision, 1);
    assertEquals(savedBody.values.message, "operator");
    // Stale revision → 409; invalid value → 422.
    const stale = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/settings/preferences`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { message: "x" }, revision: 0 }),
      },
    );
    assertEquals(stale.status, 409);
    await stale.body?.cancel();
    const invalid = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/settings/preferences`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { message: "x", limit: 99 },
          revision: 1,
        }),
      },
    );
    assertEquals(invalid.status, 422);
    await invalid.body?.cancel();

    // Command invocation returns the actual result.
    const command = await fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/commands/echo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      },
    );
    assertEquals(command.status, 200);
    assertEquals(await command.json(), {
      result: { echoed: { hello: "world" } },
    });
    for (
      const [body, expected] of [
        [undefined, [200, { result: { echoed: {} } }]],
        ["{", [400, { detail: "Invalid JSON request body." }]],
      ] as const
    ) {
      const reply = await fetch(
        `${server.baseUrl}/_/api/plugin-host/ep/commands/echo`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      assertEquals<unknown>([reply.status, await reply.json()], expected);
    }
    assertEquals(
      (await fetch(`${server.baseUrl}/_/api/plugin-host/ep/commands/ghost`, {
        method: "POST",
        body: "{}",
      })).status,
      404,
    );

    // A pre-hook plugin carries the framework blocking badge.
    await fixture.install("blocker", {
      runtime: { server: "service.js" },
      hooks: ["pre-delete"],
    }, {
      "service.js":
        "export function activate(ctx) { ctx.hooks.on('pre-delete', () => {}); }",
    });
    // Rediscovery happens on the next catalog read after reconcile; force one.
    const pol = await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
      .json();
    const toggle = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          revision: pol.policy.revision,
          signature: pol.policy.signature,
        }),
      },
    );
    assertEquals(toggle.status, 200);
    await toggle.body?.cancel();
    const catalog2 =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const blocker = catalog2.plugins.find((p: { id: string }) =>
      p.id === "blocker"
    );
    assertEquals(blocker.blocking.actions, ["delete"]);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("plugin api: invalidation stream delivers changes and closes on policy epoch change", async () => {
  const { fixture, server, admin } = await pluginApiServer();
  const controller = new AbortController();
  try {
    const res = await fetch(`${server.baseUrl}/_/api/plugin-host/events`, {
      signal: controller.signal,
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = (name: string) =>
      waitUntil<string | null>(async () => {
        const marker = `event: ${name}\n`;
        const index = buffer.indexOf(marker);
        if (index >= 0) {
          const end = buffer.indexOf("\n\n", index);
          if (end >= 0) {
            const chunk = buffer.slice(index, end + 2);
            buffer = buffer.slice(end + 2);
            return done(chunk);
          }
        }
        const { value, done: ended } = await reader.read().catch((error) => {
          if (name !== "close" || !(error instanceof TypeError)) throw error;
          return { done: true as const, value: undefined };
        });
        if (ended) return done(null);
        buffer += decoder.decode(value, { stream: true });
        return waitPending({ awaited: name, buffered: buffer.slice(-2000) });
      }, { label: `event stream frame '${name}'`, intervalMs: 0 });
    assert(await nextEvent("hello") !== null, "no hello frame");

    // A catalog change produces an invalidation frame.
    const catalog =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const toggle = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: false,
          revision: catalog.policy.revision,
          signature: catalog.policy.signature,
        }),
      },
    );
    assertEquals(toggle.status, 200);
    await toggle.body?.cancel();
    assert(await nextEvent("invalidate") !== null, "no invalidate frame");

    const access = await admin.fetch(`${server.baseUrl}/_/api/access`).then((
      r,
    ) => r.json());
    const reset = await admin.fetch(`${server.baseUrl}/_/api/access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        everybody: "none",
        grants: access.grants,
        updateId: createUuid(),
        revision: access.revision,
        signature: access.signature,
      }),
    });
    assertEquals(reset.status, 200);
    await reset.body?.cancel();
    // The retired lease cannot disclose even its terminal frame.
    const closed = await bounded(
      nextEvent("close").catch((error) => {
        if (!(error instanceof TypeError)) throw error;
        return null;
      }),
      "ACL retires plugin stream",
    );
    assertEquals(closed, null);
    const refused = await fetch(`${server.baseUrl}/_/api/plugin-host/events`);
    assertEquals(refused.status, 403);
    await refused.body?.cancel();
  } finally {
    controller.abort();
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("plugin api: vault policy endpoint materializes inventory and honors pins", async () => {
  const { fixture, server, admin } = await pluginApiServer();
  try {
    const catalog =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const res = await admin.fetch(
      `${server.baseUrl}/_/api/plugin-host/policy`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoEnable: false,
          revision: catalog.policy.revision,
          signature: catalog.policy.signature,
        }),
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.policy.effectiveAutoEnable, false);
    assertEquals(body.policy.autoEnableSource, "vault");
    // The pre-existing plugin stayed enabled (materialized explicit opt-in).
    const after =
      await (await admin.fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    assertEquals(
      after.plugins.find((p: { id: string }) => p.id === "ep").enabled,
      true,
    );
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

for (const retire of [false, true]) {
  Deno.test(`plugin api: real stream lease ${retire ? "retires queued emissions" : "serializes and coalesces one turn"}`, () =>
    accountRouteFixture(
      async ({ alice, identity, lifecycle, demoteAdmin, scope }) => {
        const { access_token } = await alice();
        let listeners = 0;
        const idle = fixtureGate(scope);
        const feed = createIdentityPluginEvents(async (raw) => {
          const access = await identity.composition.streamAccess(raw);
          return {
            ...access,
            subscribe(listener) {
              const remove = access.subscribe(listener);
              listeners++;
              return () => {
                listeners--;
                remove();
                idle.resolve();
              };
            },
          };
        });
        const reader = (await feed(
          {
            _raw: new Request("http://fixture/_/api/plugin-host/events", {
              headers: { authorization: `Bearer ${access_token}` },
            }),
          } as PathfinderRequest,
        )).body!.getReader();
        const readEvent = async () =>
          new TextDecoder().decode(
            (await bounded(reader.read(), "plugin event")).value,
          ).split("\n")[0];
        try {
          assertEquals(await readEvent(), "event: hello");
          assertEquals(listeners, 1);
          for (let i = 0; i < 50; i++) lifecycle.notifyInvalidation("catalog");
          if (retire) {
            demoteAdmin();
            const read = await reader.read().then(
              (chunk) => [chunk.done, chunk.value],
              () => [true, undefined],
            );
            assertEquals(read, [true, undefined]);
          } else {
            const invalidate = await bounded(
              reader.read(),
              "coalesced catalog event",
            );
            assert(
              new TextDecoder().decode(invalidate.value).includes(
                '"domain":"catalog"',
              ),
            );
            lifecycle.notifyInvalidation("settings");
            const next = await bounded(
              reader.read(),
              "separate settings event",
            );
            assert(
              new TextDecoder().decode(next.value).includes(
                '"domain":"settings"',
              ),
            );
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        await bounded(idle.promise, "plugin stream unsubscribes");
        assertEquals(listeners, 0);
        lifecycle.notifyInvalidation("catalog");
        assertEquals(listeners, 0);
      },
    ));
}
