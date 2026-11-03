// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Timing-budget tests (serial): a plugin-host event stream opened with a
 * short-lived token closes at the token's expiry, within 500 ms and long
 * before the 15 s heartbeat, and an expired credential receives no
 * invalidation frame. Moved unchanged from tests/plugin_api_test.ts: the
 * close deadline is the asserted property (plans/mcp-v3 S1, answer 1).
 */

import { assert, assertEquals } from "@std/assert";
import { SignJWT } from "jose";
import { bootServer } from "../helpers/boot.ts";
import { ENDPOINT_PLUGIN } from "../helpers/endpoint_plugin.ts";
import { pluginFixture } from "../helpers/plugin_fixture.ts";
import { catalogPluginReady } from "../helpers/plugin_ready.ts";

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
      await catalogPluginReady(server, "ep", { headers });
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
