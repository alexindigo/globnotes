// SPDX-License-Identifier: LGPL-3.0-only

/** Sandbox endpoint + host control API tests over real HTTP: plugin code
 * executes only in its worker, envelopes stay structured, 404/405/Allow
 * semantics hold, enablement gates availability, and the control API
 * persists against revision/signature checks. */

import { assert, assertEquals } from "@std/assert";
import { SignJWT } from "jose";
import { bootServer } from "./helpers/boot.ts";
import { fixturePage, pluginFixture } from "./helpers/plugin_fixture.ts";
import eventsHandler from "../server/api/endpoints/_/api/plugin-host/events/get.ts";
import { state } from "../server/state.ts";
import { AuthType } from "../server/config.ts";
import type { PathfinderRequest } from "@pathfinder/pathfinder";

const ENDPOINT_PLUGIN = {
  manifest: {
    runtime: { server: "service.js" },
    hooks: ["on-save"],
    settings: [fixturePage],
  },
  files: {
    "service.js": `export function activate(ctx) {
      ctx.hooks.on('on-save', () => {});
      ctx.commands.register({ id: 'echo', label: 'Echo', target: 'server' }, (payload) => ({ echoed: payload }));
    }`,
    "endpoints/get.js":
      `export default (req) => ({ route: 'root', query: req.query, headers: req.headers });`,
    "endpoints/post.js":
      `export default async (req) => ({ route: 'root-post', bytes: req.body.length });`,
    "endpoints/item/#name/get.js":
      `export default (req) => ({ route: 'item', name: req.params.name, query: req.query });`,
    "endpoints/echo/post.js": `export default (req) => ({
      status: 201,
      headers: [['x-plugin', 'yes'], ['set-cookie', 'nope=1']],
      body: new TextDecoder().decode(req.body),
    });`,
    "endpoints/tree/#...route/get.js":
      `export default (req) => ({ route: 'tree', rest: req.params.route });`,
  },
};

async function pluginApiServer(opts: Record<string, string> = {}) {
  const fixture = await pluginFixture();
  await fixture.install("ep", ENDPOINT_PLUGIN.manifest, ENDPOINT_PLUGIN.files);
  const server = await bootServer({
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: "none",
    GLOBNOTES_PATH_PREFIX: "",
    ...opts,
  });
  // Wait until the service runtime reports ready through the catalog.
  const deadline = Date.now() + 8000;
  for (;;) {
    const res = await fetch(`${server.baseUrl}/_/api/plugin-host`);
    const catalog = await res.json();
    const ep = catalog.plugins.find((p: { id: string }) => p.id === "ep");
    if (ep?.status === "ready") return { fixture, server, catalog };
    if (Date.now() > deadline) throw new Error("plugin never became ready");
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test("plugin api: root/rest routes, decoded params, query data and actual results", async () => {
  const { fixture, server } = await pluginApiServer();
  try {
    const root = await fetch(`${server.baseUrl}/_/api/plugins/ep`);
    assertEquals(root.status, 200);
    const rootBody = await root.json();
    assertEquals(rootBody.route, "root");
    // Credentials never cross the boundary.
    const withCreds = await fetch(`${server.baseUrl}/_/api/plugins/ep`, {
      headers: { cookie: "token=secret", authorization: "Bearer abc" },
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
  const { fixture, server } = await pluginApiServer();
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
    const catalog = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
      .json();
    const disable = await fetch(
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
    const stale = await fetch(
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
      await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
        .json();
    const enable = await fetch(
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
    const deadline = Date.now() + 5000;
    let ok = false;
    while (Date.now() < deadline) {
      const res = await fetch(`${server.baseUrl}/_/api/plugins/ep/item/x`);
      if (res.status === 200) {
        ok = true;
        await res.body?.cancel();
        break;
      }
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(ok, "plugin endpoint never came back after re-enable");
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
  const { fixture, server } = await pluginApiServer();
  try {
    const catalog = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
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
    const before = await (await fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/settings/preferences`,
    )).json();
    assertEquals(before.values.message, "fixture");
    assertEquals(before.revision, 0);
    const saved = await fetch(
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
    const stale = await fetch(
      `${server.baseUrl}/_/api/plugin-host/ep/settings/preferences`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { message: "x" }, revision: 0 }),
      },
    );
    assertEquals(stale.status, 409);
    await stale.body?.cancel();
    const invalid = await fetch(
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
    const pol = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
      .json();
    const toggle = await fetch(
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
    const catalog2 = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
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
  // Not env-pinned: setup completes through the wizard flow so reset is a
  // real access-policy transition.
  const fixture = await pluginFixture();
  await fixture.install("ep", ENDPOINT_PLUGIN.manifest, ENDPOINT_PLUGIN.files);
  const server = await bootServer({
    GLOBNOTES_PATH: fixture.vault,
    GLOBNOTES_INDEX_PATH: fixture.statePath,
    GLOBNOTES_AUTH_TYPE: "",
    GLOBNOTES_PATH_PREFIX: "",
  });
  try {
    const setup = await fetch(`${server.baseUrl}/_/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "none" }),
    });
    assertEquals(setup.status, 200);
    await setup.body?.cancel();
    // Wait for the service runtime after setup-completion reconciliation.
    const readyDeadline = Date.now() + 8000;
    for (;;) {
      const res = await fetch(`${server.baseUrl}/_/api/plugin-host`);
      const catalog = await res.json();
      const ep = catalog.plugins.find((p: { id: string }) => p.id === "ep");
      if (ep?.status === "ready") break;
      if (Date.now() > readyDeadline) throw new Error("plugin never ready");
      await new Promise((r) => setTimeout(r, 100));
    }
    const controller = new AbortController();
    const res = await fetch(`${server.baseUrl}/_/api/plugin-host/events`, {
      signal: controller.signal,
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = async (name: string, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const marker = `event: ${name}\n`;
        const index = buffer.indexOf(marker);
        if (index >= 0) {
          const end = buffer.indexOf("\n\n", index);
          if (end >= 0) {
            const chunk = buffer.slice(index, end + 2);
            buffer = buffer.slice(end + 2);
            return chunk;
          }
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
      return null;
    };
    assert(await nextEvent("hello") !== null, "no hello frame");

    // A catalog change produces an invalidation frame.
    const catalog = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
      .json();
    const toggle = await fetch(
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

    // An in-place mode transition closes the stream without reopening setup.
    const access = await fetch(`${server.baseUrl}/_/api/access`).then((r) =>
      r.json()
    );
    const reset = await fetch(`${server.baseUrl}/_/api/access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "read_only",
        revision: access.revision,
        signature: access.signature,
      }),
    });
    assertEquals(reset.status, 200);
    await reset.body?.cancel();
    const closed = await nextEvent("close");
    assert(
      closed !== null && closed.includes("policy-change"),
      `stream did not close: ${closed}`,
    );
    controller.abort();
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

Deno.test("plugin api: vault policy endpoint materializes inventory and honors pins", async () => {
  const { fixture, server } = await pluginApiServer();
  try {
    const catalog = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
      .json();
    const res = await fetch(`${server.baseUrl}/_/api/plugin-host/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autoEnable: false,
        revision: catalog.policy.revision,
        signature: catalog.policy.signature,
      }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.policy.effectiveAutoEnable, false);
    assertEquals(body.policy.autoEnableSource, "vault");
    // The pre-existing plugin stayed enabled (materialized explicit opt-in).
    const after = await (await fetch(`${server.baseUrl}/_/api/plugin-host`))
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

for (const invalidate of [false, true]) {
  Deno.test(`plugin api: signed expiry ${invalidate ? "rejects invalidation frames" : "closes the stream"} before heartbeat`, async () => {
    const fixture = await pluginFixture();
    await fixture.install(
      "ep",
      ENDPOINT_PLUGIN.manifest,
      ENDPOINT_PLUGIN.files,
    );
    const secret = "stream-expiry-fixture-secret";
    const token = (expiry?: number) => {
      const jwt = new SignJWT({ sub: "stream-fixture" }).setProtectedHeader({
        alg: "HS256",
      });
      return (expiry === undefined ? jwt : jwt.setExpirationTime(expiry)).sign(
        new TextEncoder().encode(secret),
      );
    };
    const durable = await token(Math.floor(Date.now() / 1000) + 120);
    const headers = { authorization: `Bearer ${durable}` };
    const server = await bootServer({
      GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES_INDEX_PATH: fixture.statePath,
      GLOBNOTES_AUTH_TYPE: "password",
      GLOBNOTES_USERNAME: "stream-fixture",
      GLOBNOTES_PASSWORD: "fixture-password",
      GLOBNOTES_SECRET_KEY: secret,
      GLOBNOTES_PATH_PREFIX: "",
    });
    const controller = new AbortController();
    let drained: Promise<void> | undefined;
    try {
      const readyDeadline = Date.now() + 8000;
      for (;;) {
        const res = await fetch(`${server.baseUrl}/_/api/plugin-host`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        const catalog = await res.json();
        if (
          catalog.plugins.find((p: { id: string }) => p.id === "ep")?.status ===
            "ready"
        ) break;
        if (Date.now() > readyDeadline) {
          throw Error("Expiry fixture did not become ready");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const expiry = Math.floor(Date.now() / 1000) + 2;
      const short = await token(expiry);
      const res = await fetch(`${server.baseUrl}/_/api/plugin-host/events`, {
        headers: { authorization: `Bearer ${short}` },
        signal: controller.signal,
      });
      assertEquals(res.status, 200);
      const reader = res.body!.getReader(), decoder = new TextDecoder();
      let text = "";
      drained = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      })();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now() + 25))
      );
      if (invalidate) {
        const catalog =
          await (await fetch(`${server.baseUrl}/_/api/plugin-host`, {
            headers,
          })).json();
        const update = await fetch(
          `${server.baseUrl}/_/api/plugin-host/policy`,
          {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              autoEnable: false,
              revision: catalog.policy.revision,
              signature: catalog.policy.signature,
            }),
          },
        );
        assertEquals(update.status, 200);
        await update.body?.cancel();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        drained.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 500);
        }),
      ]);
      clearTimeout(timer);
      assert(
        !text.includes("event: invalidate"),
        `Expired credential received invalidation: ${text}`,
      );
      assert(
        closed && text.includes("event: close"),
        `Signed token expiry did not close before heartbeat: ${text}`,
      );
      const rejected = await fetch(
        `${server.baseUrl}/_/api/plugin-host/events`,
        {
          headers: { authorization: `Bearer ${short}` },
          signal: AbortSignal.timeout(3000),
        },
      );
      assertEquals(rejected.status, 401);
      await rejected.body?.cancel();
    } finally {
      controller.abort();
      await drained;
      await server.close();
      await fixture.dispose();
    }
  });
}

for (const retireWhileValidating of [false, true]) {
  Deno.test(`plugin api: stream timing ${retireWhileValidating ? "retires pending emissions" : "serializes and coalesces invalidations"}`, async () => {
    // This controlled validator proves emission timing/cleanup only; the
    // preceding HTTP cases independently exercise real signed JWT authority.
    const old = {
      config: state.config,
      auth: state.auth,
      lifecycle: state.lifecycle,
    };
    const listeners = new Set<() => void>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0, active = 0, maxActive = 0;
    const lifecycle = {
      epoch: 1,
      subscribeInvalidation: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    state.config = {
      setupRequired: false,
      authType: AuthType.PASSWORD,
    } as typeof state.config;
    state.lifecycle = lifecycle as unknown as NonNullable<
      typeof state.lifecycle
    >;
    state.auth = {
      validateTokenMetadata: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls === 2) await gate;
          return { expiresAt: null };
        } finally {
          active--;
        }
      },
    } as unknown as NonNullable<typeof state.auth>;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await eventsHandler({
        _raw: new Request("http://fixture/_/api/plugin-host/events", {
          headers: { authorization: "Bearer controlled-timing" },
        }),
      } as PathfinderRequest);
      reader = response.body!.getReader();
      const first = reader.read();
      for (let i = 0; i < 50; i++) {
        for (const listener of listeners) listener();
      }
      if (retireWhileValidating) {
        lifecycle.epoch++;
        for (const listener of [...listeners]) listener();
      }
      release();
      const text = new TextDecoder().decode((await first).value);
      if (retireWhileValidating) {
        assert(text.includes("event: close") && text.includes("policy-change"));
        assertEquals((await reader.read()).done, true);
      } else {
        assert(text.includes("event: hello"));
        assert(
          new TextDecoder().decode((await reader.read()).value).includes(
            "event: invalidate",
          ),
        );
        assertEquals(calls, 3);
        assertEquals(maxActive, 1);
      }
      await reader.cancel();
      assertEquals(listeners.size, 0);
      const settled = calls;
      await Promise.resolve();
      assertEquals(calls, settled);
    } finally {
      release();
      await reader?.cancel();
      state.config = old.config;
      state.auth = old.auth;
      state.lifecycle = old.lifecycle;
    }
  });
}
