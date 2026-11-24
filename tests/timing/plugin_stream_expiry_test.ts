// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Timing-budget tests (serial): a plugin-host event stream opened with a
 * short-lived token closes at the token's expiry, within 500 ms and long
 * before the 15 s heartbeat, and an expired credential receives no
 * invalidation frame. Moved unchanged from tests/plugin_api_test.ts: the
 * close deadline is the asserted property (plans/mcp-v3 S1, answer 1).
 */

import { assert, assertEquals } from "@std/assert";
import { signedInScenario } from "../helpers/fixture_scenarios.ts";
import { bootServer } from "../helpers/boot.ts";
import { ENDPOINT_PLUGIN } from "../helpers/endpoint_plugin.ts";
import { pluginFixture } from "../helpers/plugin_fixture.ts";
import { catalogPluginReady } from "../helpers/plugin_ready.ts";
import { signInFixtureWithExpiry } from "../helpers/identity_fixture.ts";
import { done, fixtureWallNow, pending, waitUntil } from "../helpers/wait.ts";
import { bounded } from "../helpers/worker_liveness.ts";

for (const invalidate of [false, true]) {
  Deno.test(`plugin api: signed expiry ${invalidate ? "rejects invalidation frames" : "closes the stream"} before heartbeat`, async () => {
    const fixture = await pluginFixture();
    await fixture.install(
      "ep",
      ENDPOINT_PLUGIN.manifest,
      ENDPOINT_PLUGIN.files,
    );
    const person = { login: "stream-fixture", password: "fixture-password" };
    const server = await bootServer({
      GLOBNOTES_GLOBNOTES_PATH: fixture.vault,
      GLOBNOTES__METADATA_PATH: fixture.metadataBase,
      fixtureScenario: signedInScenario(person),
      GLOBNOTES__SERVER_PATHPREFIX: "",
    });
    const controller = new AbortController();
    let drained: Promise<void> | undefined;
    try {
      const root = `${fixture.metadataBase}/_`;
      const login = (expirySeconds: number) =>
        signInFixtureWithExpiry(
          root,
          { username: person.login, password: person.password },
          expirySeconds,
        );
      const durable = await login(120);
      const headers = { authorization: `Bearer ${durable.access_token}` };
      await catalogPluginReady(server, "ep", { headers });
      const issued = await login(2);
      const { expiresAt } = issued.principal, short = issued.access_token;
      const res = await fetch(`${server.baseUrl}/_/api/plugin-host/events`, {
        headers: { authorization: `Bearer ${short}` },
        signal: controller.signal,
      });
      assertEquals(res.status, 200);
      const reader = res.body!.getReader(), decoder = new TextDecoder();
      let text = "", closedAt: number | undefined;
      drained = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch (error) {
          // At expiry the delivery guard can terminate the HTTP body rather
          // than send an SSE event. Before expiry any transport error is real.
          if (!controller.signal.aborted && fixtureWallNow() < expiresAt) {
            throw error;
          }
        } finally {
          closedAt = fixtureWallNow();
        }
      })();
      if (invalidate) {
        await waitUntil(() => {
          const now = fixtureWallNow();
          return now >= expiresAt + 25 ? done() : pending({ now, expiresAt });
        }, {
          label: "signed token expired before invalidation",
          children: [server],
        });
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
      await bounded(
        drained,
        "signed stream closes at expiry",
        Math.max(0, expiresAt + 500 - fixtureWallNow()),
      );
      assert(
        !text.includes("event: invalidate") &&
          !text.includes("event: heartbeat"),
        `Expired credential received invalidation: ${text}`,
      );
      assert(
        closedAt !== undefined && closedAt >= expiresAt &&
          closedAt <= expiresAt + 500 && text.includes("event: hello"),
        `Signed stream closed at ${closedAt} for expiry ${expiresAt}: ${text}`,
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
